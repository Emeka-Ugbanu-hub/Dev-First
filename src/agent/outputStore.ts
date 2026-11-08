import { createReadStream, mkdirSync, promises as fs } from 'fs';
import { StringDecoder } from 'string_decoder';
import * as path from 'path';

export const SPILL_MAX_LINES = 2000;
export const SPILL_MAX_BYTES = 50 * 1024;
export const SPILL_PREVIEW_CHARS = 20_000;
export const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OUTPUT_RANGE_LINES = 500;
export const MAX_OUTPUT_RANGE_BYTES = 50 * 1024;
const MAX_OUTPUT_LINE_CHARS = 2_000;
const MAX_OUTPUT_COLUMN_CHARS = 12_000;

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

export async function spillOutput(
  text: string,
  label: string,
  maxPreviewChars = SPILL_PREVIEW_CHARS,
  root = workspaceRoot,
): Promise<string> {
  const lines = countLines(text);
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (lines <= SPILL_MAX_LINES && bytes <= SPILL_MAX_BYTES) {
    return text;
  }
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
  return spillPreview(text, target.relative, maxPreviewChars);
}

export function spillPreview(text: string, relativePath: string, maxPreviewChars = SPILL_PREVIEW_CHARS): string {
  const headBudget = Math.floor(maxPreviewChars * 0.4);
  const tailBudget = maxPreviewChars - headBudget;
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

/** Read a bounded line range from a spill file without loading the file into memory. */
export async function readSpilledOutputRange(
  root: string,
  relativePath: string,
  startLine: number,
  endLine: number,
  startColumn?: number,
  endColumn?: number,
): Promise<string> {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return 'Error: start_line and end_line must be positive, inclusive line numbers.';
  }
  if (endLine - startLine + 1 > MAX_OUTPUT_RANGE_LINES) {
    return `Error: output ranges are limited to ${MAX_OUTPUT_RANGE_LINES} lines per call.`;
  }
  const hasStartColumn = startColumn !== undefined;
  const hasEndColumn = endColumn !== undefined;
  if (hasStartColumn !== hasEndColumn) {
    return 'Error: provide both start_column and end_column, or neither.';
  }
  if (hasStartColumn && (!Number.isInteger(startColumn) || !Number.isInteger(endColumn) || startColumn! < 1 || endColumn! < startColumn!)) {
    return 'Error: start_column and end_column must be positive, inclusive character positions.';
  }
  if (hasStartColumn && endColumn! - startColumn! + 1 > MAX_OUTPUT_COLUMN_CHARS) {
    return `Error: column ranges are limited to ${MAX_OUTPUT_COLUMN_CHARS} characters per line.`;
  }

  const outputRoot = path.resolve(root, '.dev-first', 'tool-output');
  const absolute = path.resolve(root, relativePath);
  const lexicalRelative = path.relative(outputRoot, absolute);
  if (!lexicalRelative || lexicalRelative.startsWith(`..${path.sep}`) || lexicalRelative === '..' || path.isAbsolute(lexicalRelative)) {
    return 'Error: read_output only accepts files inside .dev-first/tool-output.';
  }

  let realOutputRoot: string;
  let realFile: string;
  try {
    [realOutputRoot, realFile] = await Promise.all([fs.realpath(outputRoot), fs.realpath(absolute)]);
    const realRelative = path.relative(realOutputRoot, realFile);
    if (!realRelative || realRelative.startsWith(`..${path.sep}`) || realRelative === '..' || path.isAbsolute(realRelative)) {
      return 'Error: output path resolves outside .dev-first/tool-output.';
    }
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) return 'Error: the requested output is not a file.';
  } catch {
    return `Error: saved output was not found at ${relativePath}.`;
  }

  const lines: string[] = [];
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(realFile);
  let pending = '';
  let pendingTruncated = false;
  let currentLineLength = 0;
  let lineNumber = 0;
  let selectedBytes = 0;
  let stoppedAtByteLimit = false;

  const appendPart = (part: string): void => {
    if (hasStartColumn && startColumn !== undefined && endColumn !== undefined) {
      const partStart = currentLineLength;
      const partEnd = partStart + part.length;
      const wantedStart = startColumn - 1;
      const wantedEnd = endColumn;
      const overlapStart = Math.max(0, wantedStart - partStart);
      const overlapEnd = Math.min(part.length, wantedEnd - partStart);
      if (overlapEnd > overlapStart) pending += part.slice(overlapStart, overlapEnd);
      currentLineLength = partEnd;
      return;
    }
    if (pending.length < MAX_OUTPUT_LINE_CHARS) {
      const available = MAX_OUTPUT_LINE_CHARS - pending.length;
      pending += part.slice(0, available);
    }
    if (part.length > MAX_OUTPUT_LINE_CHARS || pending.length >= MAX_OUTPUT_LINE_CHARS) pendingTruncated = true;
    currentLineLength += part.length;
  };

  const finishLine = (): boolean => {
    lineNumber++;
    if (lineNumber >= startLine && lineNumber <= endLine) {
      const clean = pending.endsWith('\r') ? pending.slice(0, -1) : pending;
      const columnLabel = hasStartColumn ? ` [columns ${startColumn}-${endColumn}]` : '';
      const rendered = `${lineNumber}${columnLabel} | ${clean}${pendingTruncated ? ' … [line truncated; use start_column/end_column for the rest]' : ''}`;
      const size = Buffer.byteLength(rendered, 'utf8') + 1;
      if (selectedBytes + size > MAX_OUTPUT_RANGE_BYTES && lines.length > 0) {
        stoppedAtByteLimit = true;
        return false;
      }
      lines.push(rendered);
      selectedBytes += size;
    }
    pending = '';
    pendingTruncated = false;
    currentLineLength = 0;
    return lineNumber < endLine;
  };

  const consume = (text: string): boolean => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      if (newline < 0) {
        appendPart(text.slice(offset));
        return true;
      }
      appendPart(text.slice(offset, newline));
      if (!finishLine()) return false;
      offset = newline + 1;
    }
    return true;
  };

  try {
    for await (const chunk of stream) {
      if (!consume(decoder.write(chunk as Buffer))) break;
    }
    if (!stoppedAtByteLimit) {
      const tail = decoder.end();
      if (tail) consume(tail);
      if (pending.length > 0 || pendingTruncated) finishLine();
    }
  } catch {
    return `Error: could not read saved output at ${relativePath}.`;
  } finally {
    stream.destroy();
  }

  if (lines.length === 0) return `No saved output lines found in range ${startLine}-${endLine}.`;
  return [
    `Saved output: ${relativePath} (requested lines ${startLine}-${endLine}${hasStartColumn ? `, columns ${startColumn}-${endColumn}` : ''})`,
    ...lines,
    ...(stoppedAtByteLimit ? [`[Range stopped at ${MAX_OUTPUT_RANGE_BYTES} bytes; request a smaller line range.]`] : []),
  ].join('\n');
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
