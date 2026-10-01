import type { FileFacts } from '../scan/duplication';
import { resolveArchitectureSpecifier } from '../scan/crossFile';
import type { ArchitectureNode } from './model';

export type LevelRole = 'entry' | 'storage' | 'output' | 'core';

const DB_DRIVER =
  /(^|[/@])(pg|mysql2?|sqlite3?|rusqlite|sqlx|diesel|libsql|better-sqlite3|prisma|sequelize|typeorm|knex|mongoose|mongodb|drizzle-orm|ioredis|redis)(\/|$)/i;

export function defaultFileToNode(children: ArchitectureNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const child of children) {
    for (const file of child.files) {
      if (!map.has(file)) {
        map.set(file, child.id);
      }
    }
  }
  return map;
}

export function classifyLevelChildren(
  children: ArchitectureNode[],
  facts: FileFacts[],
  fileToNode?: Map<string, string>,
): Map<string, LevelRole> {
  const factsByFile = new Map(facts.map((file) => [file.file, file]));
  const known = new Set(facts.map((file) => file.file));
  const ownerOf = fileToNode ?? defaultFileToNode(children);
  const roles = new Map<string, LevelRole>();
  const { incoming } = internalAdjacency(children, facts, ownerOf);
  for (const child of children) {
    const storage = child.files.some((file) =>
      (factsByFile.get(file)?.imports ?? []).some((entry) => DB_DRIVER.test(entry.specifier)),
    );
    const role: LevelRole = storage
      ? 'storage'
      : (incoming.get(child.id) ?? 0) === 0
        ? 'entry'
        : 'core';
    roles.set(child.id, role);
  }
  return roles;
}

function internalAdjacency(
  children: ArchitectureNode[],
  facts: FileFacts[],
  ownerOf: Map<string, string>,
): { adjacency: Map<string, Set<string>>; incoming: Map<string, number> } {
  const factsByFile = new Map(facts.map((file) => [file.file, file]));
  const known = new Set(facts.map((file) => file.file));
  const adjacency = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  for (const child of children) {
    adjacency.set(child.id, new Set());
    incoming.set(child.id, 0);
  }
  for (const child of children) {
    for (const file of child.files) {
      const record = factsByFile.get(file);
      if (!record) {
        continue;
      }
      for (const entry of record.imports) {
        const to = resolveArchitectureSpecifier(file, entry.specifier, known);
        if (!to || to === file) {
          continue;
        }
        const target = ownerOf.get(to);
        if (!target || target === child.id || !adjacency.has(target)) {
          continue;
        }
        const edges = adjacency.get(child.id);
        if (!edges || edges.has(target)) {
          continue;
        }
        edges.add(target);
        incoming.set(target, (incoming.get(target) ?? 0) + 1);
      }
      for (const module of record.rustModules ?? []) {
        const to = resolveArchitectureSpecifier(file, `self::${module.name}`, known);
        if (!to || to === file) continue;
        const target = ownerOf.get(to);
        if (!target || target === child.id || !adjacency.has(target)) continue;
        const edges = adjacency.get(child.id);
        if (!edges || edges.has(target)) continue;
        edges.add(target);
        incoming.set(target, (incoming.get(target) ?? 0) + 1);
      }
    }
  }
  return { adjacency, incoming };
}

function bfsDepth(
  adjacency: Map<string, Set<string>>,
  starts: string[],
): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const start of starts) {
    if (!depth.has(start)) {
      depth.set(start, 0);
      queue.push(start);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const next = (depth.get(current) ?? 0) + 1;
    for (const target of adjacency.get(current) ?? []) {
      if (!depth.has(target)) {
        depth.set(target, next);
        queue.push(target);
      }
    }
  }
  return depth;
}

export function orderLevel(
  children: ArchitectureNode[],
  facts: FileFacts[],
  fileToNode?: Map<string, string>,
): ArchitectureNode[] {
  if (children.length <= 1) {
    return [...children];
  }
  const ownerOf = fileToNode ?? defaultFileToNode(children);
  const roles = classifyLevelChildren(children, facts, ownerOf);
  const { adjacency, incoming } = internalAdjacency(children, facts, ownerOf);
  const entries = children.filter((child) => roles.get(child.id) === 'entry');
  let starts = entries.map((child) => child.id);
  if (starts.length === 0) {
    starts = children.filter((child) => (incoming.get(child.id) ?? 0) === 0).map((child) => child.id);
  }
  if (starts.length === 0) {
    starts = children.map((child) => child.id);
  }
  const depth = bfsDepth(adjacency, starts);
  const index = new Map(children.map((child, position) => [child.id, position]));
  const byDepth = (a: ArchitectureNode, b: ArchitectureNode): number =>
    (depth.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (depth.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
    (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
  const core = children.filter((child) => roles.get(child.id) === 'core').sort(byDepth);
  const storage = children.filter((child) => roles.get(child.id) === 'storage');
  const outputs = children.filter((child) => roles.get(child.id) === 'output');
  return [...entries, ...core, ...storage, ...outputs];
}
