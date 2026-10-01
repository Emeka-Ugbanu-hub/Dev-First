import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode-test',
  'target',
  'vendor',
  '.cache',
  'tmp',
]);

export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.scss', '.less',
  '.html', '.htm', '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh', '.rs',
  '.go', '.php', '.rb', '.cs', '.kt', '.kts', '.swift', '.sql', '.sh', '.bash', '.zsh', '.ps1',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.txt', '.xml', '.gradle', '.properties', '.vue',
  '.svelte', '.astro', '.env', '.gitignore', '.dockerfile', 'dockerfile', '.lua', '.dart',
  '.scala', '.clj', '.ex', '.exs',
]);

export interface WalkOptions {
  matcher?: RegExp | ((relative: string) => boolean);
  maxEntries?: number;
  maxDepth?: number;
  extensions?: Set<string>;
}

export async function listWorkspaceFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const results: string[] = [];
  const maxEntries = options.maxEntries ?? 2000;
  await walk(root, root, results, options, 0, maxEntries);
  return results;
}

async function walk(
  root: string,
  dir: string,
  results: string[],
  options: WalkOptions,
  depth: number,
  maxEntries: number,
): Promise<void> {
  if (depth > (options.maxDepth ?? 10) || results.length >= maxEntries) {
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= maxEntries) {
      return;
    }
    if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.dev-first') {
      continue;
    }
    if (entry.name === '.dev-first' && depth === 0) {
      continue;
    }
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walk(root, absolute, results, options, depth + 1, maxEntries);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (options.matcher && !matchesRelative(options.matcher, relative)) {
      continue;
    }
    if (options.extensions) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!options.extensions.has(ext)) {
        continue;
      }
    }
    results.push(relative);
  }
}

function matchesRelative(matcher: WalkOptions['matcher'], relative: string): boolean {
  if (!matcher) {
    return true;
  }
  return typeof matcher === 'function' ? matcher(relative) : matcher.test(relative);
}

export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) {
    return [pattern];
  }
  const close = matchingBrace(pattern, open);
  if (close === -1) {
    return [pattern];
  }
  const inner = pattern.slice(open + 1, close);
  const options = splitTopLevel(inner);
  if (options.length <= 1) {
    return [pattern];
  }
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const expanded: string[] = [];
  for (const option of options) {
    for (const result of expandBraces(`${prefix}${option}${suffix}`)) {
      expanded.push(result);
    }
  }
  return expanded;
}

function matchingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '\\') {
      current += char + (inner[i + 1] ?? '');
      i++;
      continue;
    }
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
    }
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

export interface RipgrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface RipgrepSearchOptions {
  root: string;
  base: string;
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  maxResults: number;
}

export interface RipgrepSearchResult {
  matches: RipgrepMatch[];
  truncated: boolean;
}

export interface RipgrepListResult {
  files: string[];
  truncated: boolean;
}

let ripgrepBinary: string | null | undefined;

export function resetRipgrepCache(): void {
  ripgrepBinary = undefined;
}

export async function findRipgrepBinary(): Promise<string | undefined> {
  if (ripgrepBinary !== undefined) {
    return ripgrepBinary ?? undefined;
  }
  const override = process.env.DEV_FIRST_RG_PATH;
  const candidates = override
    ? [override]
    : ['rg', '/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];
  for (const candidate of candidates) {
    const found = await probeBinary(candidate);
    if (found) {
      ripgrepBinary = found;
      return found;
    }
  }
  ripgrepBinary = null;
  return undefined;
}

function probeBinary(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 2000 }, (error) => {
      resolve(error ? undefined : binary);
    });
  });
}

export async function rgSearch(options: RipgrepSearchOptions): Promise<RipgrepSearchResult | undefined> {
  const binary = await findRipgrepBinary();
  if (!binary) {
    return undefined;
  }
  const args = ['--json', '--no-messages'];
  if (!options.isRegex) {
    args.push('--fixed-strings');
  }
  if (!options.caseSensitive) {
    args.push('--ignore-case');
  }
  args.push('--max-count', String(options.maxResults + 1), '-e', options.query, '--', options.base);
  const stdout = await runRipgrep(binary, args, options.root);
  if (stdout === undefined) {
    return undefined;
  }
  const parsed = parseRipgrepJson(stdout);
  return { matches: parsed.slice(0, options.maxResults), truncated: parsed.length > options.maxResults };
}

export async function rgListFiles(base: string, maxEntries: number): Promise<RipgrepListResult | undefined> {
  const binary = await findRipgrepBinary();
  if (!binary) {
    return undefined;
  }
  const stdout = await runRipgrep(binary, ['--files'], base);
  if (stdout === undefined) {
    return undefined;
  }
  const files = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { files: files.slice(0, maxEntries), truncated: files.length > maxEntries };
}

function runRipgrep(binary: string, args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binary, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        const code = (error as { code?: unknown }).code;
        resolve(code === 1 || code === '1' ? '' : undefined);
        return;
      }
      resolve(stdout);
    });
  });
}

export function parseRipgrepJson(stdout: string): RipgrepMatch[] {
  const matches: RipgrepMatch[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== 'match') {
      continue;
    }
    const file = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    let text = event.data?.lines?.text ?? '';
    if (text.endsWith('\n')) {
      text = text.slice(0, -1);
    }
    if (text.endsWith('\r')) {
      text = text.slice(0, -1);
    }
    if (typeof file === 'string' && typeof lineNumber === 'number') {
      matches.push({ file, line: lineNumber, text });
    }
  }
  return matches;
}
