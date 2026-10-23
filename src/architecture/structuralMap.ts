import * as path from 'node:path';
import type { FileFacts } from '../scan/duplication';
import type { StructuredEdge, StructuredMap, StructuredNode } from './mapValidate';

export interface StructuralMapResult {
  map: StructuredMap;
  unresolvedRelationships: number;
  representedFiles: number;
}

function relativeFile(root: string, file: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return (relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : file).replace(/\\/g, '/').replace(/^\.\//, '');
}

function nodeId(value: string): string {
  return `file_${value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root'}`;
}

function labelFor(file: string): string {
  const base = path.basename(file);
  return base.replace(/\.[^.]+$/, '') || base;
}

function groupFor(file: string): string {
  const directory = path.posix.dirname(file);
  if (directory === '.') return 'Root';
  return directory.split('/').filter(Boolean).slice(0, 3).join('/');
}

function resolveImport(source: string, specifier: string, known: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
  const candidates = [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.rs', '.py', '.go', '.java'].map((ext) => `${base}${ext}`),
    ...['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'].map((name) => path.posix.join(base, name)),
  ];
  return candidates.find((candidate) => known.has(candidate));
}

/**
 * Builds a verified baseline without asking a model. Every node and import
 * edge comes from the scanner's indexed files and import records.
 */
export function buildStructuralMap(facts: FileFacts[], root: string, projectName: string): StructuralMapResult {
  const files = facts
    .map((fact) => ({ fact, file: relativeFile(root, fact.file) }))
    .filter((entry) => entry.file && !entry.file.startsWith('..'))
    .sort((a, b) => a.file.localeCompare(b.file));
  const known = new Set(files.map((entry) => entry.file));
  const nodes: StructuredNode[] = [{ id: 'project', label: projectName }];
  const nodeByFile = new Map<string, string>();
  for (const entry of files) {
    const id = nodeId(entry.file);
    nodeByFile.set(entry.file, id);
    nodes.push({ id, label: labelFor(entry.file), group: groupFor(entry.file), path: entry.file });
  }

  const edges: StructuredEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const entry of files) {
    const from = nodeByFile.get(entry.file);
    if (!from) continue;
    for (const imported of entry.fact.imports) {
      const targetFile = resolveImport(entry.file, imported.specifier, known);
      if (!targetFile) continue;
      const to = nodeByFile.get(targetFile);
      if (!to || from === to) continue;
      const key = `${from}\u0000${to}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({
        from,
        to,
        label: 'imports',
        evidence: [{ path: entry.file, line: imported.line }],
      });
    }
  }

  const entryStems = new Set(['index', 'main', 'app', 'server', 'entry']);
  for (const entry of files) {
    const stem = path.basename(entry.file).replace(/\.[^.]+$/, '').toLowerCase();
    const target = nodeByFile.get(entry.file);
    if (!target || !entryStems.has(stem)) continue;
    edges.push({ from: 'project', to: target, label: 'starts', evidence: [{ path: entry.file, line: 1 }] });
  }

  return {
    map: { nodes, edges },
    representedFiles: files.length,
    unresolvedRelationships: files.reduce((count, entry) => count + entry.fact.imports.filter((item) => item.specifier.startsWith('.') && !resolveImport(entry.file, item.specifier, known)).length, 0),
  };
}
