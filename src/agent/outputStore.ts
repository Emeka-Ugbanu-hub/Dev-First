import { mkdirSync, promises as fs } from 'fs';
import * as path from 'path';

export const SPILL_MAX_LINES = 2000;
export const SPILL_MAX_BYTES = 50 * 1024;
export const SPILL_PREVIEW_CHARS = 20_000;
export const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let workspaceRoot: string | undefined;
let cleanupStarted = false;

export function initOutputStore(root: string): void {
  if (!root) {
    return;
  }
  workspaceRoot = root;
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  void cleanupSpillFiles(root).catch(() => undefined);
}

export function toolOutputDir(root: string): string {
  return path.join(root, '.dev-first', 'tool-output');
}

export function spillFileName(label: string): string {
  const safe =
    label
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'output';
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${safe}-${stamp}.txt`;
}

export function createSpillFileSync(
  root: string,
  label: string,
): { absolute: string; relative: string } | undefined {
  try {
    const dir = toolOutputDir(root);
    mkdirSync(dir, { recursive: true });
    const absolute = path.join(dir, spillFileName(label));
    return { absolute, relative: path.relative(root, absolute).split(path.sep).join('/') };
  } catch {
    return undefined;
  }
}

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

export async function spillOutput(text: string, label: string): Promise<string> {
  const lines = countLines(text);
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (lines <= SPILL_MAX_LINES && bytes <= SPILL_MAX_BYTES) {
    return text;
  }
  const root = workspaceRoot;
  if (!root) {
    return text;
  }
  const target = createSpillFileSync(root, label);
  if (!target) {
    return text;
  }
  try {
    await fs.writeFile(target.absolute, text, 'utf-8');
  } catch {
    return text;
  }
  return spillPreview(text, target.relative);
}

export function spillPreview(text: string, relativePath: string): string {
  const headBudget = Math.floor(SPILL_PREVIEW_CHARS * 0.4);
  const tailBudget = SPILL_PREVIEW_CHARS - headBudget;
  let head = text.slice(0, headBudget);
  let tail = text.slice(Math.max(0, text.length - tailBudget));
  const headBreak = head.lastIndexOf('\n');
  if (headBreak > 0) {
    head = head.slice(0, headBreak);
  }
  const tailBreak = tail.indexOf('\n');
  if (tailBreak !== -1) {
    tail = tail.slice(tailBreak + 1);
  }
  const tailStart = Math.max(head.length, text.length - tail.length);
  const omitted = text.slice(head.length, tailStart);
  const omittedLines = countLines(omitted);
  return `${head}\n... [${omittedLines} lines omitted — full output: ${relativePath}]\n${tail}`;
}

export async function cleanupSpillFiles(root: string, maxAgeMs = SPILL_RETENTION_MS): Promise<number> {
  const dir = toolOutputDir(root);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    const absolute = path.join(dir, name);
    try {
      const stat = await fs.stat(absolute);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        await fs.unlink(absolute);
        removed++;
      }
    } catch {
      continue;
    }
  }
  return removed;
}
