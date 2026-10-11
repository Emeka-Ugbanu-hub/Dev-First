import { promises as fs } from 'fs';
import * as path from 'path';
import { readFileWithHash, type FileReadCache } from './compoundPrimitives';

export interface RepoMapOptions {
  anchor?: string;
  anchors?: string[];
  scope?: 'file' | 'symbol' | 'package' | 'plan';
  symbol?: string;
  tokenBudget?: number;
  cache?: FileReadCache;
  tier?: 'compact' | 'standard' | 'large';
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.py', '.go', '.java', '.cs'];
const assembledCache = new Map<string, string>();

function symbols(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(pattern)) found.add(match[1]);
  return [...found].slice(0, 12);
}

function imports(text: string): string[] {
  const found = new Set<string>();
  const pattern = /(?:from\s+|import\s*\(?\s*|require\(\s*|use\s+)(['"])([^'"\n]+)\1/g;
  for (const match of text.matchAll(pattern)) {
    if (match[2].startsWith('.')) found.add(match[2]);
  }
  return [...found].slice(0, 16);
}

async function resolveImport(root: string, owner: string, specifier: string): Promise<string | undefined> {
  const base = path.resolve(path.dirname(owner), specifier);
  const candidates = [base, ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`), ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`))];
  for (const candidate of candidates) {
    try {
      const info = await fs.stat(candidate);
      if (info.isFile() && path.relative(root, candidate) && !path.relative(root, candidate).startsWith('..')) return candidate;
    } catch {}
  }
  return undefined;
}

/** Build a small, hash-backed structural map around one anchor file. */
export async function buildScopedRepoMap(root: string, options: RepoMapOptions = {}): Promise<string> {
  const tierBudget = options.tier === 'compact' ? 384 : options.tier === 'large' ? 1024 : 768;
  const tierCap = options.tier === 'large' ? 1536 : options.tier === 'compact' ? 768 : 1536;
  const budget = Math.max(256, Math.min(tierCap, options.tokenBudget ?? tierBudget));
  const anchor = options.anchor ? await readFileWithHash(root, options.anchor, options.cache) : undefined;
  if (!anchor) return 'Structural map unavailable: provide a workspace file anchor.';
  const cacheKey = `${options.scope ?? 'file'}|${options.symbol ?? ''}|${(options.anchors ?? [anchor.relative]).join(',')}|${anchor.hash}|${budget}|${options.tier ?? 'standard'}`;
  const cached = assembledCache.get(cacheKey);
  if (cached) return cached;
  const entries: Array<{ file: string; text: string; score: number }> = [];
  const add = (read: NonNullable<typeof anchor>, score: number) => entries.push({ file: read.relative, text: read.text, score });
  add(anchor, 100);
  let unresolved = 0;
  for (const specifier of imports(anchor.text)) {
    const target = await resolveImport(root, anchor.uri, specifier);
    if (!target) { unresolved++; continue; }
    const relative = path.relative(root, target).split(path.sep).join('/');
    const read = await readFileWithHash(root, relative, options.cache);
    if (read) add(read, 70);
  }
  if (options.scope === 'package' || options.scope === 'plan') {
    const directory = path.dirname(anchor.uri);
    try {
      const siblings = (await fs.readdir(directory)).filter((name) => SOURCE_EXTENSIONS.includes(path.extname(name)) && name !== path.basename(anchor.uri)).slice(0, 12);
      for (const name of siblings) {
        const relative = path.relative(root, path.join(directory, name)).split(path.sep).join('/');
        const read = await readFileWithHash(root, relative, options.cache);
        if (read) add(read, options.scope === 'plan' ? 40 : 50);
      }
    } catch {}
  }
  entries.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const lines = ['Structural map for orientation; verify relationships with exact reads and references.', `Coverage: ${entries.length} files · unresolved: ${unresolved} · stale: unknown (no persisted index baseline).`];
  let chars = lines.join('\n').length;
  for (const entry of entries) {
    const fileLines = [`${entry.file}:`, ...symbols(entry.text).map((symbol) => `  ${symbol}`)];
    const block = fileLines.join('\n');
    if (chars + block.length + 1 > budget * 4) break;
    lines.push(block);
    chars += block.length + 1;
  }
  const result = lines.join('\n');
  assembledCache.set(cacheKey, result);
  if (assembledCache.size > 64) assembledCache.delete(assembledCache.keys().next().value as string);
  return result;
}

export function clearRepoMapCache(): void {
  assembledCache.clear();
}
