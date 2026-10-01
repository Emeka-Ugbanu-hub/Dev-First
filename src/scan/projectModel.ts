import { createHash } from 'crypto';
import { repairJson } from '../agent/jsonRepair';
import type { LLMProvider } from '../llm/types';
import { extractBalanced, parseJsonLoose, tryParseJson } from '../util/json';
import type { AiPrompt } from './aiScanner';
import { collectCompletion } from './aiScanner';
import type { Convention } from './conventions';
import {
  classifyLayer,
  dirOf,
  memorySection,
  replaceMemorySection,
} from './conventions';
import { resolveSpecifier, shortName } from './crossFile';
import type { FileFacts } from './duplication';

export const PROJECT_MODEL_HEADING = '## Project model';
export const PROJECT_MODEL_MIN_BULLETS = 5;
export const PROJECT_MODEL_MAX_BULLETS = 10;
export const PROJECT_MODEL_RELEVANCE_CAP = 5;
export const PROJECT_MODEL_MAX_TOKENS = 1200;
export const PROJECT_MODEL_REVALIDATE_MAX_TOKENS = 700;

export interface ProjectModelBullet {
  statement: string;
  file: string;
  line: number;
  verifiedAt: number;
  stale?: boolean;
}

export interface ProjectModelSnapshot {
  hashes: Record<string, string>;
  layerFiles: string[];
  edges: string[];
}

export interface ProjectModelState {
  bullets: ProjectModelBullet[];
  snapshot: ProjectModelSnapshot;
}

export interface ProjectModelMemory {
  read(): Promise<string>;
  replace(content: string): Promise<void>;
}

export interface ProjectModelDeps {
  memory: ProjectModelMemory;
  loadState: () => ProjectModelState | undefined | Promise<ProjectModelState | undefined>;
  saveState: (state: ProjectModelState) => void | Promise<void>;
  getFacts: () => Promise<FileFacts[]>;
  getHashes: () => Promise<Map<string, string>>;
  buildProvider: () => Promise<LLMProvider | undefined>;
  getModel: () => string;
}

export const PROJECT_MODEL_SYSTEM = [
  'You are Dev-First building a short project model of a codebase.',
  'Write 5-10 short factual bullets about how the project is structured and how its layers work together.',
  'Every bullet must be supported by one real file and line from the structure shown. Never invent files or behavior.',
  'Prefer facts that stay true across changes: layering, boundaries, shared patterns, where responsibilities live.',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"bullets":[{"statement":"","file":"","line":1}]}',
  'Rules: statement is one plain sentence; file is a workspace-relative path from the list; line is 1-based; at most 10 bullets; empty result is {"bullets":[]}.',
].join('\n');

export const PROJECT_MODEL_REVALIDATE_SYSTEM = [
  'You are Dev-First refreshing stale bullets of a project model after the codebase changed.',
  'For each stale bullet, either restate it as one plain sentence that still holds or omit it entirely.',
  'Use only the structure facts shown. Never invent files.',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"bullets":[{"index":1,"statement":"","line":1}]}',
  'Rules: index is the 1-based number of the stale bullet; statement is one plain sentence; line is an optional 1-based evidence line; omit bullets that no longer hold; empty result is {"bullets":[]}.',
].join('\n');

export function emptyProjectModelSnapshot(): ProjectModelSnapshot {
  return { hashes: {}, layerFiles: [], edges: [] };
}

export function collectProjectModelSnapshot(
  facts: FileFacts[],
  hashes: Map<string, string>,
): ProjectModelSnapshot {
  const known = new Set(facts.map((file) => file.file));
  const layerFiles = new Set<string>();
  const edges = new Set<string>();
  for (const file of facts) {
    if (classifyLayer(file.file)) {
      layerFiles.add(file.file);
    }
    for (const record of file.imports) {
      const to = resolveSpecifier(file.file, record.specifier, known);
      if (to && to !== file.file) {
        edges.add(`${file.file}\u0000${to}`);
      }
    }
  }
  return {
    hashes: Object.fromEntries(hashes),
    layerFiles: [...layerFiles].sort(),
    edges: [...edges].sort(),
  };
}

function filesInDir(layerFiles: string[], dir: string): string {
  return layerFiles
    .filter((file) => dirOf(file) === dir)
    .map((file) => shortName(file))
    .sort()
    .join('\n');
}

function edgesOf(edges: string[], file: string): string {
  return edges
    .filter((edge) => edge.startsWith(`${file}\u0000`) || edge.endsWith(`\u0000${file}`))
    .join('\n');
}

export type ProjectModelStaleReason =
  | 'evidence deleted'
  | 'evidence changed'
  | 'layer files changed'
  | 'imports changed'
  | 'unverified';

export function projectModelStaleReason(
  bullet: ProjectModelBullet,
  previous: ProjectModelSnapshot,
  current: ProjectModelSnapshot,
): ProjectModelStaleReason | undefined {
  if (!current.hashes[bullet.file]) {
    return 'evidence deleted';
  }
  if (bullet.stale === true) {
    return 'unverified';
  }
  const previousHash = previous.hashes[bullet.file];
  if (previousHash === undefined) {
    return 'unverified';
  }
  if (previousHash !== current.hashes[bullet.file]) {
    return 'evidence changed';
  }
  if (filesInDir(previous.layerFiles, dirOf(bullet.file)) !== filesInDir(current.layerFiles, dirOf(bullet.file))) {
    return 'layer files changed';
  }
  if (edgesOf(previous.edges, bullet.file) !== edgesOf(current.edges, bullet.file)) {
    return 'imports changed';
  }
  return undefined;
}

export interface ProjectModelStaleness {
  bullets: ProjectModelBullet[];
  stale: ProjectModelBullet[];
  reasons: Map<ProjectModelBullet, ProjectModelStaleReason>;
}

export function updateProjectModelStaleness(
  bullets: ProjectModelBullet[],
  previous: ProjectModelSnapshot,
  current: ProjectModelSnapshot,
): ProjectModelStaleness {
  const next: ProjectModelBullet[] = [];
  const stale: ProjectModelBullet[] = [];
  const reasons = new Map<ProjectModelBullet, ProjectModelStaleReason>();
  for (const bullet of bullets) {
    const reason = projectModelStaleReason(bullet, previous, current);
    if (reason === 'evidence deleted') {
      continue;
    }
    const updated: ProjectModelBullet = reason
      ? { ...bullet, stale: true }
      : { ...bullet, stale: undefined };
    next.push(updated);
    if (reason) {
      stale.push(updated);
      reasons.set(updated, reason);
    }
  }
  return { bullets: next, stale, reasons };
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'their',
  'when',
  'where',
  'what',
  'how',
  'why',
  'all',
  'use',
  'using',
  'add',
  'update',
  'change',
  'fix',
  'make',
  'new',
  'project',
  'codebase',
  'file',
  'files',
  'code',
]);

export function relevanceTerms(text: string): string[] {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
  return [...new Set(terms)];
}

export function projectModelBulletScore(bullet: ProjectModelBullet, terms: string[]): number {
  const text = `${bullet.statement} ${shortName(bullet.file)}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) {
      score++;
    }
  }
  return score;
}

export function relevantProjectModelBullets(
  bullets: ProjectModelBullet[],
  request: string,
  cap = PROJECT_MODEL_RELEVANCE_CAP,
): ProjectModelBullet[] {
  const terms = relevanceTerms(request);
  if (terms.length === 0) {
    return [];
  }
  return bullets
    .map((bullet) => ({ bullet, score: projectModelBulletScore(bullet, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.bullet.verifiedAt - a.bullet.verifiedAt)
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.bullet);
}

export function formatProjectModelBullet(bullet: ProjectModelBullet): string {
  const prefix = bullet.stale ? '(may be outdated) ' : '';
  const stamp = new Date(bullet.verifiedAt).toISOString().slice(0, 10);
  return `${prefix}${bullet.statement} (${shortName(bullet.file)}:${bullet.line + 1}, verified ${stamp})`;
}

export function formatProjectModelSection(bullets: ProjectModelBullet[]): string {
  return `${PROJECT_MODEL_HEADING}\n${bullets
    .map((bullet) => `- ${formatProjectModelBullet(bullet)}`)
    .join('\n')}`;
}

const BULLET_LINE = /^-\s+(?:\(may be outdated\)\s+)?(.*)\s+\(([^()]+):(\d+), verified (\d{4}-\d{2}-\d{2})\)$/;

export function parseProjectModelSection(memory: string): ProjectModelBullet[] {
  const bullets: ProjectModelBullet[] = [];
  for (const line of memorySection(memory, PROJECT_MODEL_HEADING)) {
    const match = BULLET_LINE.exec(line.trim());
    if (!match) {
      continue;
    }
    bullets.push({
      statement: match[1].trim(),
      file: match[2].trim(),
      line: Math.max(0, Number(match[3]) - 1),
      verifiedAt: Date.parse(`${match[4]}T00:00:00.000Z`) || 0,
      stale: line.trim().startsWith('- (may be outdated)') || undefined,
    });
  }
  return bullets;
}

export function formatRelevantProjectModel(bullets: ProjectModelBullet[]): string | undefined {
  if (bullets.length === 0) {
    return undefined;
  }
  return `# Project model (relevant to this request)\n${bullets
    .map((bullet) => `- ${formatProjectModelBullet(bullet)}`)
    .join('\n')}`;
}

export function resolveEvidenceFile(facts: FileFacts[], candidate: string): string | undefined {
  const cleaned = candidate.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!cleaned) {
    return undefined;
  }
  const exact = facts.find((file) => file.file === cleaned);
  if (exact) {
    return exact.file;
  }
  const normalized = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  const suffixMatches = facts.filter((file) => {
    try {
      return new URL(file.file).pathname.endsWith(normalized);
    } catch {
      return false;
    }
  });
  if (suffixMatches.length === 1) {
    return suffixMatches[0].file;
  }
  const baseMatches = facts.filter((file) => shortName(file.file) === cleaned);
  return baseMatches.length === 1 ? baseMatches[0].file : undefined;
}

export function summarizeProjectStructure(facts: FileFacts[]): string[] {
  const known = new Set(facts.map((file) => file.file));
  const importers = new Map<string, number>();
  for (const file of facts) {
    for (const record of file.imports) {
      const to = resolveSpecifier(file.file, record.specifier, known);
      if (to && to !== file.file) {
        importers.set(to, (importers.get(to) ?? 0) + 1);
      }
    }
  }
  const layers = new Map<string, string[]>();
  for (const file of facts) {
    const layer = classifyLayer(file.file);
    if (!layer) {
      continue;
    }
    const list = layers.get(layer);
    if (list) {
      list.push(shortName(file.file));
    } else {
      layers.set(layer, [shortName(file.file)]);
    }
  }
  const lines: string[] = [];
  for (const layer of ['handlers', 'services', 'repositories']) {
    const files = (layers.get(layer) ?? []).sort();
    if (files.length > 0) {
      lines.push(
        `${layer} (${files.length}): ${files.slice(0, 12).join(', ')}${
          files.length > 12 ? `, +${files.length - 12} more` : ''
        }`,
      );
    }
  }
  const others = facts
    .filter((file) => !classifyLayer(file.file))
    .map((file) => shortName(file.file))
    .sort();
  if (others.length > 0) {
    lines.push(`other (${others.length}): ${others.slice(0, 12).join(', ')}`);
  }
  const hubs = [...importers.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8);
  if (hubs.length > 0) {
    lines.push(`most imported: ${hubs.map(([file, count]) => `${shortName(file)} (${count})`).join(', ')}`);
  }
  const handlerFiles = facts
    .filter((file) => (file.handlers ?? []).length > 0)
    .map((file) => shortName(file.file))
    .slice(0, 8);
  if (handlerFiles.length > 0) {
    lines.push(`route handlers in: ${handlerFiles.join(', ')}`);
  }
  return lines;
}

export function buildProjectModelPrompt(conventions: Convention[], facts: FileFacts[]): AiPrompt {
  const conventionLines =
    conventions.length > 0
      ? conventions.map((convention) => `- ${convention.statement}`).join('\n')
      : '(none mined yet)';
  return {
    system: PROJECT_MODEL_SYSTEM,
    user: [
      'Mined conventions:',
      conventionLines,
      'Project structure:',
      summarizeProjectStructure(facts).join('\n') || '(empty)',
      'Write the project model bullets now.',
    ].join('\n'),
  };
}

function parseBulletEntries(raw: string): unknown[] | undefined {
  const parsed = parseJsonLoose(raw) ?? repairAndParse(raw);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { bullets?: unknown }).bullets)) {
    return (parsed as { bullets: unknown[] }).bullets;
  }
  return undefined;
}

function repairAndParse(raw: string): unknown {
  const repaired = repairJson(raw);
  const direct = tryParseJson(repaired);
  if (direct !== undefined) {
    return direct;
  }
  const extracted = extractBalanced(repaired);
  return extracted ? tryParseJson(extracted) : undefined;
}

export function parseProjectModelResponse(
  raw: string,
  facts: FileFacts[],
  now = Date.now(),
): ProjectModelBullet[] {
  const entries = parseBulletEntries(raw);
  if (!entries) {
    return [];
  }
  const bullets: ProjectModelBullet[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (bullets.length >= PROJECT_MODEL_MAX_BULLETS) {
      break;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const statement = typeof record.statement === 'string' ? record.statement.trim() : '';
    const candidate = typeof record.file === 'string' ? record.file.trim() : '';
    if (!statement || !candidate || seen.has(statement)) {
      continue;
    }
    const file = resolveEvidenceFile(facts, candidate);
    if (!file) {
      continue;
    }
    const rawLine =
      typeof record.line === 'number' && Number.isFinite(record.line) ? Math.trunc(record.line) : 1;
    seen.add(statement);
    bullets.push({
      statement,
      file,
      line: Math.max(0, rawLine - 1),
      verifiedAt: now,
    });
  }
  return bullets;
}

export function buildProjectModelRevalidationPrompt(
  stale: ProjectModelBullet[],
  current: ProjectModelSnapshot,
  facts: FileFacts[],
): AiPrompt {
  const lines = stale.map((bullet, index) => {
    const reason = current.hashes[bullet.file] ? 'file exists' : 'file is gone';
    return `${index + 1}. ${bullet.statement} — evidence ${shortName(bullet.file)}:${
      bullet.line + 1
    } (${reason})`;
  });
  return {
    system: PROJECT_MODEL_REVALIDATE_SYSTEM,
    user: [
      'Stale bullets:',
      lines.join('\n'),
      'Current structure:',
      summarizeProjectStructure(facts).join('\n') || '(empty)',
    ].join('\n'),
  };
}

export interface ProjectModelRefresh {
  statement: string;
  line?: number;
}

export function parseProjectModelRevalidation(
  raw: string,
  stale: ProjectModelBullet[],
  now = Date.now(),
): Map<number, ProjectModelRefresh & { verifiedAt: number }> | undefined {
  const entries = parseBulletEntries(raw);
  if (!entries) {
    return undefined;
  }
  const updates = new Map<number, ProjectModelRefresh & { verifiedAt: number }>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const index =
      typeof record.index === 'number' && Number.isFinite(record.index)
        ? Math.trunc(record.index) - 1
        : -1;
    if (index < 0 || index >= stale.length) {
      continue;
    }
    const statement = typeof record.statement === 'string' ? record.statement.trim() : '';
    if (!statement) {
      continue;
    }
    const line =
      typeof record.line === 'number' && Number.isFinite(record.line)
        ? Math.max(0, Math.trunc(record.line) - 1)
        : undefined;
    updates.set(index, { statement, line, verifiedAt: now });
  }
  return updates;
}

function revalidationKey(stale: ProjectModelBullet[], current: ProjectModelSnapshot): string {
  const parts = stale.map((bullet) => [
    bullet.statement,
    bullet.file,
    bullet.line,
    current.hashes[bullet.file] ?? '',
    filesInDir(current.layerFiles, dirOf(bullet.file)),
    edgesOf(current.edges, bullet.file),
  ]);
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

function structureKey(facts: FileFacts[], hashes: Map<string, string>): string {
  const parts = facts.map((file) => [
    file.file,
    hashes.get(file.file) ?? '',
    file.imports.map((record) => `${record.specifier}:${record.line}`),
  ]);
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

export class ProjectModel {
  private bullets: ProjectModelBullet[] = [];
  private snapshot: ProjectModelSnapshot = emptyProjectModelSnapshot();
  private loaded = false;
  private readonly revalidationCache = new Map<
    string,
    Map<number, ProjectModelRefresh & { verifiedAt: number }>
  >();
  private readonly generationKeys = new Set<string>();

  constructor(private readonly deps: ProjectModelDeps) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const state = await this.deps.loadState();
    if (state && Array.isArray(state.bullets)) {
      this.bullets = state.bullets;
      this.snapshot = state.snapshot ?? emptyProjectModelSnapshot();
      return;
    }
    const memory = await this.deps.memory.read();
    this.bullets = parseProjectModelSection(memory).map((bullet) => ({ ...bullet, stale: true }));
  }

  getBullets(): ProjectModelBullet[] {
    return this.bullets;
  }

  async ensureFresh(conventions: Convention[]): Promise<void> {
    await this.load();
    if (this.bullets.length === 0) {
      await this.generate(conventions);
      return;
    }
    await this.updateIfStale();
  }

  async generate(conventions: Convention[]): Promise<void> {
    const [facts, hashes] = await Promise.all([this.deps.getFacts(), this.deps.getHashes()]);
    if (facts.length === 0) {
      return;
    }
    const key = structureKey(facts, hashes);
    if (this.generationKeys.has(key)) {
      return;
    }
    const provider = await this.deps.buildProvider();
    if (!provider) {
      return;
    }
    this.generationKeys.add(key);
    try {
      const raw = await collectCompletion(
        provider,
        this.deps.getModel(),
        buildProjectModelPrompt(conventions, facts),
        new AbortController().signal,
        PROJECT_MODEL_MAX_TOKENS,
      );
      const bullets = parseProjectModelResponse(raw, facts);
      if (bullets.length === 0) {
        return;
      }
      this.bullets = bullets;
      this.snapshot = collectProjectModelSnapshot(facts, hashes);
      await this.persist();
    } catch {
      return;
    }
  }

  async updateIfStale(): Promise<void> {
    await this.load();
    const [facts, hashes] = await Promise.all([this.deps.getFacts(), this.deps.getHashes()]);
    if (facts.length === 0) {
      return;
    }
    const current = collectProjectModelSnapshot(facts, hashes);
    this.bullets = this.bullets.map((bullet) => {
      if (current.hashes[bullet.file]) {
        return bullet;
      }
      const resolved = resolveEvidenceFile(facts, bullet.file);
      return resolved ? { ...bullet, file: resolved } : bullet;
    });
    const result = updateProjectModelStaleness(this.bullets, this.snapshot, current);
    this.bullets = result.bullets;
    if (result.stale.length > 0) {
      const updates = await this.revalidate(result.stale, current, facts);
      if (updates.size > 0) {
        this.bullets = this.bullets.map((bullet) => {
          const index = result.stale.indexOf(bullet);
          const update = index >= 0 ? updates.get(index) : undefined;
          if (!update) {
            return bullet;
          }
          return {
            ...bullet,
            statement: update.statement,
            line: update.line ?? bullet.line,
            verifiedAt: update.verifiedAt,
            stale: undefined,
          };
        });
      }
    }
    this.snapshot = current;
    await this.persist();
  }

  private async revalidate(
    stale: ProjectModelBullet[],
    current: ProjectModelSnapshot,
    facts: FileFacts[],
  ): Promise<Map<number, ProjectModelRefresh & { verifiedAt: number }>> {
    const key = revalidationKey(stale, current);
    const cached = this.revalidationCache.get(key);
    if (cached) {
      return cached;
    }
    const provider = await this.deps.buildProvider();
    if (!provider) {
      return new Map();
    }
    let updates = new Map<number, ProjectModelRefresh & { verifiedAt: number }>();
    try {
      const raw = await collectCompletion(
        provider,
        this.deps.getModel(),
        buildProjectModelRevalidationPrompt(stale, current, facts),
        new AbortController().signal,
        PROJECT_MODEL_REVALIDATE_MAX_TOKENS,
      );
      updates = parseProjectModelRevalidation(raw, stale) ?? new Map();
    } catch {
      updates = new Map();
    }
    this.revalidationCache.set(key, updates);
    return updates;
  }

  private async persist(): Promise<void> {
    await this.deps.saveState({ bullets: this.bullets, snapshot: this.snapshot });
    const memory = await this.deps.memory.read();
    const section = formatProjectModelSection(this.bullets);
    const next = replaceMemorySection(memory, PROJECT_MODEL_HEADING, section);
    if (next !== undefined) {
      await this.deps.memory.replace(next);
    }
  }
}
