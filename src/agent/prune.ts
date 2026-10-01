import { ChatMessage } from '../llm/types';
import { parseJsonLoose } from '../util/json';

export const KEEP_RECENT_TOOL_RESULTS = 10;
export const PRUNE_TRIGGER_RATIO = 0.5;
export const MIN_PRUNABLE_CONTENT = 200;
export const ERROR_PURGE_TURNS = 4;

export const PRUNED_TOOL_OUTPUT =
  '[Output removed to save context — information superseded or no longer needed]';
export const DUPLICATE_TOOL_OUTPUT = '[Output removed — duplicate call; newest result kept]';
export const FAILED_TOOL_OUTPUT = '[Output removed — failed call; information superseded]';

export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'edit_file',
  'write_file',
  'apply_patch',
  'task',
  'todo_write',
  'ask_user',
  'memory_save',
  'use_skill',
  'set_reasoning',
  'compress_context',
]);

export interface PruneOptions {
  keepRecentToolResults?: number;
  minContentLength?: number;
  errorPurgeTurns?: number;
  protectedTools?: ReadonlySet<string>;
  dedupe?: boolean;
  purgeErrors?: boolean;
  pruneOldResults?: boolean;
}

export function shouldPrune(tokens: number, contextLimit: number): boolean {
  return contextLimit > 0 && tokens > contextLimit * PRUNE_TRIGGER_RATIO;
}

export function pruneMessages(messages: ChatMessage[], options: PruneOptions = {}): ChatMessage[] {
  const keepRecent = options.keepRecentToolResults ?? KEEP_RECENT_TOOL_RESULTS;
  const minContentLength = options.minContentLength ?? MIN_PRUNABLE_CONTENT;
  const errorPurgeTurns = options.errorPurgeTurns ?? ERROR_PURGE_TURNS;
  const protectedTools = options.protectedTools ?? PROTECTED_TOOL_NAMES;

  const result = messages.slice();
  const toolIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'tool') {
      toolIndexes.push(index);
    }
  }
  if (toolIndexes.length === 0) {
    return result;
  }

  const argumentsById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) {
        argumentsById.set(call.id, call.arguments);
      }
    }
  }

  const recent = new Set(toolIndexes.slice(Math.max(0, toolIndexes.length - keepRecent)));
  const replacements = new Map<number, string>();

  if (options.dedupe !== false) {
    const groups = new Map<string, number[]>();
    for (const index of toolIndexes) {
      const message = messages[index];
      if (protectedTools.has(message.toolName ?? '')) {
        continue;
      }
      const raw = resolveArguments(message, index, messages, argumentsById);
      if (raw === undefined) {
        continue;
      }
      const key = `${message.toolName ?? ''}\u0000${normalizeArguments(raw)}`;
      const group = groups.get(key);
      if (group) {
        group.push(index);
      } else {
        groups.set(key, [index]);
      }
    }
    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }
      for (const index of group.slice(0, -1)) {
        replacements.set(index, DUPLICATE_TOOL_OUTPUT);
      }
    }
  }

  if (options.purgeErrors !== false) {
    for (const index of toolIndexes) {
      const message = messages[index];
      if (protectedTools.has(message.toolName ?? '') || replacements.has(index)) {
        continue;
      }
      if (!message.content.startsWith('Error:')) {
        continue;
      }
      let assistantsAfter = 0;
      for (let cursor = index + 1; cursor < messages.length; cursor++) {
        if (messages[cursor].role === 'assistant') {
          assistantsAfter++;
        }
      }
      if (assistantsAfter > errorPurgeTurns) {
        replacements.set(index, FAILED_TOOL_OUTPUT);
      }
    }
  }

  if (options.pruneOldResults !== false) {
    for (const index of toolIndexes) {
      if (recent.has(index) || replacements.has(index)) {
        continue;
      }
      const message = messages[index];
      if (protectedTools.has(message.toolName ?? '')) {
        continue;
      }
      if (message.content.length <= minContentLength) {
        continue;
      }
      replacements.set(index, PRUNED_TOOL_OUTPUT);
    }
  }

  for (const [index, content] of replacements) {
    const message = messages[index];
    if (message.content !== content) {
      result[index] = { ...message, content };
    }
  }
  return result;
}

function resolveArguments(
  message: ChatMessage,
  index: number,
  messages: ChatMessage[],
  argumentsById: Map<string, string>,
): string | undefined {
  if (message.toolCallId) {
    const known = argumentsById.get(message.toolCallId);
    if (known !== undefined) {
      return known;
    }
  }
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = messages[cursor];
    if (candidate.role !== 'assistant' || !candidate.toolCalls?.length) {
      continue;
    }
    const exact = message.toolCallId
      ? candidate.toolCalls.find((call) => call.id === message.toolCallId)
      : undefined;
    if (exact) {
      return exact.arguments;
    }
    const named = candidate.toolCalls.filter((call) => call.name === message.toolName);
    return named.length === 1 ? named[0].arguments : undefined;
  }
  return undefined;
}

function normalizeArguments(raw: string): string {
  const parsed = parseJsonLoose(raw);
  if (parsed === undefined) {
    return raw.trim();
  }
  return stableStringify(parsed);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
