export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  reasoning?: string;
}

export type ReasoningEffort = 'low' | 'medium' | 'high' | (string & {});

export type AdaptiveReasoningKind = 'anthropic-adaptive' | 'gemini-dynamic' | 'toggle';

export interface ReasoningOptions {
  enabled: boolean;
  effort?: ReasoningEffort;
  budgetTokens?: number;
  kind?: AdaptiveReasoningKind;
}

export interface ChatOptions {
  model: string;
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  reasoning?: ReasoningOptions;
  cache?: boolean;
}

export interface UsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; toolCall: ToolCall }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cachedTokens?: number;
    }
  | { type: 'done' };

export function reasoningBudget(effort: ReasoningEffort | undefined, fallback = 4096): number {
  switch (effort) {
    case 'low':
      return 2048;
    case 'high':
      return 12288;
    case 'medium':
    default:
      return fallback;
  }
}

export interface LLMProvider {
  readonly id: string;
  chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent>;
  listModels(): Promise<string[]>;
  embed(texts: string[], model: string): Promise<number[][]>;
}
