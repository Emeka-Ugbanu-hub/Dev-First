import { promises as fs } from 'fs';
import * as path from 'path';

export const MAX_LINE_CHARS = 2000;
export const MAX_READ_BYTES = 50 * 1024;

export function truncateLine(line: string, maxChars = MAX_LINE_CHARS): string {
  if (line.length <= maxChars) {
    return line;
  }
  return `${line.slice(0, maxChars)} … [truncated]`;
}

export function headTailTruncate(text: string, maxChars: number, headRatio = 0.6): string {
  if (text.length <= maxChars) {
    return text;
  }
  const headBudget = Math.max(1, Math.floor(maxChars * headRatio));
  const tailBudget = Math.max(1, maxChars - headBudget);
  let head = text.slice(0, headBudget);
  let tail = text.slice(text.length - tailBudget);
  const headBreak = head.lastIndexOf('\n');
  if (headBreak !== -1) {
    head = head.slice(0, headBreak);
  }
  const tailBreak = tail.indexOf('\n');
  if (tailBreak !== -1) {
    tail = tail.slice(tailBreak + 1);
  }
  const omitted = text.slice(head.length, text.length - tail.length);
  const omittedLines = omitted ? omitted.split('\n').length : 0;
  return `${head}\n... [${omittedLines} lines omitted] ...\n${tail}`;
}

export function formatNumberedLines(lines: string[], start: number, hasMore: boolean): string {
  if (lines.length === 0) {
    return hasMore ? `Showing lines ${start}–${start - 1}; use start_line=${start}` : '(empty file)';
  }
  const numbered = lines
    .map((line, index) => `${start + index} | ${truncateLine(line)}`)
    .join('\n');
  if (!hasMore) {
    return numbered;
  }
  const last = start + lines.length - 1;
  return `${numbered}\n\nShowing lines ${start}–${last}; use start_line=${last + 1}`;
}

export function budgetEndLine(lines: string[], start: number, maxEnd: number, maxBytes: number): number {
  let bytes = 0;
  let end = start - 1;
  const limit = Math.min(maxEnd, lines.length);
  for (let line = start; line <= limit; line++) {
    const size = Buffer.byteLength(lines[line - 1], 'utf-8') + 1;
    if (bytes + size > maxBytes && end >= start) {
      break;
    }
    bytes += size;
    end = line;
  }
  return Math.max(start, end);
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeBinary(head: Buffer): string | undefined {
  const ascii = (from: number, to: number) => head.subarray(from, to).toString('latin1');
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'is a PNG image';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'is a JPEG image';
  }
  if (head.length >= 4 && ascii(0, 4) === 'GIF8') {
    return 'is a GIF image';
  }
  if (head.length >= 4 && ascii(0, 4) === '%PDF') {
    return 'is a PDF document';
  }
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'is a WebP image';
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return 'is a BMP image';
  }
  if (head.length >= 4 && head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) {
    return 'is an ICO image';
  }
  if (head.length >= 4 && (ascii(0, 4) === 'II*\u0000' || ascii(0, 4) === 'MM\u0000*')) {
    return 'is a TIFF image';
  }
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    return 'is a HEIC/AVIF image';
  }
  if (head.includes(0)) {
    return 'appears to be a binary file';
  }
  return undefined;
}

export async function sniffFileKind(absolute: string, size: number): Promise<string | undefined> {
  if (size <= 0) {
    return undefined;
  }
  let handle;
  try {
    handle = await fs.open(absolute, 'r');
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    return describeBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function suggestSimilar(entries: string[], target: string, limit = 3): string[] {
  const lower = target.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of entries) {
    const candidate = name.toLowerCase();
    if (candidate === lower) {
      continue;
    }
    if (candidate.includes(lower) || lower.includes(candidate)) {
      scored.push({ name, score: 1 });
      continue;
    }
    const distance = editDistance(candidate, lower);
    if (distance <= 2) {
      scored.push({ name, score: 2 + distance });
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) {
    return 3;
  }
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return previous[b.length];
}

const agentsMdCache = new Map<string, string | null>();

export async function findAgentsMd(dir: string, root: string): Promise<string | undefined> {
  const visited: string[] = [];
  let current = dir;
  let found: string | null = null;
  for (;;) {
    if (agentsMdCache.has(current)) {
      found = agentsMdCache.get(current) ?? null;
      break;
    }
    visited.push(current);
    try {
      found = await fs.readFile(path.join(current, 'AGENTS.md'), 'utf-8');
      break;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    const relative = path.relative(root, parent);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      break;
    }
    current = parent;
  }
  for (const visitedDir of visited) {
    agentsMdCache.set(visitedDir, found);
  }
  return found ?? undefined;
}

export function clearAgentsMdCache(): void {
  agentsMdCache.clear();
}
