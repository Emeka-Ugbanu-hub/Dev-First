import { ChatMessage, LLMProvider } from '../llm/types';
import { Plan } from '../shared/protocol';
import { chatWithRetry } from '../llm/retry';
import { COMPACTION_PROMPT } from '../planner/prompts';
import { ContextProfile, MIN_RECENT_MESSAGES, effectiveThresholdTokens, preserveBudgetTokens } from './modelProfile';

export const PRESERVE_RECENT_TOKENS = 20_000;
export const COMPACTION_TRIGGER_RATIO = 0.6;
export const DEFAULT_CONTEXT_LIMIT = 128_000;
export const MIN_COMPRESS_MESSAGES = 6;
export const MIN_RECENT_TOOL_RESULTS = 2;
export const RECENT_TOOL_BYTES_WINDOW = 10;
export const COMPRESSED_SECTION_PREFIX = '[Compressed conversation section]';

export interface RecentTailFloor {
  minRecentMessages: number;
  minRecentToolResults: number;
}

export const ADAPTIVE_RECENT_FLOOR: RecentTailFloor = {
  minRecentMessages: MIN_RECENT_MESSAGES,
  minRecentToolResults: MIN_RECENT_TOOL_RESULTS,
};

export interface CompactionOptions {
  profile?: ContextProfile;
  reasoning?: boolean;
  recentToolBytes?: number;
}

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

/**
 * Build a conservative prompt projection for a large multi-step execution.
 * The full transcript remains in memory; only the request sent to the model
 * is reduced. If the current step has no file anchors, retain the full context
 * because relevance cannot be established safely.
 */
export function projectExecutionMessages(
  messages: ChatMessage[],
  plan: Plan,
  completedStepCount: number,
  contextLimitTokens: number,
): ChatMessage[] {
  if (plan.steps && plan.steps.length < 3) return messages;
  if (estimateTokens(messages) <= contextLimitTokens * 0.65) return messages;
  const current = plan.steps?.[Math.min(completedStepCount, (plan.steps?.length ?? 1) - 1)] ?? '';
  const anchors = new Set<string>();
  for (const value of [current, ...(plan.expectedFiles ?? []).map((entry) => entry.path)]) {
    for (const match of value.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9_-]+/g)) {
      anchors.add(match[0]);
    }
  }
  if (anchors.size === 0) return messages;

  const keep = new Set<number>([0, 1]);
  const tailStart = Math.max(2, messages.length - 8);
  for (let index = tailStart; index < messages.length; index++) keep.add(index);
  const matches = (message: ChatMessage): boolean => {
    const content = message.content ?? '';
    return [...anchors].some((anchor) => content.includes(anchor));
  };
  for (let index = 2; index < messages.length; index++) {
    const message = messages[index];
    if (!message || !matches(message)) continue;
    keep.add(index);
    if (message.role === 'tool' && message.toolCallId) {
      for (let prior = index - 1; prior >= 2; prior--) {
        const candidate = messages[prior];
        if (candidate && candidate.role === 'assistant' && candidate.toolCalls?.some((call) => call.id === message.toolCallId)) {
          keep.add(prior);
          break;
        }
      }
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const ids = new Set(message.toolCalls.map((call) => call.id));
      for (let next = index + 1; next < messages.length; next++) {
        const nextMessage = messages[next];
        if (nextMessage?.role === 'tool' && nextMessage.toolCallId && ids.has(nextMessage.toolCallId)) keep.add(next);
      }
    }
  }
  // Preserve valid assistant/tool message pairs for every retained result.
  for (const index of [...keep]) {
    const message = messages[index];
    if (message.role !== 'tool' || !message.toolCallId) continue;
    for (let prior = index - 1; prior >= 2; prior--) {
      const candidate = messages[prior];
      if (candidate.role === 'assistant' && candidate.toolCalls?.some((call) => call.id === message.toolCallId)) {
        keep.add(prior);
        break;
      }
    }
  }
  if (keep.size >= messages.length) return messages;
  const projection = messages
    .filter((_message, index) => keep.has(index));
  return [
    ...projection.slice(0, 2),
    {
      role: 'user',
      content: `[Execution context projection]\nCurrent step: ${current}\nRelevant evidence was selected by file anchors. Request exact reads if any required evidence is missing.`,
    },
    ...projection.slice(2),
  ];
}

export function chooseRecentStart(
  messages: ChatMessage[],
  preserveTokens: number,
  floor?: RecentTailFloor,
): number {
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
  if (floor) {
    start = applyRecentFloor(messages, start, floor);
  }
  while (start > 2 && messages[start].role === 'tool') {
    start--;
  }
  return Math.max(start, 2);
}

export function applyRecentFloor(messages: ChatMessage[], start: number, floor: RecentTailFloor): number {
  let capped = Math.min(start, Math.max(2, messages.length - floor.minRecentMessages));
  const toolIndexes: number[] = [];
  for (let index = messages.length - 1; index >= 0 && toolIndexes.length < floor.minRecentToolResults; index--) {
    if (messages[index].role === 'tool') {
      toolIndexes.push(index);
    }
  }
  if (toolIndexes.length >= floor.minRecentToolResults) {
    capped = Math.min(capped, toolIndexes[floor.minRecentToolResults - 1]);
  }
  return Math.max(2, capped);
}

export function recentToolResultBytes(messages: ChatMessage[]): number {
  let bytes = 0;
  let seen = 0;
  for (let index = messages.length - 1; index >= 0 && seen < RECENT_TOOL_BYTES_WINDOW; index--) {
    const message = messages[index];
    if (message.role === 'tool') {
      bytes += message.content?.length ?? 0;
      seen++;
    }
  }
  return bytes;
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

/**
 * Last-resort compaction that never calls a model. It keeps the pinned head,
 * a bounded checkpoint of older work, and the recent tail. This is used only
 * when semantic summarization is unavailable or fails at the context cliff.
 */
export function buildDeterministicCheckpoint(
  messages: ChatMessage[],
  recentStart: number,
  maxChars = 12_000,
  note?: string,
  pinned: ChatMessage[] = [],
): ChatMessage[] {
  const head = messages.slice(0, Math.min(2, messages.length));
  const tail = messages.slice(recentStart);
  const pinnedSet = new Set(pinned);
  const retainedPinned = pinned.filter((message) => !tail.includes(message));
  const older = messages.slice(2, recentStart).filter((message) => !pinnedSet.has(message));
  const checkpoint = serializeForSummary(older);
  const bounded = checkpoint.length > maxChars
    ? `${checkpoint.slice(0, Math.max(1, maxChars - 80))}\n… [older context clipped]`
    : checkpoint;
  const prefix = note?.trim() ? `${note.trim()}\n\n` : '';
  return [
    ...head,
    ...retainedPinned,
    ...(bounded.trim() || prefix
      ? [{ role: 'user' as const, content: `[Deterministic checkpoint of earlier work]\n\n${prefix}${bounded}` }]
      : []),
    ...tail,
  ];
}

/**
 * Trim the stale middle when possible; otherwise write a deterministic
 * checkpoint. No model call. Keeps pinned messages (e.g. the event ledger).
 */
export function compactDeterministically(
  messages: ChatMessage[],
  recentStart: number,
  thresholdTokens: number,
  options: { stateNote?: string; pinned?: ChatMessage[] } = {},
): ChatMessage[] {
  const pinned = options.pinned ?? [];
  const tail = messages.slice(recentStart);
  const retainedPinned = pinned.filter((message) => !tail.includes(message));
  const head = messages.slice(0, Math.min(2, messages.length));
  const state = options.stateNote?.trim()
    ? [{ role: 'user' as const, content: `[Context checkpoint state]\n${options.stateNote.trim()}` }]
    : [];
  const trimmed = [...head, ...retainedPinned, ...state, ...tail];
  if (estimateTokens(trimmed) <= thresholdTokens) {
    return trimmed;
  }
  return buildDeterministicCheckpoint(messages, recentStart, 12_000, options.stateNote, pinned);
}

export interface CompressedFold {
  messages: ChatMessage[];
  beforeTokens: number;
  afterTokens: number;
  beforeMessages: number;
  folded: boolean;
}

/**
 * Fold a live transcript deterministically when the model asks to compress.
 * Keeps the head, recent tail, and optionally a structured state note.
 */
export function foldMessagesForCompression(
  messages: ChatMessage[],
  preserveTokens: number,
  options: { minRecentStart?: number; stateNote?: string; pinned?: ChatMessage[] } = {},
): CompressedFold {
  const beforeTokens = estimateTokens(messages);
  const desiredStart = chooseRecentStart(messages, preserveTokens, ADAPTIVE_RECENT_FLOOR);
  const recentStart = Math.min(desiredStart, options.minRecentStart ?? messages.length);
  if (recentStart <= 2) {
    return { messages, beforeTokens, afterTokens: beforeTokens, beforeMessages: messages.length, folded: false };
  }
  const folded = buildDeterministicCheckpoint(messages, recentStart, 12_000, options.stateNote, options.pinned);
  const afterTokens = estimateTokens(folded);
  if (afterTokens >= beforeTokens) {
    return { messages, beforeTokens, afterTokens: beforeTokens, beforeMessages: messages.length, folded: false };
  }
  return { messages: folded, beforeTokens, afterTokens, beforeMessages: messages.length, folded: true };
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
  threshold?: number;
}

export function checkCompaction(
  messages: ChatMessage[],
  contextLimitTokens: number,
  options: CompactionOptions = {},
): CompactionCheck {
  const tokens = estimateTokens(messages);
  if (!options.profile) {
    const needed = tokens > contextLimitTokens * COMPACTION_TRIGGER_RATIO;
    const recentStart = needed ? chooseRecentStart(messages, PRESERVE_RECENT_TOKENS) : messages.length;
    return { needed, recentStart, tokens };
  }
  const reasoning = options.reasoning ?? false;
  const recentToolBytes = options.recentToolBytes ?? recentToolResultBytes(messages);
  const threshold = effectiveThresholdTokens(options.profile, contextLimitTokens, reasoning, recentToolBytes);
  const needed = tokens > threshold;
  const preserve = preserveBudgetTokens(options.profile, contextLimitTokens, reasoning);
  const recentStart = needed ? chooseRecentStart(messages, preserve, ADAPTIVE_RECENT_FLOOR) : messages.length;
  return { needed, recentStart, tokens, threshold };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
