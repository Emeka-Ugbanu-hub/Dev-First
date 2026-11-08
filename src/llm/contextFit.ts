import { ChatMessage, ChatOptions } from './types';

const MIN_TOOL_CHARS = 192;
const MIN_SYSTEM_CHARS = 400;
const MIN_ASSISTANT_CHARS = 256;
const MIN_USER_CHARS = 256;
const MIN_INSTRUCTION_CHARS = 512;

export class ContextBudgetError extends Error {
  readonly name = 'ContextBudgetError';

  constructor(
    readonly estimatedPromptTokens: number,
    readonly contextLimitTokens: number,
    readonly reservedOutputTokens: number,
    readonly estimatedToolSchemaTokens: number,
  ) {
    const budget = Math.max(0, contextLimitTokens - reservedOutputTokens);
    super(
      `Prepared request is still estimated at ${estimatedPromptTokens.toLocaleString()} input tokens ` +
      `(${estimatedToolSchemaTokens.toLocaleString()} from tool schemas), above the ` +
      `${budget.toLocaleString()}-token input budget for this model's ${contextLimitTokens.toLocaleString()}-token context. ` +
      'The request was stopped before sending. Narrow the question or reduce attached/context material.',
    );
  }
}

/**
 * Estimate the token cost of a request closely enough for a last-mile guard.
 * The estimate intentionally includes tool schemas because providers count
 * them against the same context window.
 */
export function estimateRequestTokens(
  messages: ChatMessage[],
  options: Pick<ChatOptions, 'tools'> = {},
): number {
  const messageChars = messages.reduce(
    (total, message) =>
      total +
      (message.content?.length ?? 0) +
      // Images have provider/model-specific costs. Reserve a conservative
      // amount so image prompts do not bypass the preflight estimate.
      (message.images?.length ?? 0) * 1024 * 4 +
      (message.toolCalls ?? []).reduce(
        (sum, call) => sum + call.name.length + call.arguments.length + 24,
        0,
      ),
    0,
  );
  const schemaTokens = estimatedToolSchemaTokens(options);
  return Math.ceil(messageChars / 4) + schemaTokens + messages.length * 8;
}

function estimatedToolSchemaTokens(options: Pick<ChatOptions, 'tools'>): number {
  if (!options.tools?.length) return 0;
  // Providers wrap each definition in their own function/tool envelope.
  return Math.ceil(JSON.stringify(options.tools).length / 4) + options.tools.length * 24;
}

/**
 * Leave room for the model's answer. When the caller gives an explicit output
 * cap, honor it (capped at half the window); otherwise reserve 28%.
 */
export function requestBudget(limit: number, options: ChatOptions): number {
  const reserve = options.maxTokens && options.maxTokens > 0
    ? Math.min(Math.max(256, options.maxTokens), Math.floor(limit * 0.5))
    : Math.floor(limit * 0.28);
  return Math.max(0, limit - Math.max(256, reserve));
}

function compactMiddle(text: string, targetChars: number, marker: string): string {
  if (targetChars >= text.length) {
    return text;
  }
  const markerText = `\n${marker}\n`;
  const keep = Math.max(64, targetChars - markerText.length);
  if (keep >= text.length) {
    return text;
  }
  const head = Math.max(32, Math.floor(keep * 0.6));
  const tail = Math.max(32, keep - head);
  return `${text.slice(0, head)}${markerText}${text.slice(-tail)}`;
}

interface ToolGroup {
  assistantIndex: number;
  toolCallIds: Set<string>;
}

function toolGroups(messages: ChatMessage[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      continue;
    }
    groups.push({
      assistantIndex: index,
      toolCallIds: new Set(message.toolCalls.map((call) => call.id)),
    });
  }
  return groups;
}

function removeToolGroup(messages: ChatMessage[], group: ToolGroup): ChatMessage[] {
  const remove = new Set<number>([group.assistantIndex]);
  for (let index = group.assistantIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'tool' && message.toolCallId && group.toolCallIds.has(message.toolCallId)) {
      remove.add(index);
    }
  }
  return messages.filter((_, index) => !remove.has(index));
}

function removeOrphanToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const callIds = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      callIds.add(call.id);
    }
  }
  return messages.filter(
    (message) => message.role !== 'tool' || !message.toolCallId || callIds.has(message.toolCallId),
  );
}

/**
 * Shared last-mile context guard. It preserves the system instructions and the
 * latest question while reducing older evidence first. Every provider request
 * that goes through chatWithRetry uses it, so direct answers, planning, and
 * execution all get the same hard safety net.
 */
export function fitRequestToContext(messages: ChatMessage[], options: ChatOptions): ChatMessage[] {
  const limit = options.contextTokens;
  if (!limit || limit <= 0) {
    return messages.map((message) => ({ ...message }));
  }
  const budget = requestBudget(limit, options);
  let fitted = messages.map((message) => ({ ...message }));
  let excess = estimateRequestTokens(fitted, options) - budget;
  if (excess <= 0) {
    return fitted;
  }

  // 1. Compact older tool output first. Recent evidence is more valuable than
  // older read results, so walk forward and preserve the tail of each result.
  for (let index = 0; index < fitted.length && excess > 0; index++) {
    const message = fitted[index];
    if (message.role !== 'tool' || message.content.length < 384) {
      continue;
    }
    const target = Math.max(MIN_TOOL_CHARS, message.content.length - excess * 4);
    const next = compactMiddle(message.content, target, '…earlier tool output compacted…');
    if (next.length < message.content.length) {
      message.content = next;
      excess = estimateRequestTokens(fitted, options) - budget;
    }
  }

  // 2. Remove the oldest complete assistant/tool groups, but keep the most
  // recent group while other options remain. This never leaves a tool result
  // without its assistant call.
  while (excess > 0) {
    const groups = toolGroups(fitted);
    if (groups.length <= 1) {
      break;
    }
    fitted = removeOrphanToolMessages(removeToolGroup(fitted, groups[0]));
    excess = estimateRequestTokens(fitted, options) - budget;
  }

  // 3. Compact older assistant prose. The latest assistant message may be the
  // answer being continued, so preserve it until the final fallback.
  const lastAssistant = fitted.reduce(
    (last, message, index) => (message.role === 'assistant' ? index : last),
    -1,
  );
  for (let index = 0; index < fitted.length && excess > 0; index++) {
    if (index === lastAssistant) {
      continue;
    }
    const message = fitted[index];
    if (message.role !== 'assistant' || message.toolCalls?.length || message.content.length < 512) {
      continue;
    }
    const target = Math.max(MIN_ASSISTANT_CHARS, message.content.length - excess * 4);
    const next = compactMiddle(message.content, target, '…earlier assistant message compacted…');
    if (next.length < message.content.length) {
      message.content = next;
      excess = estimateRequestTokens(fitted, options) - budget;
    }
  }

  // 4. Compact large system evidence blocks, largest first. Keep the first
  // system message (the answer/planning instructions) intact for now.
  const firstSystem = fitted.findIndex((message) => message.role === 'system');
  while (excess > 0) {
    const candidates = fitted
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message, index }) =>
          index !== firstSystem && message.role === 'system' && message.content.length > MIN_SYSTEM_CHARS,
      )
      .sort((left, right) => right.message.content.length - left.message.content.length);
    if (candidates.length === 0) {
      break;
    }
    const candidate = candidates[0];
    const target = Math.max(MIN_SYSTEM_CHARS, candidate.message.content.length - excess * 4);
    const next = compactMiddle(
      candidate.message.content,
      target,
      '…earlier context compacted…',
    );
    if (next.length >= candidate.message.content.length) {
      break;
    }
    candidate.message.content = next;
    excess = estimateRequestTokens(fitted, options) - budget;
  }

  // 5. Compact the latest user request only after older evidence is gone.
  const latestUser = fitted.reduce(
    (last, message, index) => (message.role === 'user' ? index : last),
    -1,
  );
  if (excess > 0 && latestUser >= 0) {
    const message = fitted[latestUser];
    if (message.content.length > 512) {
      const target = Math.max(MIN_USER_CHARS, message.content.length - excess * 4);
      message.content = compactMiddle(
        message.content,
        target,
        '…middle of request compacted to fit context…',
      );
      excess = estimateRequestTokens(fitted, options) - budget;
    }
  }

  // 6. Compact older user turns before touching the instructions.
  for (let index = 0; index < fitted.length && excess > 0; index++) {
    if (index === latestUser) {
      continue;
    }
    const message = fitted[index];
    if (message.role !== 'user' || message.content.length < 512) {
      continue;
    }
    const target = Math.max(MIN_USER_CHARS, message.content.length - excess * 4);
    const next = compactMiddle(message.content, target, '…earlier request compacted…');
    if (next.length < message.content.length) {
      message.content = next;
      excess = estimateRequestTokens(fitted, options) - budget;
    }
  }

  // 7. The instructions are the last thing to shrink. Preserve their opening
  // so the model still knows what it is doing.
  if (excess > 0 && firstSystem >= 0) {
    const message = fitted[firstSystem];
    if (message.content.length > MIN_INSTRUCTION_CHARS) {
      const target = Math.max(MIN_INSTRUCTION_CHARS, message.content.length - excess * 4);
      message.content = compactMiddle(
        message.content,
        target,
        '…system instructions compacted to fit context…',
      );
      excess = estimateRequestTokens(fitted, options) - budget;
    }
  }

  // 8. Final fallback: shrink the largest remaining message, including the
  // latest assistant continuation seed if necessary. Never remove the latest
  // user message or the first system message entirely.
  while (excess > 0) {
    const candidates = fitted
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) => {
        if (index === firstSystem || index === latestUser) {
          return false;
        }
        return message.content.length > 128;
      })
      .sort((left, right) => right.message.content.length - left.message.content.length);
    if (candidates.length === 0) {
      break;
    }
    const candidate = candidates[0];
    const target = Math.max(128, candidate.message.content.length - excess * 4);
    const next = compactMiddle(
      candidate.message.content,
      target,
      '…message compacted to fit context…',
    );
    if (next.length >= candidate.message.content.length) {
      break;
    }
    candidate.message.content = next;
    excess = estimateRequestTokens(fitted, options) - budget;
  }

  // 9. If the latest assistant group is the only thing left, drop it as a last
  // resort. It is better to lose old evidence than to send an overflowing
  // request.
  while (excess > 0) {
    const groups = toolGroups(fitted);
    if (groups.length === 0) {
      break;
    }
    fitted = removeOrphanToolMessages(removeToolGroup(fitted, groups[0]));
    excess = estimateRequestTokens(fitted, options) - budget;
  }

  fitted = removeOrphanToolMessages(fitted);
  const estimatedPromptTokens = estimateRequestTokens(fitted, options);
  if (estimatedPromptTokens > budget) {
    const reservedOutputTokens = Math.max(256, limit - budget);
    throw new ContextBudgetError(
      estimatedPromptTokens,
      limit,
      reservedOutputTokens,
      estimatedToolSchemaTokens(options),
    );
  }
  return fitted;
}
