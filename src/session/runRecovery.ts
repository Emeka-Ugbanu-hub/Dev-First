import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parsePatch } from '../agent/patch';
import { PendingDecisionRecord, RunChangedFile, RunOperation } from '../shared/protocol';
import { randomId } from '../util/id';

export const MAX_STEP_HASHES = 200;
export const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);

export type RetryOutcome = 'succeeded' | 'failed' | 'uncertain';

export interface OperationExpectation {
  path: string;
  status: RunChangedFile['status'];
  before: string | null;
  after: string | null;
  captured: boolean;
}

export function classifyOperationRetry(
  operation: Pick<RunOperation, 'beforeHash' | 'afterHash'>,
  currentHash: string | undefined,
): RetryOutcome {
  if (operation.afterHash) {
    if (currentHash === operation.afterHash) {
      return 'succeeded';
    }
    if (operation.beforeHash && currentHash === operation.beforeHash) {
      return 'failed';
    }
    return 'uncertain';
  }
  if (operation.beforeHash) {
    return currentHash === operation.beforeHash ? 'failed' : 'uncertain';
  }
  return 'uncertain';
}

export function mergeRunFileStatus(
  previous: RunChangedFile['status'] | undefined,
  next: RunChangedFile['status'],
): RunChangedFile['status'] | undefined {
  if (next === 'deleted') {
    return previous === 'added' ? undefined : 'deleted';
  }
  if (previous === 'added') {
    return 'added';
  }
  return next;
}

export function upsertRunChangedFile(
  files: RunChangedFile[] | undefined,
  entry: RunChangedFile,
): RunChangedFile[] {
  const next = files ? [...files] : [];
  const index = next.findIndex((file) => file.path === entry.path);
  if (index < 0) {
    next.push({ path: entry.path, status: entry.status });
    return next;
  }
  const merged = mergeRunFileStatus(next[index].status, entry.status);
  if (!merged) {
    next.splice(index, 1);
    return next;
  }
  next[index] = { path: entry.path, status: merged };
  return next;
}

export function appendStepHash(hashes: string[] | undefined, hash: string, max = MAX_STEP_HASHES): string[] {
  if (!hash) {
    return hashes ? [...hashes] : [];
  }
  const next = hashes ? [...hashes, hash] : [hash];
  return next.length > max ? next.slice(next.length - max) : next;
}

export function filterAlivePids(pids: number[], killProbe: (pid: number) => boolean): number[] {
  const alive: number[] = [];
  for (const pid of pids) {
    try {
      if (killProbe(pid)) {
        alive.push(pid);
      }
    } catch {}
  }
  return alive;
}

export function validateRecoveredDecision(
  decision: Pick<PendingDecisionRecord, 'kind' | 'command'>,
  options: { cwdExists: boolean },
): boolean {
  if (decision.kind !== 'terminal') {
    return true;
  }
  return Boolean(decision.command?.trim()) && options.cwdExists;
}

export function parseOperationExpectations(operation: Pick<RunOperation, 'expected'>): OperationExpectation[] {
  if (!operation.expected) {
    return [];
  }
  try {
    const parsed = JSON.parse(operation.expected) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return [];
    }
    const entries: OperationExpectation[] = [];
    for (const [entryPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      const raw = value as
        | { status?: unknown; before?: unknown; after?: unknown; captured?: unknown; hash?: unknown }
        | null;
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const status: RunChangedFile['status'] =
        raw.status === 'added' || raw.status === 'deleted' ? raw.status : 'modified';
      const before = typeof raw.before === 'string' ? raw.before : null;
      const after = typeof raw.after === 'string' ? raw.after : typeof raw.hash === 'string' ? raw.hash : null;
      const captured = raw.captured === true || typeof raw.hash === 'string';
      entries.push({ path: entryPath, status, before, after, captured });
    }
    return entries;
  } catch {
    return [];
  }
}

export function serializeOperationExpectations(expectations: OperationExpectation[]): string {
  return JSON.stringify(
    Object.fromEntries(
      expectations.map((entry) => [
        entry.path,
        { status: entry.status, before: entry.before, after: entry.after, captured: entry.captured },
      ]),
    ),
  );
}

export function absoluteWorkspacePath(root: string, relPath: string): string {
  return path.isAbsolute(relPath) ? relPath : path.join(root, relPath);
}

export async function sha1File(absolutePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(absolutePath);
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

export async function buildRunOperation(
  tool: string,
  argsJson: string,
  root: string,
): Promise<RunOperation | undefined> {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed && typeof parsed === 'object') {
      args = parsed as Record<string, unknown>;
    }
  } catch {}
  const directTarget =
    typeof args.path === 'string'
      ? args.path
      : typeof args.command === 'string'
        ? args.command
        : typeof args.directory === 'string'
          ? args.directory
          : undefined;
  const operation: RunOperation = {
    id: randomId('op'),
    tool,
    status: 'started',
    startedAt: Date.now(),
    ...(directTarget ? { target: directTarget } : {}),
  };
  if (tool === 'write_file' || tool === 'edit_file') {
    if (typeof args.path === 'string' && args.path) {
      const before = await sha1File(absoluteWorkspacePath(root, args.path));
      if (before) {
        operation.beforeHash = before;
      }
    }
    return operation;
  }
  if (tool === 'apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : '';
    const operations = parsePatch(patch);
    if (operations.length > 0) {
      operation.target = operations[0].path;
      const expectations: OperationExpectation[] = [];
      for (const entry of operations) {
        const status: RunChangedFile['status'] =
          entry.type === 'add' ? 'added' : entry.type === 'delete' ? 'deleted' : 'modified';
        expectations.push({
          path: entry.path,
          status,
          before: (await sha1File(absoluteWorkspacePath(root, entry.path))) ?? null,
          after: null,
          captured: false,
        });
      }
      operation.expected = serializeOperationExpectations(expectations);
    }
  }
  return operation;
}
