import type { MapPaths, StructuredMap, StructuredNode } from './mapValidate';
import { escapeEdgeLabel } from './mapValidate';

export interface LevelBreadcrumb {
  label: string;
  path: string[];
}

export type LevelKind = 'project' | 'layer' | 'files';

export interface LevelGroupItem {
  kind: 'group';
  id: string;
  label: string;
  path: string[];
  fileCount: number;
  routeCount: number;
}

export interface LevelLink {
  label: string;
  path?: string;
  groupPath?: string[];
  route?: boolean;
  system?: boolean;
  labels: string[];
  count: number;
}

export interface LevelFileItem {
  kind: 'file';
  id: string;
  label: string;
  path?: string;
  route: boolean;
  inCount: number;
  outCount: number;
  uses: LevelLink[];
  usedBy: LevelLink[];
}

export type LevelItem = LevelGroupItem | LevelFileItem;

export interface LevelRelated {
  label: string;
  path: string[];
  count: number;
  labels: string[];
}

export interface LevelSystemFile {
  label: string;
  path: string;
  labels: string[];
  count: number;
}

export interface LevelSystemTarget {
  label: string;
  path: string[];
  count: number;
  files: LevelSystemFile[];
}

export interface LevelView {
  mermaid: string;
  paths: MapPaths;
  groups: Record<string, string[]>;
  breadcrumbs: LevelBreadcrumb[];
  kind: LevelKind;
  items: LevelItem[];
  related: LevelRelated[];
  systemTargets: LevelSystemTarget[];
  hiddenEdges: number;
  totalEdges: number;
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

const MAX_OVERVIEW_EDGES = 12;
const MAX_DRILLDOWN_EDGES = 20;
const MAX_EDGE_LABEL = 22;
const MAX_LINKS = 8;

function edgeWeight(label: string): number {
  if (label.startsWith('message')) return 6;
  if (label.startsWith('handles')) return 5;
  if (label.startsWith('queries') || label.startsWith('calls')) return 4;
  if (label.startsWith('reads') || label.startsWith('writes') || label.startsWith('listens')) return 3;
  if (label.startsWith('imports')) return 1;
  return 2;
}

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

function uniqueLabels(labels: Set<string>): string[] {
  return [...labels].sort((a, b) => edgeWeight(b) - edgeWeight(a) || a.localeCompare(b));
}

function countLabel(fileCount: number, routeCount: number): string {
  if (routeCount > 0 && fileCount === 0) return `${routeCount} routes`;
  if (routeCount > 0) return `${fileCount} files · ${routeCount} routes`;
  return `${fileCount} files`;
}

export function buildLevelView(
  map: StructuredMap,
  levelPath: string[],
  paths: MapPaths,
): LevelView {
  const prefix = levelPath.join('/');
  const overview = levelPath.length === 0;
  const inSubtree = (segments: string[]): boolean =>
    segments.slice(0, levelPath.length).join('/') === prefix;

  const nodeById = new Map(map.nodes.map((node) => [node.id, node]));
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

  const filePathsByGroup = new Map<string, Set<string>>();
  const routeCountByGroup = new Map<string, number>();
  for (const node of map.nodes) {
    const segments = segmentsOf(node);
    if (segments.length <= levelPath.length || !inSubtree(segments)) {
      continue;
    }
    const key = segments.slice(0, levelPath.length + 1).join('/');
    if (node.id.startsWith('route_')) {
      routeCountByGroup.set(key, (routeCountByGroup.get(key) ?? 0) + 1);
    } else if (node.path) {
      const files = filePathsByGroup.get(key) ?? new Set<string>();
      files.add(node.path);
      filePathsByGroup.set(key, files);
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
    const fileCount = filePathsByGroup.get(key)?.size ?? 0;
    const routeCount = routeCountByGroup.get(key) ?? 0;
    groupLabels.set(`group:${key}`, `${label} (${countLabel(fileCount, routeCount)})`);
  }

  const edgeAgg = new Map<string, { from: string; to: string; label: string; count: number; labels: Set<string> }>();
  const relatedAgg = new Map<string, { label: string; path: string[]; count: number; labels: Set<string> }>();
  const systemAgg = new Map<string, {
    label: string;
    path: string[];
    count: number;
    labels: Set<string>;
    files: Map<string, LevelSystemFile>;
  }>();
  interface LinkAgg {
    label: string;
    path?: string;
    groupPath?: string[];
    route?: boolean;
    system?: boolean;
    labels: Set<string>;
    count: number;
  }
  const fileLinks = new Map<string, {
    inCount: number;
    outCount: number;
    uses: Map<string, LinkAgg>;
    usedBy: Map<string, LinkAgg>;
  }>();
  for (const node of directNodes) {
    fileLinks.set(node.id, { inCount: 0, outCount: 0, uses: new Map(), usedBy: new Map() });
  }

  const addLink = (
    links: Map<string, LinkAgg>,
    key: string,
    label: string,
    target: { path?: string; groupPath?: string[]; route?: boolean; system?: boolean; label: string },
  ): void => {
    const existing = links.get(key);
    if (existing) {
      existing.count++;
      existing.labels.add(label);
      return;
    }
    links.set(key, {
      label: target.label,
      ...(target.path ? { path: target.path } : {}),
      ...(target.groupPath ? { groupPath: target.groupPath } : {}),
      ...(target.route ? { route: true } : {}),
      ...(target.system ? { system: true } : {}),
      labels: new Set([label]),
      count: 1,
    });
  };

  const externalRef = (node: StructuredNode): { label: string; groupPath: string[]; system?: boolean } | undefined => {
    const segments = segmentsOf(node);
    if (segments.length === 0) return undefined;
    return {
      label: node.id.startsWith('system_') ? node.label : segments[segments.length - 1],
      groupPath: segments,
      ...(node.id.startsWith('system_') ? { system: true } : {}),
    };
  };

  for (const edge of map.edges) {
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (!fromNode || !toNode) {
      continue;
    }
    const fromInside = inSubtree(segmentsOf(fromNode));
    const toInside = inSubtree(segmentsOf(toNode));
    if (!fromInside && !toInside) {
      continue;
    }

    const systemNode = fromNode.id.startsWith('system_')
      ? fromNode
      : toNode.id.startsWith('system_')
        ? toNode
        : undefined;
    const systemOther = systemNode === fromNode ? toNode : systemNode === toNode ? fromNode : undefined;
    if (systemNode && systemOther) {
      const systemSegments = segmentsOf(systemNode);
      const otherSegments = segmentsOf(systemOther);
      if (inSubtree(systemSegments) || inSubtree(otherSegments)) {
        const key = systemSegments.join('/');
        const existing = systemAgg.get(key);
        const label = systemNode.label;
        let entry = existing;
        if (!entry) {
          entry = {
            label,
            path: systemSegments,
            count: 0,
            labels: new Set<string>(),
            files: new Map<string, LevelSystemFile>(),
          };
          systemAgg.set(key, entry);
        }
        entry.count++;
        entry.labels.add(edge.label ?? '');
        if (systemOther.path) {
          const fileKey = systemOther.path;
          const file = entry.files.get(fileKey);
          if (file) {
            file.count++;
            if (!file.labels.includes(edge.label ?? '')) file.labels.push(edge.label ?? '');
          } else {
            entry.files.set(fileKey, {
              label: systemOther.label,
              path: systemOther.path,
              labels: [edge.label ?? ''],
              count: 1,
            });
          }
        }
      }
    }

    const fromLink = fileLinks.get(edge.from);
    const toLink = fileLinks.get(edge.to);
    if (fromLink && toLink) {
      fromLink.outCount++;
      toLink.inCount++;
      addLink(fromLink.uses, `file:${edge.to}`, edge.label ?? '', {
        path: toNode.path,
        route: toNode.id.startsWith('route_'),
        ...(toNode.id.startsWith('system_') ? { system: true } : {}),
        label: toNode.label,
      });
      addLink(toLink.usedBy, `file:${edge.from}`, edge.label ?? '', {
        path: fromNode.path,
        route: fromNode.id.startsWith('route_'),
        ...(fromNode.id.startsWith('system_') ? { system: true } : {}),
        label: fromNode.label,
      });
    } else if (fromLink) {
      const target = externalRef(toNode);
      if (target) {
        fromLink.outCount++;
        addLink(fromLink.uses, `group:${target.groupPath.join('/')}`, edge.label ?? '', target);
      }
    } else if (toLink) {
      const target = externalRef(fromNode);
      if (target) {
        toLink.inCount++;
        addLink(toLink.usedBy, `group:${target.groupPath.join('/')}`, edge.label ?? '', target);
      }
    }

    if (fromInside && toInside) {
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
        existing.labels.add(edge.label ?? '');
        if (edgeWeight(edge.label ?? '') > edgeWeight(existing.label)) {
          existing.label = edge.label ?? '';
        }
      } else {
        edgeAgg.set(key, {
          from,
          to,
          label: edge.label ?? '',
          count: 1,
          labels: new Set([edge.label ?? '']),
        });
      }
      continue;
    }

    const externalNode = fromInside ? toNode : fromNode;
    if (externalNode.id.startsWith('system_')) {
      continue;
    }
    const segments = segmentsOf(externalNode);
    if (segments.length === 0) {
      continue;
    }
    const key = segments.join('/');
    if (key === prefix || childGroups.has(key)) {
      continue;
    }
    const existing = relatedAgg.get(key);
    const labels = new Set([edge.label ?? '']);
    if (existing) {
      existing.count++;
      for (const label of labels) existing.labels.add(label);
    } else {
      relatedAgg.set(key, {
        label: segments[segments.length - 1],
        path: segments,
        count: 1,
        labels,
      });
    }
  }

  const connectedIds = new Set<string>();
  for (const edge of edgeAgg.values()) {
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
  }

  const kind: LevelKind = overview
    ? 'project'
    : childGroups.size > 0
      ? 'layer'
      : 'files';

  const items: LevelItem[] = [];
  if (kind === 'files') {
    for (const node of directNodes) {
      const links = fileLinks.get(node.id);
      if (!links) continue;
      const toLevelLink = (link: LinkAgg): LevelLink => ({
        label: link.label,
        ...(link.path ? { path: link.path } : {}),
        ...(link.groupPath ? { groupPath: link.groupPath } : {}),
        ...(link.route ? { route: true } : {}),
        ...(link.system ? { system: true } : {}),
        labels: uniqueLabels(link.labels),
        count: link.count,
      });
      const byLinkWeight = (a: LinkAgg, b: LinkAgg): number =>
        b.count - a.count || edgeWeight([...b.labels][0] ?? '') - edgeWeight([...a.labels][0] ?? '');
      const uses = [...links.uses.values()]
        .sort(byLinkWeight)
        .slice(0, MAX_LINKS)
        .map(toLevelLink);
      const usedBy = [...links.usedBy.values()]
        .sort(byLinkWeight)
        .slice(0, MAX_LINKS)
        .map(toLevelLink);
      items.push({
        kind: 'file',
        id: node.id,
        label: node.label,
        ...(node.path ? { path: node.path } : {}),
        route: node.id.startsWith('route_'),
        inCount: links.inCount,
        outCount: links.outCount,
        uses,
        usedBy,
      });
    }
  } else {
    for (const [key, label] of childGroups) {
      const fileCount = filePathsByGroup.get(key)?.size ?? 0;
      const routeCount = routeCountByGroup.get(key) ?? 0;
      if (fileCount === 0 && routeCount === 0) {
        continue;
      }
      items.push({
        kind: 'group',
        id: key,
        label,
        path: key.split('/'),
        fileCount,
        routeCount,
      });
    }
  }

  const related: LevelRelated[] = [...relatedAgg.values()]
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((entry) => ({
      label: entry.label,
      path: entry.path,
      count: entry.count,
      labels: uniqueLabels(entry.labels),
    }));

  const systemTargets: LevelSystemTarget[] = [...systemAgg.values()]
    .filter((entry) => entry.files.size > 0)
    .sort((a, b) => b.count - a.count)
    .map((entry) => ({
      label: entry.label,
      path: entry.path,
      count: entry.count,
      files: [...entry.files.values()]
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
        .slice(0, MAX_LINKS)
        .map((file) => ({
          ...file,
          labels: uniqueLabels(new Set(file.labels)),
        })),
    }));

  const lines = ['flowchart TD'];
  const visibleNodeIds = new Set<string>();
  for (const node of directNodes) {
    if (overview && !(node.id === 'project' || node.id === 'root' || connectedIds.has(node.id))) {
      continue;
    }
    visibleNodeIds.add(node.id);
    lines.push(`  ${node.id}["${escapeLabel(node.label)}"]`);
  }
  for (const [key, mermaidId] of idByBucket) {
    lines.push(`  ${mermaidId}(["${escapeLabel(groupLabels.get(key) ?? key)}"])`);
  }

  const ranked = [...edgeAgg.values()].sort(
    (a, b) => edgeWeight(b.label) - edgeWeight(a.label) || b.count - a.count,
  );
  const limit = overview ? MAX_OVERVIEW_EDGES : MAX_DRILLDOWN_EDGES;
  const shown = ranked.slice(0, limit);
  for (const edge of shown) {
    const labels = uniqueLabels(edge.labels);
    const safe = clipEdgeLabel(labels[0] ?? '');
    if (safe) {
      lines.push(`  ${edge.from} -->|${safe}| ${edge.to}`);
    } else {
      lines.push(`  ${edge.from} --> ${edge.to}`);
    }
  }

  const visiblePaths: MapPaths = {};
  for (const node of directNodes) {
    if (visibleNodeIds.has(node.id) && paths[node.id]) {
      visiblePaths[node.id] = paths[node.id];
    }
  }

  const breadcrumbs: LevelBreadcrumb[] = [{ label: 'Project', path: [] }];
  levelPath.forEach((segment, index) => {
    breadcrumbs.push({ label: segment, path: levelPath.slice(0, index + 1) });
  });

  return {
    mermaid: lines.join('\n'),
    paths: visiblePaths,
    groups,
    breadcrumbs,
    kind,
    items,
    related,
    systemTargets,
    hiddenEdges: Math.max(0, ranked.length - shown.length),
    totalEdges: ranked.length,
  };
}
