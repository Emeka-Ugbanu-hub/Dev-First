export interface MapPaths {
  [nodeId: string]: string;
}

export interface StructuredNode {
  id: string;
  label: string;
  group?: string;
  path?: string;
}

export interface StructuredEdge {
  from: string;
  to: string;
  label?: string;
}

export interface StructuredMap {
  nodes: StructuredNode[];
  edges: StructuredEdge[];
}

export interface ValidatedMap {
  mermaid: string;
  paths: MapPaths;
}

const MAX_NODES = 60;
const MAX_EDGES = 120;
const MAX_LABEL = 40;
const MAX_GROUP = 28;

function stripFences(raw: string): string {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length === 0 || !/^(```|~~~)/.test(lines[0].trim())) {
    return raw.trim();
  }
  lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length > 0 && /^(```|~~~)\s*$/.test(lines[lines.length - 1].trim())) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '');
}

function sanitizeId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function parseStructuredMap(raw: string): StructuredMap | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const text = stripFences(raw);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return undefined;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!data || !Array.isArray(data.nodes)) {
    return undefined;
  }
  const nodes: StructuredNode[] = [];
  const idMap = new Map<string, string>();
  for (const item of data.nodes) {
    if (nodes.length >= MAX_NODES) {
      break;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const rawId = typeof record.id === 'string' ? record.id.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim().slice(0, MAX_LABEL) : '';
    if (!rawId || !label || idMap.has(rawId)) {
      continue;
    }
    let id = sanitizeId(rawId);
    while ([...idMap.values()].includes(id)) {
      id = `${id}_`;
    }
    idMap.set(rawId, id);
    const node: StructuredNode = { id, label };
    if (typeof record.group === 'string' && record.group.trim()) {
      node.group = record.group.trim().slice(0, MAX_GROUP);
    }
    if (typeof record.path === 'string' && record.path.trim()) {
      node.path = normalizePath(record.path);
    }
    nodes.push(node);
  }
  if (nodes.length === 0) {
    return undefined;
  }
  const known = new Set(nodes.map((node) => node.id));
  const edges: StructuredEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const item of Array.isArray(data.edges) ? data.edges : []) {
    if (edges.length >= MAX_EDGES) {
      break;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const from = typeof record.from === 'string' ? idMap.get(record.from.trim()) : undefined;
    const to = typeof record.to === 'string' ? idMap.get(record.to.trim()) : undefined;
    if (!from || !to || from === to || !known.has(from) || !known.has(to)) {
      continue;
    }
    const label = typeof record.label === 'string' ? record.label.trim().slice(0, MAX_LABEL) : '';
    const key = `${from}\u0000${to}\u0000${label}`;
    if (edgeKeys.has(key)) {
      continue;
    }
    edgeKeys.add(key);
    edges.push(label ? { from, to, label } : { from, to });
  }
  return { nodes, edges };
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
}

export function buildMermaidMap(map: StructuredMap): string {
  const lines = ['flowchart TD'];
  const groups = new Map<string, StructuredNode[]>();
  const ungrouped: StructuredNode[] = [];
  for (const node of map.nodes) {
    if (node.group) {
      const list = groups.get(node.group);
      if (list) {
        list.push(node);
      } else {
        groups.set(node.group, [node]);
      }
    } else {
      ungrouped.push(node);
    }
  }
  for (const node of ungrouped) {
    lines.push(`  ${node.id}["${escapeLabel(node.label)}"]`);
  }
  let index = 0;
  for (const [group, nodes] of groups) {
    lines.push(`  subgraph g${index}["${escapeLabel(group)}"]`);
    for (const node of nodes) {
      lines.push(`    ${node.id}["${escapeLabel(node.label)}"]`);
    }
    lines.push('  end');
    index++;
  }
  for (const edge of map.edges) {
    if (edge.label) {
      lines.push(`  ${edge.from} -->|${escapeLabel(edge.label)}| ${edge.to}`);
    } else {
      lines.push(`  ${edge.from} --> ${edge.to}`);
    }
  }
  return lines.join('\n');
}

export function mapPathsOf(map: StructuredMap, exists: (relativePath: string) => boolean): MapPaths {
  const paths: MapPaths = {};
  for (const node of map.nodes) {
    if (node.path && exists(node.path)) {
      paths[node.id] = node.path;
    }
  }
  return paths;
}
