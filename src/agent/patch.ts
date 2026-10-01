import * as path from 'path';
import { detectEol, replaceInContent, toLf } from '../util/text';

export interface PatchHunk {
  lines: string[];
}

export interface PatchOperation {
  type: 'add' | 'update' | 'delete';
  path: string;
  content?: string;
  hunks?: PatchHunk[];
}

export function parsePatch(text: string): PatchOperation[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const operations: PatchOperation[] = [];
  let current: PatchOperation | null = null;
  let hunk: PatchHunk | null = null;

  const flushHunk = () => {
    if (current?.type === 'update' && hunk && hunk.lines.length > 0) {
      current.hunks?.push(hunk);
    }
    hunk = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\*\*\* Begin Patch$/.test(trimmed)) {
      continue;
    }
    if (/^\*\*\* End Patch$/.test(trimmed)) {
      flushHunk();
      current = null;
      continue;
    }
    const addMatch = /^\*\*\* Add File:\s*(.+?)\s*$/.exec(line);
    const updateMatch = /^\*\*\* Update File:\s*(.+?)\s*$/.exec(line);
    const deleteMatch = /^\*\*\* Delete File:\s*(.+?)\s*$/.exec(line);
    if (addMatch) {
      flushHunk();
      current = { type: 'add', path: addMatch[1], content: '' };
      operations.push(current);
      continue;
    }
    if (updateMatch) {
      flushHunk();
      current = { type: 'update', path: updateMatch[1], hunks: [] };
      operations.push(current);
      continue;
    }
    if (deleteMatch) {
      flushHunk();
      current = { type: 'delete', path: deleteMatch[1] };
      operations.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    if (current.type === 'add') {
      if (line.startsWith('+')) {
        current.content = appendLine(current.content ?? '', line.slice(1));
      } else if (trimmed !== '') {
        current.content = appendLine(current.content ?? '', line);
      }
      continue;
    }
    if (current.type === 'update') {
      if (line.startsWith('@@')) {
        flushHunk();
        hunk = { lines: [] };
        continue;
      }
      if (!hunk) {
        hunk = { lines: [] };
      }
      hunk.lines.push(line);
    }
  }

  flushHunk();
  return operations;
}

export type PatchStrategy = 'exact' | 'fuzzy' | 'drift' | 'anchor';

export interface HunkLocation {
  index: number;
  length: number;
  strategy: PatchStrategy;
}

export function applyHunks(original: string, hunks: PatchHunk[]): { ok: true; content: string } | { ok: false; error: string } {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = original.replace(/\r\n/g, '\n').split('\n');

  for (const hunk of hunks) {
    const { oldLines, newLines } = splitHunkLines(hunk);
    if (oldLines.length === 0) {
      return { ok: false, error: 'Patch hunk has no context or removed lines.' };
    }
    const located = locateHunk(fileLines, oldLines);
    if (!located) {
      const preview = oldLines.slice(0, 5).join('\n');
      return {
        ok: false,
        error: `Could not locate patch hunk after exact, whitespace, drift and anchor matching. Hunk starts with:\n${preview}${oldLines.length > 5 ? '\n...' : ''}`,
      };
    }
    fileLines.splice(located.index, located.length, ...newLines);
  }

  return { ok: true, content: fileLines.join(eol) };
}

function splitHunkLines(hunk: PatchHunk): { oldLines: string[]; newLines: string[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const raw of hunk.lines) {
    if (raw.startsWith('\\')) {
      continue;
    }
    if (raw.startsWith('-')) {
      oldLines.push(raw.slice(1));
    } else if (raw.startsWith('+')) {
      newLines.push(raw.slice(1));
    } else if (raw.startsWith(' ')) {
      oldLines.push(raw.slice(1));
      newLines.push(raw.slice(1));
    } else if (raw === '') {
      oldLines.push('');
      newLines.push('');
    } else {
      oldLines.push(raw);
      newLines.push(raw);
    }
  }
  return { oldLines, newLines };
}

function appendLine(content: string, line: string): string {
  return content === '' ? line : `${content}\n${line}`;
}

export function locateHunk(fileLines: string[], block: string[]): HunkLocation | undefined {
  const exact = findExact(fileLines, block);
  if (exact !== -1) {
    return { index: exact, length: block.length, strategy: 'exact' };
  }
  const fuzzy = findFuzzy(fileLines, block);
  if (fuzzy !== -1) {
    return { index: fuzzy, length: block.length, strategy: 'fuzzy' };
  }
  const drift = findBlockWithDrift(fileLines, block);
  if (drift) {
    return { ...drift, strategy: 'drift' };
  }
  const anchor = findBlockByAnchor(fileLines, block);
  if (anchor !== -1) {
    return { index: anchor, length: block.length, strategy: 'anchor' };
  }
  return undefined;
}

export function findBlockWithDrift(
  fileLines: string[],
  block: string[],
  maxDrift = 2,
): { index: number; length: number } | undefined {
  if (block.length === 0) {
    return undefined;
  }
  const file = fileLines.map(normalizeLine);
  const target = block.map(normalizeLine);
  outer: for (let start = 0; start < file.length; start++) {
    if (file[start] !== target[0]) {
      continue;
    }
    let fileIndex = start + 1;
    let blockIndex = 1;
    let drift = 0;
    while (blockIndex < target.length) {
      if (fileIndex < file.length && file[fileIndex] === target[blockIndex]) {
        fileIndex++;
        blockIndex++;
        continue;
      }
      if (drift < maxDrift && fileIndex < file.length) {
        drift++;
        fileIndex++;
        continue;
      }
      continue outer;
    }
    return { index: start, length: fileIndex - start };
  }
  return undefined;
}

export function findBlockByAnchor(fileLines: string[], block: string[]): number {
  if (block.length === 0) {
    return -1;
  }
  const file = fileLines.map(normalizeLine);
  const target = block.map(normalizeLine);
  let anchorIndex = 0;
  for (let i = 1; i < target.length; i++) {
    if (target[i].length > target[anchorIndex].length) {
      anchorIndex = i;
    }
  }
  const anchor = target[anchorIndex];
  if (!anchor) {
    return -1;
  }
  for (let i = 0; i < file.length; i++) {
    if (file[i] !== anchor) {
      continue;
    }
    const start = i - anchorIndex;
    if (start < 0 || start + target.length > file.length) {
      continue;
    }
    if (findBlockInLines(file.slice(start, start + target.length), target) === 0) {
      return start;
    }
  }
  return -1;
}

export function findBlockInLines(fileLines: string[], block: string[]): number {
  return findBlock(fileLines, block);
}

function findBlock(fileLines: string[], block: string[]): number {
  const exact = findExact(fileLines, block);
  if (exact !== -1) {
    return exact;
  }
  return findFuzzy(fileLines, block);
}

function findExact(fileLines: string[], block: string[]): number {
  outer: for (let i = 0; i + block.length <= fileLines.length; i++) {
    for (let j = 0; j < block.length; j++) {
      if (fileLines[i + j] !== block[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function findFuzzy(fileLines: string[], block: string[]): number {
  outer: for (let i = 0; i + block.length <= fileLines.length; i++) {
    for (let j = 0; j < block.length; j++) {
      if (normalizeLine(fileLines[i + j]) !== normalizeLine(block[j])) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function normalizeLine(line: string): string {
  return line.trim();
}

export type EditStrategy = 'exact' | 'trimmed' | 'whitespace' | 'indentation';

export interface EditReplaceResult {
  ok: boolean;
  content: string;
  count?: number;
  error?: string;
  strategy?: EditStrategy;
}

export function fuzzyReplaceInContent(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): EditReplaceResult {
  if (!oldText) {
    return { ok: false, content, error: 'old_text is empty.' };
  }
  const exact = replaceInContent(content, oldText, newText, replaceAll);
  if (exact.ok) {
    return { ok: true, content: exact.content, count: exact.count, strategy: 'exact' };
  }
  if (exact.error && exact.error.includes('multiple locations')) {
    return { ok: false, content, error: exact.error };
  }

  const eol = detectEol(content);
  const haystack = toLf(content);
  const needle = toLf(oldText);
  const replacement = toLf(newText);
  const needleLines = needle.split('\n');
  const fromIndents = blockIndents(needle);

  for (const strategy of ['trimmed', 'whitespace', 'indentation'] as const) {
    const source = buildEditPattern(needleLines, strategy);
    if (!source) {
      continue;
    }
    const matches = findPatternMatches(haystack, source);
    if (matches.length === 0) {
      continue;
    }
    if (!replaceAll && matches.length > 1) {
      return {
        ok: false,
        content,
        error:
          'old_text matches multiple locations. Include more surrounding context to make it unique, or set replace_all to true.',
      };
    }
    const refusal = disproportionateMatch(haystack, matches[0], oldText);
    if (refusal) {
      return { ok: false, content, error: refusal };
    }
    if (replaceAll) {
      let updated = haystack;
      for (const match of [...matches].reverse()) {
        const toIndents = blockIndents(haystack.slice(match.start, match.end));
        updated =
          updated.slice(0, match.start) +
          alignIndent(replacement, fromIndents, toIndents) +
          updated.slice(match.end);
      }
      return { ok: true, content: restoreLineEndings(updated, eol), count: matches.length, strategy };
    }
    const match = matches[0];
    const toIndents = blockIndents(haystack.slice(match.start, match.end));
    const updated =
      haystack.slice(0, match.start) +
      alignIndent(replacement, fromIndents, toIndents) +
      haystack.slice(match.end);
    return { ok: true, content: restoreLineEndings(updated, eol), count: 1, strategy };
  }

  return {
    ok: false,
    content,
    error: 'old_text was not found in the file. Read the file and copy the exact text, including indentation.',
  };
}

function buildEditPattern(lines: string[], strategy: EditStrategy): string | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  if (strategy === 'trimmed') {
    return lines.map((line) => `[ \\t]*${escapeForPattern(line.trim())}[ \\t]*`).join('\\n');
  }
  if (strategy === 'indentation') {
    return lines.map((line) => `[ \\t]*${escapeForPattern(line.replace(/^[ \t]+/, ''))}`).join('\\n');
  }
  return lines
    .map((line) =>
      line
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .map(escapeForPattern)
        .join('\\s+'),
    )
    .join('\\s+');
}

function findPatternMatches(haystack: string, source: string): Array<{ start: number; end: number }> {
  const regex = new RegExp(`(?=(${source}))`, 'g');
  const matches: Array<{ start: number; end: number }> = [];
  let result: RegExpExecArray | null;
  while ((result = regex.exec(haystack)) !== null) {
    const matched = result[1] ?? '';
    matches.push({ start: result.index, end: result.index + matched.length });
    regex.lastIndex = result.index + 1;
    if (matches.length > 50) {
      break;
    }
  }
  return matches;
}

function disproportionateMatch(
  haystack: string,
  match: { start: number; end: number },
  oldText: string,
): string | undefined {
  const matched = haystack.slice(match.start, match.end);
  const refusal = 'match much larger than expected — re-read the file and provide the exact block';
  if (matched.split('\n').length >= oldText.split('\n').length + 3) {
    return refusal;
  }
  if (matched.length > oldText.length * 2) {
    return refusal;
  }
  return undefined;
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockIndents(text: string): string[] {
  return text.split('\n').map((line) => {
    const match = /^[ \t]*/.exec(line);
    return match ? match[0] : '';
  });
}

function alignIndent(text: string, fromIndents: string[], toIndents: string[]): string {
  return text
    .split('\n')
    .map((line, index) => {
      if (!line.trim()) {
        return line;
      }
      const from = fromIndents[index];
      if (from === undefined) {
        return line;
      }
      const fallback = toIndents.length > 0 ? toIndents[toIndents.length - 1] : from;
      const to = toIndents[index] ?? fallback;
      if (from === to) {
        return line;
      }
      if (line.startsWith(from)) {
        return `${to}${line.slice(from.length)}`;
      }
      return `${to}${line.replace(/^[ \t]*/, '')}`;
    })
    .join('\n');
}

function restoreLineEndings(content: string, eol: string): string {
  return eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
}

const fileLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const result = previous.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  fileLocks.set(key, settled);
  try {
    return await result;
  } finally {
    if (fileLocks.get(key) === settled) {
      fileLocks.delete(key);
    }
  }
}

export async function withFileLocks<T>(files: string[], task: () => Promise<T>): Promise<T> {
  const keys = [...new Set(files.map((file) => path.resolve(file)))].sort();
  const run = (index: number): Promise<T> => {
    if (index >= keys.length) {
      return task();
    }
    return withFileLock(keys[index], () => run(index + 1));
  };
  return run(0);
}
