import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parsePatch } from '../agent/patch';
import { PendingDecisionRecord, QuestionOption, RunChangedFile, RunOperation, RunRecord } from '../shared/protocol';
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
    next.push({ ...entry });
    return next;
  }
  const merged = mergeRunFileStatus(next[index].status, entry.status);
  if (!merged) {
    next.splice(index, 1);
    return next;
  }
  next[index] = { ...next[index], ...entry, status: merged };
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

export function questionAnswerId(pending: Pick<PendingDecisionRecord, 'id' | 'requestId'>, index: number): string {
  return `${pending.requestId ?? pending.id}:${index}`;
}

function validAnswerValue(value: string, options: QuestionOption[], allowCustom: boolean, multiple: boolean): boolean {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    return false;
  }
  if (multiple) {
    const parts = trimmed
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      return false;
    }
    return parts.every((part) => options.some((option) => option.label === part) || allowCustom);
  }
  if (options.some((option) => option.label === trimmed)) {
    return true;
  }
  return allowCustom;
}

export function validateRecoveredAnswers(
  pending: Pick<
    PendingDecisionRecord,
    'kind' | 'id' | 'requestId' | 'options' | 'allowCustom' | 'multiple' | 'questions'
  >,
  answers: Array<{ questionId?: string; value: string }>,
): boolean {
  if (pending.kind !== 'question' || !Array.isArray(answers)) {
    return false;
  }
  const questions = pending.questions ?? [];
  if (questions.length > 0) {
    if (answers.length !== questions.length) {
      return false;
    }
    for (let index = 0; index < questions.length; index++) {
      const item = questions[index];
      const id = item.id ?? questionAnswerId(pending, index);
      const matches = answers.filter((answer) => (answer.questionId ?? '') === id);
      if (matches.length !== 1) {
        return false;
      }
      if (!validAnswerValue(matches[0].value, item.options ?? [], item.custom !== false, Boolean(item.multiple))) {
        return false;
      }
    }
    return true;
  }
  if (answers.length < 1) {
    return false;
  }
  return validAnswerValue(
    answers[0].value,
    pending.options ?? [],
    pending.allowCustom !== false,
    Boolean(pending.multiple),
  );
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

export function mutationTargets(tool: string, argsJson: string): string[] {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed && typeof parsed === 'object') {
      args = parsed as Record<string, unknown>;
    }
  } catch {}
  if (tool === 'write_file' || tool === 'edit_file' || tool === 'str_replace') {
    return typeof args.path === 'string' && args.path.trim() ? [args.path.trim()] : [];
  }
  if (tool === 'apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : '';
    return parsePatch(patch).map((entry) => entry.path);
  }
  if (tool === 'apply_change_set') {
    const changes = Array.isArray(args.changes) ? args.changes : [];
    const paths: string[] = [];
    for (const entry of changes) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const target = (entry as { path?: unknown }).path;
      if (typeof target === 'string' && target.trim()) {
        paths.push(target.trim());
      }
    }
    return paths;
  }
  if (tool === 'refactor_symbol') {
    const paths: string[] = [];
    for (const key of ['path', 'targetPath'] as const) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) {
        paths.push(value.trim());
      }
    }
    return paths;
  }
  if (
    tool === 'fix_in_file' ||
    tool === 'fix_diagnostic' ||
    tool === 'add_import_and_use' ||
    tool === 'rename_symbol'
  ) {
    return typeof args.path === 'string' && args.path.trim() ? [args.path.trim()] : [];
  }
  return [];
}

export function operationAfterHash(run: Pick<RunRecord, 'operations'>, filePath: string): string | undefined {
  for (let index = run.operations.length - 1; index >= 0; index--) {
    const operation = run.operations[index];
    if (operation.tool === 'write_file' || operation.tool === 'edit_file') {
      if (operation.target === filePath && operation.afterHash) {
        return operation.afterHash;
      }
      continue;
    }
    if (operation.tool === 'apply_patch') {
      const entry = parseOperationExpectations(operation).find((candidate) => candidate.path === filePath);
      if (entry?.captured && entry.after) {
        return entry.after;
      }
    }
  }
  return undefined;
}
