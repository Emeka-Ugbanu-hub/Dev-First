import type { MapPaths, StructuredMap, StructuredNode } from './mapValidate';
import { escapeEdgeLabel } from './mapValidate';

export interface LevelBreadcrumb {
  label: string;
  path: string[];
}

export interface LevelView {
  mermaid: string;
  paths: MapPaths;
  groups: Record<string, string[]>;
  breadcrumbs: LevelBreadcrumb[];
}

function segmentsOf(node: StructuredNode): string[] {
  if (!node.group) {
    return [];
  }
  return node.group
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
}

const MAX_LEVEL_EDGES = 12;
const MAX_EDGE_LABEL = 22;

function clipEdgeLabel(label: string): string {
  const safe = escapeEdgeLabel(label);
  if (safe.length <= MAX_EDGE_LABEL) {
    return safe;
  }
  return `${safe.slice(0, MAX_EDGE_LABEL - 1).trimEnd()}…`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'group';
}

export function buildLevelView(
  map: StructuredMap,
  levelPath: string[],
  paths: MapPaths,
): LevelView {
  const prefix = levelPath.join('/');
  const inSubtree = (segments: string[]): boolean =>
    segments.slice(0, levelPath.length).join('/') === prefix;

  const bucketOf = new Map<string, string>();
  const childGroups = new Map<string, string>();
  const directNodes: StructuredNode[] = [];
  for (const node of map.nodes) {
    const segments = segmentsOf(node);
    if (!inSubtree(segments)) {
      continue;
    }
    if (segments.length === levelPath.length) {
      directNodes.push(node);
      bucketOf.set(node.id, `node:${node.id}`);
    } else {
      const childPath = segments.slice(0, levelPath.length + 1);
      const key = childPath.join('/');
      if (!childGroups.has(key)) {
        childGroups.set(key, childPath[childPath.length - 1] ?? key);
      }
      bucketOf.set(node.id, `group:${key}`);
    }
  }

  const idByBucket = new Map<string, string>();
  const groups: Record<string, string[]> = {};
  const groupLabels = new Map<string, string>();
  let groupIndex = 0;
  for (const [key, label] of childGroups) {
    const mermaidId = `grp${groupIndex++}`;
    idByBucket.set(`group:${key}`, mermaidId);
    groups[mermaidId] = key.split('/');
    groupLabels.set(`group:${key}`, label);
  }

  const lines = ['flowchart TD'];
  for (const node of directNodes) {
    lines.push(`  ${node.id}["${escapeLabel(node.label)}"]`);
  }
  for (const [key, mermaidId] of idByBucket) {
    lines.push(`  ${mermaidId}(["${escapeLabel(groupLabels.get(key) ?? key)}"])`);
  }

  const edgeAgg = new Map<string, { from: string; to: string; label: string; count: number }>();
  for (const edge of map.edges) {
    const fromBucket = bucketOf.get(edge.from);
    const toBucket = bucketOf.get(edge.to);
    if (!fromBucket || !toBucket || fromBucket === toBucket) {
      continue;
    }
    const from = idByBucket.get(fromBucket) ?? edge.from;
    const to = idByBucket.get(toBucket) ?? edge.to;
    const key = `${from}\u0000${to}`;
    const existing = edgeAgg.get(key);
    if (existing) {
      existing.count++;
      if (!existing.label && edge.label) {
        existing.label = edge.label;
      }
    } else {
      edgeAgg.set(key, { from, to, label: edge.label ?? '', count: 1 });
    }
  }
  const ranked = [...edgeAgg.values()].sort((a, b) => b.count - a.count);
  for (const edge of ranked.slice(0, MAX_LEVEL_EDGES)) {
    // Aggregation keeps the overview readable; it must not imply a source count.
    const label = edge.label ?? '';
    const safe = clipEdgeLabel(label);
    if (safe) {
      lines.push(`  ${edge.from} -->|${safe}| ${edge.to}`);
    } else {
      lines.push(`  ${edge.from} --> ${edge.to}`);
    }
  }

  const visiblePaths: MapPaths = {};
  for (const node of directNodes) {
    if (paths[node.id]) {
      visiblePaths[node.id] = paths[node.id];
    }
  }

  const breadcrumbs: LevelBreadcrumb[] = [{ label: 'Project', path: [] }];
  levelPath.forEach((segment, index) => {
    breadcrumbs.push({ label: segment, path: levelPath.slice(0, index + 1) });
  });

  return { mermaid: lines.join('\n'), paths: visiblePaths, groups, breadcrumbs };
}
