import { createHash } from 'crypto';
import { repairJson } from '../agent/jsonRepair';
import type { LLMProvider } from '../llm/types';
import { extractBalanced, parseJsonLoose, tryParseJson } from '../util/json';
import { collectCompletion } from '../scan/aiScanner';
import type { AiPrompt } from '../scan/aiScanner';
import type { FileFacts } from '../scan/duplication';
import { classifyLevelChildren } from './flow';
import { commonRootOf, relativePathOf } from './model';
import type { ArchitectureNode } from './model';
import { computeRelations } from './relations';

export const LEVEL_LABELS_MAX_TOKENS = 700;
export const MAX_LEVEL_LABEL_CHARS = 60;
export const MAX_LEVEL_SUBTEXT_CHARS = 80;
export const MAX_LEVEL_VERB_CHARS = 24;

const MAX_SUMMARY_CHILDREN = 40;
const MAX_SUMMARY_SAMPLES = 2;
const MAX_SUMMARY_EDGES = 20;

export interface LevelNodeLabel {
  id: string;
  label?: string;
  subtext?: string;
}

export interface LevelEdgeLabel {
  from: string;
  to: string;
  verb: string;
}

export interface LevelLabels {
  nodes: LevelNodeLabel[];
  edges: LevelEdgeLabel[];
}

export const LEVEL_LABELS_SYSTEM = [
  'You improve the labels of one level of a code architecture diagram.',
  'Use the deterministic children, roles, file samples, and edges as evidence.',
  'Name each node by its ROLE in the flow: entry point, core step, storage, or output surface.',
  'At the project root, name each domain by its role: Frontend, Backend, Database, Workers, Infrastructure, Integrations — choose from the folder evidence.',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"nodes":[{"id":"","label":"","subtext":""}],"edges":[{"from":"","to":"","verb":""}]}',
  'Rules: copy every id exactly from the summary; only include nodes or edges you can improve; label is 1-4 words; subtext is one short factual sentence; verb is 1-3 words such as imports, calls, read/write, click, publishes.',
].join('\n');

export const levelLabelsCache = new Map<string, LevelLabels | null>();

function repairAndParse(raw: string): unknown {
  const repaired = repairJson(raw);
  const direct = tryParseJson(repaired);
  if (direct !== undefined) {
    return direct;
  }
  const extracted = extractBalanced(repaired);
  return extracted ? tryParseJson(extracted) : undefined;
}

function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function parseLevelLabels(raw: string): LevelLabels | undefined {
  const parsed = parseJsonLoose(raw) ?? repairAndParse(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(record.nodes) && !Array.isArray(record.edges)) {
    return undefined;
  }
  const nodes: LevelNodeLabel[] = [];
  for (const entry of Array.isArray(record.nodes) ? record.nodes : []) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const node = entry as Record<string, unknown>;
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!id) {
      continue;
    }
    const label = clampText(node.label, MAX_LEVEL_LABEL_CHARS);
    const subtext = clampText(node.subtext, MAX_LEVEL_SUBTEXT_CHARS);
    if (!label && !subtext) {
      continue;
    }
    nodes.push({ id, ...(label ? { label } : {}), ...(subtext ? { subtext } : {}) });
  }
  const edges: LevelEdgeLabel[] = [];
  for (const entry of Array.isArray(record.edges) ? record.edges : []) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const edge = entry as Record<string, unknown>;
    const from = typeof edge.from === 'string' ? edge.from.trim() : '';
    const to = typeof edge.to === 'string' ? edge.to.trim() : '';
    const verb = clampText(edge.verb, MAX_LEVEL_VERB_CHARS);
    if (!from || !to || !verb || from === to) {
      continue;
    }
    edges.push({ from, to, verb });
  }
  if (nodes.length === 0 && edges.length === 0) {
    return undefined;
  }
  return { nodes, edges };
}

export function filterLevelLabels(node: ArchitectureNode, labels: LevelLabels): LevelLabels {
  const ids = new Set(node.children.map((child) => child.id));
  return {
    nodes: labels.nodes.filter((entry) => ids.has(entry.id)),
    edges: labels.edges.filter((entry) => ids.has(entry.from) && ids.has(entry.to)),
  };
}

export function buildLevelSummary(node: ArchitectureNode, facts: FileFacts[]): string {
  const root = facts.length > 0 ? commonRootOf(facts.map((file) => file.file)) : '';
  const roles = classifyLevelChildren(node.children, facts);
  const concepts = node.children.filter((child) => child.kind !== 'file');
  const nodeMap = new Map<string, string>();
  concepts.forEach((child, index) => {
    for (const file of child.files) {
      nodeMap.set(file, `n${index + 1}`);
    }
  });
  const lines = [`Level: ${node.label} (${node.kind}, ${node.files.length} files)`, 'Children:'];
  for (const child of node.children.slice(0, MAX_SUMMARY_CHILDREN)) {
    const samples = child.files
      .slice(0, MAX_SUMMARY_SAMPLES)
      .map((file) => relativePathOf(file, root) || file);
    lines.push(
      `- ${child.id} | ${child.files.length} files | label: ${child.label} | role: ${
        roles.get(child.id) ?? 'core'
      } | samples: ${samples.length > 0 ? samples.join(', ') : 'none'}`,
    );
  }
  const byId = new Map<string, string>();
  concepts.forEach((child, index) => byId.set(`n${index + 1}`, child.id));
  const relations = computeRelations(facts, nodeMap).slice(0, MAX_SUMMARY_EDGES);
  if (relations.length > 0) {
    lines.push('Edges:');
    for (const relation of relations) {
      const from = byId.get(relation.fromId);
      const to = byId.get(relation.toId);
      if (!from || !to) {
        continue;
      }
      lines.push(`- ${from} -> ${to} | ${relation.label} | ${relation.weight}`);
    }
  }
  return lines.join('\n');
}

export function levelSummaryHash(summary: string): string {
  return createHash('sha1').update(summary).digest('hex');
}

export function cachedLevelLabels(
  node: ArchitectureNode,
  facts: FileFacts[],
  cache: Map<string, LevelLabels | null>,
): LevelLabels | undefined {
  const cached = cache.get(levelSummaryHash(buildLevelSummary(node, facts)));
  return cached ? filterLevelLabels(node, cached) : undefined;
}

export interface InferLevelLabelsDeps {
  provider: LLMProvider | undefined;
  model: string;
  signal?: AbortSignal;
  cache?: Map<string, LevelLabels | null>;
}

export async function inferLevelLabels(
  node: ArchitectureNode,
  facts: FileFacts[],
  deps: InferLevelLabelsDeps,
): Promise<LevelLabels | undefined> {
  if (!deps.provider || node.children.length === 0) {
    return undefined;
  }
  const summary = buildLevelSummary(node, facts);
  const hash = levelSummaryHash(summary);
  if (deps.cache?.has(hash)) {
    const cached = deps.cache.get(hash);
    return cached ? filterLevelLabels(node, cached) : undefined;
  }
  try {
    const prompt: AiPrompt = { system: LEVEL_LABELS_SYSTEM, user: summary };
    const raw = await collectCompletion(
      deps.provider,
      deps.model,
      prompt,
      deps.signal ?? new AbortController().signal,
      LEVEL_LABELS_MAX_TOKENS,
    );
    const parsed = parseLevelLabels(raw);
    if (!parsed) {
      deps.cache?.set(hash, null);
      return undefined;
    }
    const filtered = filterLevelLabels(node, parsed);
    if (filtered.nodes.length === 0 && filtered.edges.length === 0) {
      deps.cache?.set(hash, null);
      return undefined;
    }
    deps.cache?.set(hash, filtered);
    return filtered;
  } catch {
    return undefined;
  }
}
