import { ChatMessage, LLMProvider } from '../llm/types';
import { chatWithRetry } from '../llm/retry';
import { COMPACTION_PROMPT } from '../planner/prompts';

export const PRESERVE_RECENT_TOKENS = 20_000;
export const COMPACTION_TRIGGER_RATIO = 0.6;
export const DEFAULT_CONTEXT_LIMIT = 128_000;
export const MIN_COMPRESS_MESSAGES = 6;
export const COMPRESSED_SECTION_PREFIX = '[Compressed conversation section]';

export interface CompressionBlock {
  id: string;
  startIndex: number;
  endIndex: number;
  summary: string;
  active: boolean;
}

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    chars += message.role.length + 8;
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        chars += call.name.length + call.arguments.length + 16;
      }
    }
  }
  return Math.ceil(chars / 4);
}

export function chooseRecentStart(messages: ChatMessage[], preserveTokens: number): number {
  if (messages.length <= 2) {
    return messages.length;
  }
  let tokens = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 2; index--) {
    const messageTokens = estimateTokens([messages[index]]);
    if (tokens + messageTokens > preserveTokens && start < messages.length) {
      break;
    }
    tokens += messageTokens;
    start = index;
  }
  while (start > 2 && messages[start].role === 'tool') {
    start--;
  }
  return Math.max(start, 2);
}

export function serializeForSummary(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const calls = message.toolCalls
        .map((call) => `${call.name}(${truncate(call.arguments, 400)})`)
        .join(', ');
      parts.push(`ASSISTANT: ${truncate(message.content ?? '', 1500)}\nTOOL CALLS: ${calls}`);
      continue;
    }
    if (message.role === 'tool') {
      parts.push(`TOOL RESULT (${message.toolName ?? 'tool'}): ${truncate(message.content, 900)}`);
      continue;
    }
    parts.push(`${message.role.toUpperCase()}: ${truncate(message.content, 2000)}`);
  }
  return truncate(parts.join('\n\n'), 120_000);
}

export async function summarizeMessages(
  provider: LLMProvider,
  model: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  focus?: string,
): Promise<string> {
  let text = serializeForSummary(messages);
  if (focus?.trim()) {
    text = `${text}\n\nMust preserve: ${focus.trim()}`;
  }
  if (!text.trim()) {
    return '';
  }
  let summary = '';
  for await (const event of chatWithRetry(
    provider,
    [
      { role: 'system', content: COMPACTION_PROMPT },
      { role: 'user', content: text },
    ],
    { model, signal },
  )) {
    if (event.type === 'text') {
      summary += event.text;
    }
  }
  return summary.trim();
}

export function buildCompactedMessages(
  messages: ChatMessage[],
  summary: string,
  recentStart: number,
): ChatMessage[] {
  const head = messages.slice(0, Math.min(2, messages.length));
  return [
    ...head,
    { role: 'user', content: `[Summary of earlier work — the full history was compacted]\n\n${summary}` },
    ...messages.slice(recentStart),
  ];
}

export function projectCompressedMessages(
  messages: ChatMessage[],
  blocks: CompressionBlock[],
): ChatMessage[] {
  const active = blocks
    .filter((block) => block.active)
    .sort((a, b) => a.startIndex - b.startIndex);
  if (active.length === 0) {
    return messages;
  }
  const out: ChatMessage[] = [];
  let index = 0;
  for (const block of active) {
    if (block.startIndex > index) {
      out.push(...messages.slice(index, block.startIndex));
    }
    out.push({ role: 'system', content: `${COMPRESSED_SECTION_PREFIX}\n${block.summary}` });
    index = Math.max(index, block.endIndex);
  }
  if (index < messages.length) {
    out.push(...messages.slice(index));
  }
  return out;
}

export interface CompactionCheck {
  needed: boolean;
  recentStart: number;
  tokens: number;
}

export function checkCompaction(messages: ChatMessage[], contextLimitTokens: number): CompactionCheck {
  const tokens = estimateTokens(messages);
  const needed = tokens > contextLimitTokens * COMPACTION_TRIGGER_RATIO;
  const recentStart = needed ? chooseRecentStart(messages, PRESERVE_RECENT_TOKENS) : messages.length;
  return { needed, recentStart, tokens };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
