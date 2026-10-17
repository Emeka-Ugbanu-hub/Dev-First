import { ToolCall } from '../llm/types';

export type DoomLoopAction = 'none' | 'warn' | 'stop';
export type DoomLoopKind = 'exact' | 'no-progress';

export interface LoopProgress {
  fingerprint: string;
  description: string;
}

export interface DoomLoopResult {
  action: DoomLoopAction;
  count: number;
  key: string;
  kind: DoomLoopKind;
  polling: boolean;
  signature: string;
  message?: string;
  description?: string;
  callIndex?: number;
}

const VOLATILE_ARGUMENT_KEYS = new Set([
  'line',
  'character',
  'endLine',
  'endCharacter',
  'timestamp',
  'id',
  'start_line',
  'end_line',
]);

const PATH_ARGUMENT_KEYS = new Set(['path', 'file', 'glob']);

const POLLING_TOOLS = new Set([
  'list_files',
  'list_processes',
  'browser_navigate',
  'browser_evaluate',
  'browser_screenshot',
]);

const MAX_SIGNATURES = 200;
const NO_PROGRESS_STOP_REPEATS = 3;

interface SignatureState {
  fingerprint: string;
  repeats: number;
  warned: boolean;
  lastCallId: string;
}

export function canonicalToolSignature(call: ToolCall): string {
  const parsed = parseArguments(call.arguments);
  const canonical = parsed === undefined ? call.arguments : JSON.stringify(canonicalizeValue(parsed));
  return `${call.name}:${canonical}`;
}

export function referencedFilePaths(call: ToolCall): string[] {
  const parsed = parseArguments(call.arguments);
  const paths: string[] = [];
  collectPaths(parsed, paths);
  return [...new Set(paths)];
}

export function touchedFileHash(call: ToolCall, hashes: Map<string, string>): string {
  const entries: string[] = [];
  for (const path of referencedFilePaths(call)) {
    const hash = hashes.get(path);
    if (hash === undefined) {
      continue;
    }
    entries.push(`${path}:${hash}`);
  }
  entries.sort();
  return entries.join('|');
}

function parseArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function canonicalizeValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'patch') {
      return canonicalizePatch(value);
    }
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return key !== undefined && PATH_ARGUMENT_KEYS.has(key) ? normalizePathText(collapsed) : collapsed;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry, key));
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const entryKey of Object.keys(source).sort()) {
      if (VOLATILE_ARGUMENT_KEYS.has(entryKey) || source[entryKey] === undefined) {
        continue;
      }
      result[entryKey] = canonicalizeValue(source[entryKey], entryKey);
    }
    return result;
  }
  return value;
}

function canonicalizePatch(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*@@.*@@\s*$/.test(line))
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

function normalizePathText(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

function collectPaths(value: unknown, paths: string[], key?: string): void {
  if (typeof value === 'string') {
    if (key !== undefined && PATH_ARGUMENT_KEYS.has(key)) {
      const normalized = normalizePathText(value.replace(/\s+/g, ' ').trim());
      if (normalized) {
        paths.push(normalized);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, key);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
      collectPaths(entry, paths, entryKey);
    }
  }
}

export class DoomLoopDetector {
  private readonly history: string[] = [];
  private readonly pollingHistory: string[] = [];
  private readonly warned = new Set<string>();
  private readonly signatures = new Map<string, SignatureState>();
  private progressFingerprint: string | undefined;
  private callCount = 0;
  private lastRecordedCallId: string | undefined;

  constructor(
    private readonly window = 8,
    private readonly warnAt = 3,
    private readonly stopAt = 5,
  ) {}

  record(call: ToolCall, progress?: LoopProgress): DoomLoopResult {
    const key = `${call.name}:${call.arguments}`;
    const signature = canonicalToolSignature(call);
    const polling = POLLING_TOOLS.has(call.name);
    const warnAt = polling ? this.warnAt * 2 : this.warnAt;
    const stopAt = polling ? this.stopAt * 2 : this.stopAt;

    if (call.id !== this.lastRecordedCallId) {
      this.callCount += 1;
      this.lastRecordedCallId = call.id;
    }
    const callIndex = this.callCount;

    const history = polling ? this.pollingHistory : this.history;
    const window = polling ? Math.max(this.window, stopAt * 2) : this.window;
    history.push(key);
    if (history.length > window) {
      history.shift();
    }
    const count = history.filter((entry) => entry === key).length;

    if (count >= stopAt) {
      return {
        action: 'stop',
        count,
        key,
        kind: 'exact',
        polling,
        signature,
        callIndex,
        message: polling
          ? `Stopped: ${call.name} was polled ${count} times with no change.`
          : `Stopped: the same tool call (${call.name}) was repeated ${count} times. Possible loop.`,
      };
    }

    if (progress && !polling) {
      this.observeProgress(progress.fingerprint);
      const state = this.signatures.get(signature);
      if (!state || state.fingerprint !== progress.fingerprint) {
        this.rememberSignature(signature, {
          fingerprint: progress.fingerprint,
          repeats: 0,
          warned: false,
          lastCallId: call.id,
        });
      } else if (state.lastCallId !== call.id) {
        state.lastCallId = call.id;
        state.repeats += 1;
        if (state.repeats >= NO_PROGRESS_STOP_REPEATS) {
          return {
            action: 'stop',
            count: state.repeats + 1,
            key,
            kind: 'no-progress',
            polling,
            signature,
            callIndex,
            description: progress.description,
            message: `Stopped after three repeated attempts with no progress since ${progress.description} at call ${callIndex}.`,
          };
        }
        if (state.repeats === 1 && !state.warned) {
          state.warned = true;
          return {
            action: 'warn',
            count: state.repeats + 1,
            key,
            kind: 'no-progress',
            polling,
            signature,
            callIndex,
            description: progress.description,
            message: `LOOP RECOVERY: ${call.name} was repeated with identical arguments and no progress. Do not repeat it; re-read the relevant evidence, choose one different bounded action, or explain the blocker.`,
          };
        }
      }
    }

    if (count >= warnAt && !this.warned.has(key)) {
      this.warned.add(key);
      return {
        action: 'warn',
        count,
        key,
        kind: 'exact',
        polling,
        signature,
        callIndex,
        message: polling
          ? `LOOP RECOVERY: ${call.name} returned the same state repeatedly. Stop polling and use a different bounded check.`
          : `LOOP RECOVERY: ${call.name} was repeated with identical arguments. Do not repeat it; choose a different bounded action or explain the blocker.`,
      };
    }

    return { action: 'none', count, key, kind: 'exact', polling, signature, callIndex };
  }

  noteProgress(progress: LoopProgress): void {
    this.progressFingerprint = progress.fingerprint;
    // A successful edit, verification, completed step, or steering message
    // starts a new loop window. Do not carry exact-call counts from the old
    // state into a legitimately different part of the task.
    this.history.length = 0;
    this.pollingHistory.length = 0;
    this.signatures.clear();
    this.warned.clear();
  }

  reset(): void {
    this.history.length = 0;
    this.pollingHistory.length = 0;
    this.warned.clear();
    this.signatures.clear();
    this.progressFingerprint = undefined;
    this.callCount = 0;
    this.lastRecordedCallId = undefined;
  }

  private observeProgress(fingerprint: string): void {
    if (this.progressFingerprint === fingerprint) {
      return;
    }
    this.progressFingerprint = fingerprint;
    this.signatures.clear();
    this.warned.clear();
  }

  private rememberSignature(signature: string, state: SignatureState): void {
    this.signatures.set(signature, state);
    if (this.signatures.size > MAX_SIGNATURES) {
      const oldest = this.signatures.keys().next().value;
      if (oldest !== undefined) {
        this.signatures.delete(oldest);
      }
    }
  }
}
