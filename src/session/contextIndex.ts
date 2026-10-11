import type { ChatMessage } from '../llm/types';
import type { PendingDecisionRecord, Plan } from '../shared/protocol';
import type { SessionContextEntry } from './SessionStore';

export interface ContextMetadataUpdate {
  files?: string[];
  symbols?: string[];
  planStepIds?: string[];
  decisionIds?: string[];
  toolNames?: string[];
  summary?: string;
}

const FILE_PATTERN = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;
const SYMBOL_PATTERN = /\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g;
const MAX_FILES = 16;
const MAX_SYMBOLS = 32;
const MAX_IDS = 32;
const MAX_SUMMARY = 200;

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function messageContent(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
}

export function messageHash(message: ChatMessage): string {
  const text = messageContent(message);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return String(hash >>> 0);
}

export function buildContextEntry(
  message: ChatMessage,
  index: number,
  update?: ContextMetadataUpdate,
): SessionContextEntry {
  const text = messageContent(message);
  const files = update?.files?.length ? unique(update.files) : unique(text.match(FILE_PATTERN) ?? []);
  const symbols = update?.symbols?.length ? unique(update.symbols) : unique(text.match(SYMBOL_PATTERN) ?? []);
  const summary = update?.summary?.trim();
  return {
    index,
    messageId: message.id ?? `message-${index}`,
    files: files.slice(0, MAX_FILES),
    symbols: symbols.slice(0, MAX_SYMBOLS),
    planStepIds: unique(update?.planStepIds ?? []).slice(0, MAX_IDS),
    decisionIds: unique(update?.decisionIds ?? []).slice(0, MAX_IDS),
    toolNames: unique(update?.toolNames ?? []).slice(0, MAX_IDS),
    ...(summary ? { summary: summary.slice(0, MAX_SUMMARY) } : {}),
    createdAt: Date.now(),
    hash: messageHash(message),
  };
}

export function mergeContextMetadata(entry: SessionContextEntry, update: ContextMetadataUpdate): SessionContextEntry {
  entry.files = unique([...entry.files, ...(update.files ?? [])]).slice(0, MAX_FILES);
  entry.symbols = unique([...entry.symbols, ...(update.symbols ?? [])]).slice(0, MAX_SYMBOLS);
  entry.planStepIds = unique([...entry.planStepIds, ...(update.planStepIds ?? [])]).slice(0, MAX_IDS);
  entry.decisionIds = unique([...entry.decisionIds, ...(update.decisionIds ?? [])]).slice(0, MAX_IDS);
  entry.toolNames = unique([...entry.toolNames, ...(update.toolNames ?? [])]).slice(0, MAX_IDS);
  const summary = update.summary?.trim();
  if (summary) {
    entry.summary = summary.slice(0, MAX_SUMMARY);
  }
  return entry;
}

export function mergeMetadataUpdates(
  base: ContextMetadataUpdate | undefined,
  update: ContextMetadataUpdate,
): ContextMetadataUpdate {
  const summary = update.summary?.trim() ?? base?.summary;
  return {
    files: [...(base?.files ?? []), ...(update.files ?? [])],
    symbols: [...(base?.symbols ?? []), ...(update.symbols ?? [])],
    planStepIds: [...(base?.planStepIds ?? []), ...(update.planStepIds ?? [])],
    decisionIds: [...(base?.decisionIds ?? []), ...(update.decisionIds ?? [])],
    toolNames: [...(base?.toolNames ?? []), ...(update.toolNames ?? [])],
    ...(summary ? { summary } : {}),
  };
}

export function toolContextMetadata(name: string, argsJson: string): ContextMetadataUpdate {
  const update: ContextMetadataUpdate = { toolNames: [name] };
  let args: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return update;
  }
  if (!args) {
    return update;
  }
  const files: string[] = [];
  for (const key of ['path', 'file', 'targetPath'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      files.push(value);
    }
  }
  if (Array.isArray(args.paths)) {
    files.push(...args.paths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())));
  }
  if (Array.isArray(args.changes)) {
    for (const change of args.changes) {
      if (change && typeof change === 'object' && typeof (change as { path?: unknown }).path === 'string') {
        files.push(String((change as { path: string }).path));
      }
    }
  }
  const symbols: string[] = [];
  for (const key of ['symbol', 'symbolName'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      symbols.push(value);
    }
  }
  const detail = [args.command, args.query].find(
    (value): value is string => typeof value === 'string' && Boolean(value.trim()),
  );
  if (files.length > 0) {
    update.files = files;
  }
  if (symbols.length > 0) {
    update.symbols = symbols;
  }
  if (detail) {
    update.summary = `${name}: ${detail.trim()}`;
  }
  return update;
}

export function planContextMetadata(plan: Plan): ContextMetadataUpdate {
  const stepIds = (plan.steps ?? []).map((_step, index) => String(index));
  const title = plan.title?.trim() || 'Plan';
  return {
    planStepIds: stepIds,
    summary: `plan v${plan.version}: ${title}`,
  };
}

export function decisionContextMetadata(pending: PendingDecisionRecord): ContextMetadataUpdate {
  return {
    decisionIds: [pending.id],
    summary: `${pending.kind} decision: ${pending.prompt}`,
  };
}

export function mutationContextMetadata(paths: string[]): ContextMetadataUpdate {
  return paths.length > 0 ? { files: paths } : {};
}

export function diagnosticsContextMetadata(snapshot: {
  diagnosticsAvailable: boolean;
  newDiagnosticErrors: number;
}): ContextMetadataUpdate {
  if (!snapshot.diagnosticsAvailable) {
    return {};
  }
  const summary = snapshot.newDiagnosticErrors === 1 ? '1 error' : `${snapshot.newDiagnosticErrors} errors`;
  return { summary };
}

export function rebuildContextIndex(messages: ChatMessage[]): SessionContextEntry[] {
  return messages.map((message, index) => buildContextEntry(message, index));
}
