import { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolCall, reasoningBudget } from '../types';
import { adaptiveEffort } from '../adaptive';
import { formatHttpError, joinUrl, sseLines } from '../sse';
import { parseJsonLoose } from '../../util/json';
import { randomId } from '../../util/id';
import { sanitizeSurrogates } from '../../util/text';
import { HttpError, isBetaHeaderRejection } from '../errors';
import { FetchTimeouts, fetchWithTimeouts, resolveTimeouts } from '../timeout';

const ANTHROPIC_BETA_FEATURES = [
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
];

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl: string;
  timeouts?: Partial<FetchTimeouts>;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';

  constructor(private readonly config: AnthropicProviderConfig) {}

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const maxTokens = options.maxTokens ?? 8192;
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: maxTokens,
      stream: true,
      messages: toAnthropicMessages(messages, options.cache !== false),
    };
    if (system) {
      body.system =
        options.cache === false
          ? system
          : [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }
    if (options.tools?.length) {
      body.tools = options.tools.map((tool, index) => {
        const entry: Record<string, unknown> = {
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        };
        if (options.cache !== false && index === options.tools!.length - 1) {
          entry.cache_control = { type: 'ephemeral' };
        }
        return entry;
      });
    }
    if (options.temperature !== undefined && !/claude/i.test(options.model)) {
      body.temperature = options.temperature;
    }
    if (options.reasoning?.enabled) {
      if (options.reasoning.kind === 'anthropic-adaptive' && adaptiveEffort(options.reasoning.effort)) {
        body.thinking = { type: 'adaptive', display: 'summarized' };
        if (options.reasoning.effort) {
          body.effort = options.reasoning.effort;
        }
      } else {
        const budget = Math.min(
          options.reasoning.budgetTokens ?? reasoningBudget(options.reasoning.effort),
          Math.max(1024, maxTokens - 1024),
        );
        body.thinking = { type: 'enabled', budget_tokens: budget };
      }
    }

    const beta = body.thinking !== undefined ? betaHeaderValue(undefined, ANTHROPIC_BETA_FEATURES) : undefined;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      };
      if (attempt === 0 && beta) {
        headers['anthropic-beta'] = beta;
      }

      const response = await fetchWithTimeouts(
        joinUrl(this.config.baseUrl, 'v1/messages'),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        { ...resolveTimeouts(this.config.timeouts), signal: options.signal },
      );

      if (!response.ok || !response.body) {
        const error = new HttpError(response.status, `LLM request failed (${await formatHttpError(response)})`);
        if (attempt === 0 && beta && isBetaHeaderRejection(error)) {
          if (process.env.DEV_FIRST_DEBUG) {
            console.debug(`[dev-first] Retrying without the Anthropic beta header: ${error.message}`);
          }
          continue;
        }
        throw error;
      }

      const toolBlocks = new Map<number, ToolCall>();

      for await (const line of sseLines(response)) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const json = parseJsonLoose(line.slice(5).trim()) as any;
        if (!json) {
          continue;
        }
        switch (json.type) {
          case 'message_start': {
            const usage = json.message?.usage;
            if (usage && typeof usage === 'object') {
              const event: Extract<StreamEvent, { type: 'usage' }> = { type: 'usage' };
              const input = numberOrUndefined(usage.input_tokens);
              const cached =
                (numberOrUndefined(usage.cache_read_input_tokens) ?? 0) +
                (numberOrUndefined(usage.cache_creation_input_tokens) ?? 0);
              if (input !== undefined) {
                event.inputTokens = input;
              }
              if (cached > 0) {
                event.cachedTokens = cached;
              }
              if (event.inputTokens !== undefined || event.cachedTokens !== undefined) {
                yield event;
              }
            }
            break;
          }
          case 'message_delta': {
            const output = numberOrUndefined(json.usage?.output_tokens);
            if (output !== undefined) {
              yield { type: 'usage', outputTokens: output };
            }
            break;
          }
          case 'content_block_start': {
            const block = json.content_block;
            if (block?.type === 'tool_use') {
              toolBlocks.set(json.index ?? 0, {
                id: block.id ?? randomId('call'),
                name: block.name ?? '',
                arguments: '',
              });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = json.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
              yield { type: 'text', text: delta.text };
            }
            if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              yield { type: 'reasoning', text: delta.thinking };
            }
            if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const acc = toolBlocks.get(json.index ?? 0);
              if (acc) {
                acc.arguments += delta.partial_json;
              }
            }
            break;
          }
          case 'content_block_stop': {
            const index = json.index ?? 0;
            const acc = toolBlocks.get(index);
            if (acc) {
              yield { type: 'toolCall', toolCall: { ...acc, arguments: acc.arguments || '{}' } };
              toolBlocks.delete(index);
            }
            break;
          }
          case 'error': {
            throw new Error(json.error?.message ?? 'Anthropic stream error');
          }
          default:
            break;
        }
      }
      yield { type: 'done' };
      return;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await fetchWithTimeouts(
      joinUrl(this.config.baseUrl, 'v1/models'),
      {
        headers: {
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
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
    return json.data.map((model: any) => String(model.id)).filter(Boolean);
  }

  async embed(): Promise<number[][]> {
    throw new Error(
      'Anthropic does not provide an embeddings API. Use an OpenAI-compatible or Gemini provider for semantic search.',
    );
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function betaHeaderValue(existing: string | undefined, features: string[]): string {
  const values = (existing ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const feature of features) {
    if (!values.includes(feature)) {
      values.push(feature);
    }
  }
  return values.join(',');
}

function toAnthropicMessages(messages: ChatMessage[], cache: boolean): unknown[] {
  const out: any[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    const text = sanitizeSurrogates(message.content);
    if (message.role === 'tool') {
      if (!text) {
        continue;
      }
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: text,
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const content: any[] = [];
      if (text) {
        content.push({ type: 'text', text });
      }
      for (const call of message.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      if (content.length > 0) {
        out.push({ role: 'assistant', content });
      }
      continue;
    }
    if (message.role === 'user' && message.images?.length) {
      const content: any[] = [];
      for (const dataUrl of message.images) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          content.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } });
        }
      }
      if (text) {
        content.push({ type: 'text', text });
      }
      if (content.length > 0) {
        out.push({ role: 'user', content });
      }
      continue;
    }
    if (!text) {
      continue;
    }
    out.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: text,
    });
  }
  if (cache) {
    applyMessageCacheBreakpoints(out);
  }
  return out;
}

function applyMessageCacheBreakpoints(messages: any[]): void {
  for (let i = Math.max(0, messages.length - 2); i < messages.length; i++) {
    const message = messages[i];
    if (typeof message.content === 'string') {
      if (!message.content) {
        continue;
      }
      message.content = [
        { type: 'text', text: message.content, cache_control: { type: 'ephemeral' } },
      ];
      continue;
    }
    if (Array.isArray(message.content) && message.content.length > 0) {
      const last = message.content[message.content.length - 1];
      if (!last.cache_control) {
        last.cache_control = { type: 'ephemeral' };
      }
    }
  }
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}
