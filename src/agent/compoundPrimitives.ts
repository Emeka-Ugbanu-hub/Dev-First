import { promises as fs } from 'fs';
import * as path from 'path';
import { normalizeSnapshotPath } from '../checkpoints/FileSnapshotStore';
import { sha1Of } from '../util/atomicWrite';

export interface WorkspacePathOk {
  ok: true;
  relative: string;
  absolute: string;
}

export interface WorkspacePathRefused {
  ok: false;
  error: string;
}

export type WorkspacePathValidation = WorkspacePathOk | WorkspacePathRefused;

export function validateWorkspacePath(root: string, value: unknown): WorkspacePathValidation {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'a workspace-relative file path is required.' };
  }
  const normalized = normalizeSnapshotPath(value);
  if (!normalized) {
    return { ok: false, error: `"${value}" must be a workspace-relative path without escapes.` };
  }
  const absolute = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, error: `"${value}" escapes the workspace.` };
  }
  return { ok: true, relative: normalized, absolute };
}

export interface FileReadResult {
  uri: string;
  relative: string;
  text: string;
  hash: string;
  language: string;
  version: number;
}

export type FileReadCache = Map<string, FileReadResult>;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.php': 'php',
  '.sh': 'shellscript',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.sql': 'sql',
  '.swift': 'swift',
  '.kt': 'kotlin',
};

export function languageForPath(file: string): string {
  const base = path.basename(file).toLowerCase();
  if (base === 'dockerfile') {
    return 'dockerfile';
  }
  const dot = base.lastIndexOf('.');
  if (dot < 0) {
    return 'plaintext';
  }
  return LANGUAGE_BY_EXTENSION[base.slice(dot)] ?? 'plaintext';
}

export function fileCacheKey(uri: string, hash: string, language: string, version?: number): string {
  return version === undefined ? `${uri}|${hash}|${language}` : `${uri}|${hash}|${language}|${version}`;
}

export function makeReadCache(): FileReadCache {
  return new Map();
}

export async function readFileWithHash(
  root: string,
  value: unknown,
  cache?: FileReadCache,
): Promise<FileReadResult | undefined> {
  const validation = validateWorkspacePath(root, value);
  if (!validation.ok) {
    return undefined;
  }
  let text: string;
  let mtimeMs: number;
  try {
    const [content, info] = await Promise.all([
      fs.readFile(validation.absolute, 'utf-8'),
      fs.stat(validation.absolute),
    ]);
    text = content;
    mtimeMs = info.mtimeMs;
  } catch {
    return undefined;
  }
  const hash = sha1Of(text);
  const language = languageForPath(validation.relative);
  const version = Math.max(1, Math.floor(mtimeMs));
  const key = fileCacheKey(validation.absolute, hash, language, version);
  const cached = cache?.get(key);
  if (cached) {
    return cached;
  }
  const result: FileReadResult = {
    uri: validation.absolute,
    relative: validation.relative,
    text,
    hash,
    language,
    version,
  };
  cache?.set(key, result);
  return result;
}

export class StaleContentError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
    readonly relative?: string,
  ) {
    super(
      `${relative ?? 'the file'} changed after it was read (expected ${expectedHash.slice(0, 8)}, found ${actualHash.slice(0, 8)}).`,
    );
    this.name = 'StaleContentError';
  }
}

export function assertFresh(cachedHash: string, currentText: string, relative?: string): string {
  const actualHash = sha1Of(currentText);
  if (actualHash !== cachedHash) {
    throw new StaleContentError(cachedHash, actualHash, relative);
  }
  return actualHash;
}

export class GeneratedFileError extends Error {
  constructor(readonly relative: string) {
    super(generatedBlockedMessage(relative));
    this.name = 'GeneratedFileError';
  }
}

const GENERATED_DIRECTORIES = new Set(['generated', 'dist', 'out', 'build']);
const GENERATED_FILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'bun.lockb',
]);

export function isGeneratedPath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  const base = segments[segments.length - 1];
  if (GENERATED_FILES.has(base)) {
    return true;
  }
  if (/\.min\.[^./]+$/.test(base)) {
    return true;
  }
  if (/\.generated\.[^./]+$/.test(base)) {
    return true;
  }
  return segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment));
}

export function generatedBlockedMessage(relative: string): string {
  return `"${relative}" is generated or read-only (lockfile, minified, generated, dist, out, or build output). Pass allowGenerated: true to override.`;
}

export function assertNotGenerated(relative: string, allowGenerated = false): void {
  if (allowGenerated) {
    return;
  }
  if (isGeneratedPath(relative)) {
    throw new GeneratedFileError(relative);
  }
}

export function occurrenceLines(content: string, needle: string): number[] {
  const lines: number[] = [];
  if (!needle) {
    return lines;
  }
  const haystack = content.replace(/\r\n/g, '\n');
  const target = needle.replace(/\r\n/g, '\n');
  let index = haystack.indexOf(target);
  while (index !== -1) {
    lines.push(haystack.slice(0, index).split('\n').length);
    index = haystack.indexOf(target, index + target.length);
  }
  return lines;
}

export function replaceExactAt(
  content: string,
  oldText: string,
  newText: string,
  occurrence: number,
): string | undefined {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const haystack = content.replace(/\r\n/g, '\n');
  const needle = oldText.replace(/\r\n/g, '\n');
  const replacement = newText.replace(/\r\n/g, '\n');
  let index = -1;
  let from = 0;
  for (let seen = 0; seen < Math.max(1, occurrence); seen++) {
    index = haystack.indexOf(needle, from);
    if (index === -1) {
      return undefined;
    }
    from = index + needle.length;
  }
  const updated = haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
  return eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated;
}

export function replaceExactAll(content: string, oldText: string, newText: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const haystack = content.replace(/\r\n/g, '\n');
  const needle = oldText.replace(/\r\n/g, '\n');
  const replacement = newText.replace(/\r\n/g, '\n');
  let updated = '';
  let position = 0;
  for (;;) {
    const index = haystack.indexOf(needle, position);
    if (index === -1) {
      break;
    }
    updated += haystack.slice(position, index) + replacement;
    position = index + needle.length;
  }
  updated += haystack.slice(position);
  return eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated;
}

export function changeDiff(relative: string, before: string | undefined, after: string | undefined): string {
  const beforeLines = (before ?? '').replace(/\r\n/g, '\n').split('\n');
  const afterLines = (after ?? '').replace(/\r\n/g, '\n').split('\n');
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  if (removed.length === 0 && added.length === 0) {
    return '';
  }
  const parts = [
    `--- ${relative}`,
    `+++ ${relative}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
  ];
  for (const line of removed) {
    parts.push(`-${line}`);
  }
  for (const line of added) {
    parts.push(`+${line}`);
  }
  return parts.join('\n');
}
