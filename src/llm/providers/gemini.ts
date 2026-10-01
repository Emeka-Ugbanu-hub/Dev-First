import { ChatMessage, ChatOptions, LLMProvider, StreamEvent, reasoningBudget } from '../types';
import { adaptiveEffort } from '../adaptive';
import { formatHttpError, sseLines } from '../sse';
import { parseJsonLoose } from '../../util/json';
import { sanitizeSurrogates } from '../../util/text';
import { HttpError } from '../errors';
import { FetchTimeouts, fetchWithTimeouts, resolveTimeouts } from '../timeout';

export interface GeminiProviderConfig {
  apiKey: string;
  baseUrl: string;
  timeouts?: Partial<FetchTimeouts>;
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini';

  constructor(private readonly config: GeminiProviderConfig) {}

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const body: Record<string, unknown> = {
      contents: toGeminiContents(messages),
    };
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }
    if (options.tools?.length) {
      body.tools = [
        {
          functionDeclarations: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toGeminiSchema(tool.parameters),
          })),
        },
      ];
    }
    const generationConfig: Record<string, unknown> = {};
    if (options.temperature !== undefined) {
      generationConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = options.maxTokens;
    }
    if (options.reasoning?.enabled) {
      const dynamic = options.reasoning.kind === 'gemini-dynamic' && adaptiveEffort(options.reasoning.effort);
      generationConfig.thinkingConfig = {
        thinkingBudget: dynamic
          ? -1
          : options.reasoning.budgetTokens ?? reasoningBudget(options.reasoning.effort),
        includeThoughts: true,
      };
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const base = this.config.baseUrl.replace(/\/+$/, '');
    const url = `${base}/v1beta/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`;

    const response = await fetchWithTimeouts(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.config.apiKey,
        },
        body: JSON.stringify(body),
      },
      { ...resolveTimeouts(this.config.timeouts), signal: options.signal },
    );

    if (!response.ok || !response.body) {
      throw new HttpError(response.status, `LLM request failed (${await formatHttpError(response)})`);
    }

    let callIndex = 0;
    for await (const line of sseLines(response)) {
      if (!line.startsWith('data:')) {
        continue;
      }
      const json = parseJsonLoose(line.slice(5).trim()) as any;
      const usage = json?.usageMetadata;
      if (usage && typeof usage === 'object') {
        const event: Extract<StreamEvent, { type: 'usage' }> = { type: 'usage' };
        const input = numberOrUndefined(usage.promptTokenCount);
        const output = numberOrUndefined(usage.candidatesTokenCount);
        const reasoning = numberOrUndefined(usage.thoughtsTokenCount);
        const cached = numberOrUndefined(usage.cachedContentTokenCount);
        if (input !== undefined) event.inputTokens = input;
        if (output !== undefined) event.outputTokens = output;
        if (reasoning !== undefined) event.reasoningTokens = reasoning;
        if (cached !== undefined) event.cachedTokens = cached;
        if (Object.keys(event).length > 1) {
          yield event;
        }
      }
      const parts = json?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) {
        continue;
      }
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (part.thought === true) {
            yield { type: 'reasoning', text: part.text };
          } else {
            yield { type: 'text', text: part.text };
          }
        }
        if (part.functionCall?.name) {
          yield {
            type: 'toolCall',
            toolCall: {
              id: `gemini_call_${++callIndex}`,
              name: String(part.functionCall.name),
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
          };
        }
      }
    }
    yield { type: 'done' };
  }

  async listModels(): Promise<string[]> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const response = await fetchWithTimeouts(
      `${base}/v1beta/models`,
      { headers: { 'x-goog-api-key': this.config.apiKey } },
      resolveTimeouts(this.config.timeouts),
    );
    if (!response.ok) {
      throw new HttpError(response.status, await formatHttpError(response));
    }
    const json = (await response.json()) as any;
    if (!Array.isArray(json?.models)) {
      return [];
    }
    return json.models
      .map((model: any) => String(model.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  async embed(texts: string[], model: string): Promise<number[][]> {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const response = await fetchWithTimeouts(
      `${base}/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.config.apiKey,
        },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        }),
      },
      resolveTimeouts(this.config.timeouts),
    );
    if (!response.ok) {
      throw new HttpError(response.status, await formatHttpError(response));
    }
    const json = (await response.json()) as any;
    if (!Array.isArray(json?.embeddings)) {
      return [];
    }
    return json.embeddings.map((entry: any) => entry.values as number[]);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toGeminiContents(messages: ChatMessage[]): unknown[] {
  const out: any[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'tool') {
      const part = {
        functionResponse: {
          name: message.toolName ?? 'unknown',
          response: { result: sanitizeSurrogates(message.content) },
        },
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user') {
        last.parts.push(part);
      } else {
        out.push({ role: 'user', parts: [part] });
      }
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts: any[] = [];
      const text = sanitizeSurrogates(message.content);
      if (text) {
        parts.push({ text });
      }
      for (const call of message.toolCalls) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name: call.name, args } });
      }
      out.push({ role: 'model', parts });
      continue;
    }
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: any[] = [{ text: sanitizeSurrogates(message.content) }];
    if (message.role === 'user' && message.images?.length) {
      for (const dataUrl of message.images) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          parts.push({ inlineData: { mimeType: parsed.mediaType, data: parsed.data } });
        }
      }
    }
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      out.push({ role, parts });
    }
  }
  return out;
}

function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

function toGeminiSchema(schema: any): any {
  if (Array.isArray(schema)) {
    return schema.map(toGeminiSchema);
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'additionalProperties') {
        continue;
      }
      if (key === 'type' && typeof value === 'string') {
        out[key] = value.toUpperCase();
        continue;
      }
      out[key] = toGeminiSchema(value);
    }
    return out;
  }
  return schema;
}
