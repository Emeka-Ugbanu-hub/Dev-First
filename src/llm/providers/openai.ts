import { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolCall } from '../types';

const REASONING_MODEL = /^(o\d|gpt-5)/i;
const DEEPSEEK_MODEL = /deepseek/i;
import { formatHttpError, joinUrl, sseLines } from '../sse';
import { parseJsonLoose } from '../../util/json';
import { randomId } from '../../util/id';
import { sanitizeSurrogates } from '../../util/text';
import { normalizeModelId } from '../modelRegistry';
import { hasInterleavedReasoning } from '../catalog';
import { HttpError, isReasoningRejection, isStreamOptionsRejection } from '../errors';
import { FetchTimeouts, fetchWithTimeouts, resolveTimeouts } from '../timeout';

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl: string;
  deepSeek?: boolean;
  ollama?: boolean;
  providerId?: string;
  timeouts?: Partial<FetchTimeouts>;
}

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';

  constructor(private readonly config: OpenAIProviderConfig) {}

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    if (this.config.ollama && options.reasoning) {
      yield* this.chatOllama(messages, options);
      return;
    }
    let reasoning = options.reasoning;
    let streamUsage = !this.config.deepSeek && !DEEPSEEK_MODEL.test(options.model);
    let reasoningRetry = Boolean(reasoning) && !this.config.deepSeek;
    let streamUsageRetry = streamUsage;

    for (;;) {
      const body = this.buildBody(messages, options, reasoning, streamUsage);

      const response = await fetchWithTimeouts(
        joinUrl(this.config.baseUrl, 'chat/completions'),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
        },
        { ...resolveTimeouts(this.config.timeouts), signal: options.signal },
      );

      if (!response.ok || !response.body) {
        const error = new HttpError(response.status, `LLM request failed (${await formatHttpError(response)})`);
        if (streamUsageRetry && isStreamOptionsRejection(error)) {
          streamUsageRetry = false;
          streamUsage = false;
          if (process.env.DEV_FIRST_DEBUG) {
            console.debug(`[dev-first] Retrying without stream_options: ${error.message}`);
          }
          continue;
        }
        if (reasoningRetry && isReasoningRejection(error)) {
          reasoningRetry = false;
          reasoning = undefined;
          if (process.env.DEV_FIRST_DEBUG) {
            console.debug(`[dev-first] Retrying without reasoning parameters: ${error.message}`);
          }
          continue;
        }
        throw error;
      }

      const toolCalls = new Map<number, ToolCall>();

      for await (const line of sseLines(response)) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') {
          continue;
        }
        const json = parseJsonLoose(data) as any;
        if (json?.usage && typeof json.usage === 'object') {
          const usageEvent = toUsageEvent(json.usage);
          if (usageEvent) {
            yield usageEvent;
          }
        }
        const delta = json?.choices?.[0]?.delta;
        if (!delta) {
          continue;
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text', text: delta.content };
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'reasoning', text: delta.reasoning_content };
        } else if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
          yield { type: 'reasoning', text: delta.reasoning };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) {
            const index = typeof part.index === 'number' ? part.index : 0;
            const acc = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (part.id) {
              acc.id = String(part.id);
            }
            if (part.function?.name && !acc.name) {
              acc.name = String(part.function.name);
            }
            if (part.function?.arguments) {
              acc.arguments += String(part.function.arguments);
            }
            toolCalls.set(index, acc);
          }
        }
      }

      for (const call of toolCalls.values()) {
        if (call.name) {
          yield {
            type: 'toolCall',
            toolCall: {
              id: call.id || randomId('call'),
              name: call.name,
              arguments: call.arguments || '{}',
            },
          };
        }
      }
      yield { type: 'done' };
      return;
    }
  }

  private buildBody(
    messages: ChatMessage[],
    options: ChatOptions,
    reasoning: ChatOptions['reasoning'],
    streamUsage: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: toOpenAIMessages(messages, this.replaysReasoning(options.model)),
      stream: true,
    };
    if (streamUsage) {
      body.stream_options = { include_usage: true };
    }
    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    if (options.temperature !== undefined && !isReasoningModel(options.model)) {
      body.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      if (isReasoningModel(options.model)) {
        body.max_completion_tokens = options.maxTokens;
      } else {
        body.max_tokens = options.maxTokens;
      }
    }
    if (reasoning && this.config.deepSeek) {
      body.thinking = { type: reasoning.enabled ? 'enabled' : 'disabled' };
      body.reasoning_effort = reasoning.enabled ? reasoning.effort ?? 'high' : 'none';
    } else if (reasoning?.enabled && reasoning.effort !== 'default' && reasoning.effort !== 'auto') {
      body.reasoning_effort = reasoning.effort ?? (isReasoningModel(options.model) ? 'medium' : undefined);
    }
    if (options.cache !== false) {
      const cacheKey = promptCacheKey(messages);
      if (cacheKey) {
        body.prompt_cache_key = cacheKey;
      }
    }
    return body;
  }

  private replaysReasoning(model: string): boolean {
    if (this.config.deepSeek || DEEPSEEK_MODEL.test(model)) {
      return true;
    }
    return this.config.providerId ? hasInterleavedReasoning(this.config.providerId, model) : false;
  }

  async listModels(): Promise<string[]> {
    const response = await fetchWithTimeouts(
      joinUrl(this.config.baseUrl, 'models'),
      { headers: { authorization: `Bearer ${this.config.apiKey}` } },
      resolveTimeouts(this.config.timeouts),
    );
    if (!response.ok) {
      throw new HttpError(response.status, await formatHttpError(response));
    }
    const json = (await response.json()) as any;
    if (!Array.isArray(json?.data)) {
      return [];
    }
    return json.data.map((model: any) => String(model.id)).filter(Boolean);
  }

  private async *chatOllama(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamEvent> {
    const reasoning = options.reasoning;
    if (!reasoning) return;
    const baseUrl = this.config.baseUrl.replace(/\/v1\/?$/i, '');
    const body: Record<string, unknown> = {
      model: options.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: sanitizeSurrogates(message.content),
        ...(message.images?.length ? { images: message.images.map(ollamaImageData) } : {}),
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map((call) => ({
            function: { name: call.name, arguments: parseJsonLoose(call.arguments) },
          })),
        } : {}),
        ...(message.toolName ? { tool_name: message.toolName } : {}),
      })),
      stream: true,
      think: reasoning.enabled
        ? reasoning.effort === 'off' ? false : reasoning.effort === 'on' ? true : reasoning.effort ?? true
        : false,
    };
    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    const modelOptions: Record<string, unknown> = {};
    if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
    if (options.maxTokens !== undefined) modelOptions.num_predict = options.maxTokens;
    if (Object.keys(modelOptions).length) body.options = modelOptions;

    const response = await fetchWithTimeouts(
      joinUrl(baseUrl, 'api/chat'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { ...resolveTimeouts(this.config.timeouts), signal: options.signal },
    );
    if (!response.ok || !response.body) {
      throw new HttpError(response.status, `Ollama request failed (${await formatHttpError(response)})`);
    }
    const toolCalls = new Map<number, ToolCall>();
    for await (const line of sseLines(response)) {
      const chunk = parseJsonLoose(line) as any;
      const message = chunk?.message;
      if (typeof message?.thinking === 'string' && message.thinking) {
        yield { type: 'reasoning', text: message.thinking };
      }
      if (typeof message?.content === 'string' && message.content) {
        yield { type: 'text', text: message.content };
      }
      if (Array.isArray(message?.tool_calls)) {
        for (const [index, call] of message.tool_calls.entries()) {
          const fn = call?.function;
          if (!fn?.name) continue;
          const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
          toolCalls.set(index, {
            id: randomId('call'),
            name: String(fn.name),
            arguments: args,
          });
        }
      }
    }
    for (const toolCall of toolCalls.values()) yield { type: 'toolCall', toolCall };
    yield { type: 'done' };
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const response = await fetchWithTimeouts(
      joinUrl(this.config.baseUrl, 'embeddings'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      },
      resolveTimeouts(this.config.timeouts),
    );
    if (!response.ok) {
      throw new HttpError(response.status, await formatHttpError(response));
    }
    const json = (await response.json()) as any;
    if (!Array.isArray(json?.data)) {
      return [];
    }
    return json.data.map((entry: any) => entry.embedding as number[]);
  }
}

function isReasoningModel(model: string): boolean {
  return REASONING_MODEL.test(model) || REASONING_MODEL.test(normalizeModelId(model));
}

function toUsageEvent(usage: any): StreamEvent | undefined {
  const event: Extract<StreamEvent, { type: 'usage' }> = { type: 'usage' };
  const input = numberOrUndefined(usage.prompt_tokens);
  const output = numberOrUndefined(usage.completion_tokens);
  const reasoning = numberOrUndefined(usage.completion_tokens_details?.reasoning_tokens);
  const cached = numberOrUndefined(usage.prompt_tokens_details?.cached_tokens);
  if (input !== undefined) event.inputTokens = input;
  if (output !== undefined) event.outputTokens = output;
  if (reasoning !== undefined) event.reasoningTokens = reasoning;
  if (cached !== undefined) event.cachedTokens = cached;
  return Object.keys(event).length > 1 ? event : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function ollamaImageData(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function promptCacheKey(messages: ChatMessage[]): string | undefined {
  const system = messages.find((message) => message.role === 'system');
  const firstUser = messages.find((message) => message.role === 'user');
  if (!system?.content) {
    return undefined;
  }
  const seed = `${system.content}\n${firstUser?.content ?? ''}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `dev-first-${(hash >>> 0).toString(36)}`;
}

function toOpenAIMessages(messages: ChatMessage[], replayReasoning: boolean): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    const content = sanitizeSurrogates(message.content);
    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: content || null,
        ...(replayReasoning ? { reasoning_content: sanitizeSurrogates(message.reasoning ?? '') } : {}),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      continue;
    }
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content,
      });
      continue;
    }
    if (message.role === 'user' && message.images?.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: content },
          ...message.images.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } })),
        ],
      });
      continue;
    }
    out.push({
      role: message.role,
      content,
      ...(replayReasoning && message.role === 'assistant'
        ? { reasoning_content: sanitizeSurrogates(message.reasoning ?? '') }
        : {}),
    });
  }
  return out;
}
