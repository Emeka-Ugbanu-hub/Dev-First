import type { Memento } from 'vscode';
import * as path from 'node:path';
import { readStoredMap } from '../architecture/mapStore';
import type { StructuredNode } from '../architecture/mapValidate';

/**
 * Builds a small, request-specific view of the verified architecture map.
 *
 * This is deliberately deterministic: the model is only asked to interpret
 * the selected evidence, never to decide which parts of the repository are
 * relevant from an unbounded project dump.
 */
export function buildTaskEvidencePack(
  state: Pick<Memento, 'get'>,
  request: string,
  maxChars = 3600,
  workspaceRoot?: string,
): string | undefined {
  const stored = readStoredMap(state);
  if (!stored?.structured?.nodes?.length) return undefined;
  if (workspaceRoot && stored.workspaceRoot && path.resolve(stored.workspaceRoot) !== path.resolve(workspaceRoot)) {
    return undefined;
  }

  const terms = tokenize(request);
  const nodes = stored.structured.nodes;
  const edges = stored.structured.edges;
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const scored = nodes
    .filter((node) => node.id !== 'project')
    .map((node) => ({ node, score: scoreNode(node, terms, degree.get(node.id) ?? 0) }))
    .sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label));
  const selected = scored.slice(0, terms.length > 0 ? 14 : 10).map((item) => item.node);
  if (selected.length === 0) return undefined;

  const selectedIds = new Set(selected.map((node) => node.id));
  const selectedEdges = edges.filter((edge) =>
    selectedIds.has(edge.from) && selectedIds.has(edge.to),
  );
  const nodeLines = selected.map((node) => {
    const path = node.path ? ` — ${node.path}` : '';
    const group = node.group ? ` [${node.group}]` : '';
    return `- ${node.label}${group}${path}`;
  });
  const edgeLines = selectedEdges.slice(0, 24).map((edge) => {
    const from = labelFor(edge.from, nodes);
    const to = labelFor(edge.to, nodes);
    const evidence = edge.evidence?.[0];
    const at = evidence ? ` (${evidence.path}:${evidence.line})` : '';
    return `- ${from} --${edge.label || 'relates'}--> ${to}${at}`;
  });
  const body = [
    '[Verified task evidence — selected from the cached scanner map]',
    'Use these paths and relationships to choose the next targeted read. Do not treat labels as proof of behavior; verify with tools.',
    'Relevant nodes:',
    ...nodeLines,
    ...(edgeLines.length > 0 ? ['Relevant relationships:', ...edgeLines] : []),
  ].join('\n');
  const limit = Math.max(0, maxChars - 20);
  return body.length <= maxChars ? body : `${body.slice(0, limit)}\n… [evidence capped]`;
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_/-]+/).filter((term) => term.length >= 3))];
}

function scoreNode(node: StructuredNode, terms: string[], degree: number): number {
  const haystack = `${node.label} ${node.group ?? ''} ${node.path ?? ''}`.toLowerCase();
  const lexical = terms.reduce((score, term) => score + (haystack.includes(term) ? 8 : 0), 0);
  const entry = /(^|\/)(index|main|app|server|entry)\.[^.]+$/i.test(node.path ?? '') ? 3 : 0;
  return lexical + Math.min(6, degree) + entry;
}

function labelFor(id: string, nodes: StructuredNode[]): string {
  return nodes.find((node) => node.id === id)?.label || id;
}

