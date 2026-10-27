import * as path from 'node:path';
import type { FileFacts } from '../scan/duplication';
import type { StructuredEdge, StructuredMap, StructuredNode } from './mapValidate';

export interface StructuralMapResult {
  map: StructuredMap;
  unresolvedRelationships: number;
  representedFiles: number;
}

function relativeFile(root: string, file: string): string {
  let candidate = file.trim();
  if (/^file:/i.test(candidate)) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      candidate = candidate.replace(/^file:\/\//i, '');
    }
  }
  if (/^\/[A-Za-z]:\//.test(candidate)) {
    candidate = candidate.slice(1);
  }
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : candidate).replace(/\\/g, '/').replace(/^\.\//, '');
}

function nodeId(value: string): string {
  return `file_${value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root'}`;
}

const ENTRY_STEMS = new Set(['index', 'main', 'app', 'server', 'entry']);

function isSupportOnlyFile(file: string): boolean {
  const lower = file.toLowerCase();
  const base = path.posix.basename(lower);
  return /(^|\/)(__tests?|tests?|specs?|fixtures?|mocks?|__mocks__|snapshots?)(\/|$)/.test(lower)
    || /\.(test|spec)\.[^.]+$/.test(base)
    || /\.(d\.ts|snap)$/.test(base)
    || /(^|\/)(generated|coverage|dist|build|node_modules)(\/|$)/.test(lower)
    || /\.(generated|gen)\.[^.]+$/.test(base);
}

export function selectArchitectureFacts(facts: FileFacts[], root: string): FileFacts[] {
  return facts.filter((fact) => {
    const file = relativeFile(root, fact.file);
    if (!file || isSupportOnlyFile(file)) return false;
    const stem = path.posix.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
    if (ENTRY_STEMS.has(stem)) return true;
    if (fact.imports.length || fact.exports.length || fact.functions.length) return true;
    if (fact.handlers.length || fact.httpClients.length || fact.sql.length || fact.listeners.length) return true;
    return !/((^|\/)(config|configs|types|constants|styles?)(\/|$)|\.(json|ya?ml|toml|ini|css|scss|less)$)/i.test(file);
  });
}

function labelFor(file: string): string {
  const base = path.basename(file);
  return base.replace(/\.[^.]+$/, '') || base;
}

function semanticDomain(file: string, fact: FileFacts): string {
  const lower = file.toLowerCase();
  if (fact.sql.length > 0 || /(^|\/)(db|database|prisma|migrations?|repositories?)(\/|$)/.test(lower)) return 'Database';
  if (fact.handlers.length > 0 || fact.httpClients.length > 0 || /(^|\/)(api|server|routes?|controllers?|services?|middleware)(\/|$)/.test(lower)) return 'Backend';
  if (/(^|\/)(functions?|lambda|workers?|jobs?|queues?)(\/|$)/.test(lower)) return 'Functions';
  if (/(^|\/)(cloud|infra|infrastructure|deploy|terraform|\.github)(\/|$)/.test(lower)) return 'Cloud';
  if (/(components?|pages?|screens?|views?|hooks?|contexts?|ui|styles?)(\/|$)/.test(lower)) return 'Frontend';
  if (/\.(tsx?|jsx?|vue|svelte|astro|css|scss)$/.test(lower) && !/(config|types?|constants?)[/.]/.test(lower)) return 'Frontend';
  return 'Core';
}

function groupFor(file: string, fact: FileFacts): string {
  const domain = semanticDomain(file, fact);
  const directory = path.posix.dirname(file);
  const parts = directory === '.' ? [] : directory.split('/').filter(Boolean);
  const module = parts.filter((part) => !['src', 'app', 'lib', 'packages'].includes(part.toLowerCase())).slice(-1)[0];
  return module && module.toLowerCase() !== domain.toLowerCase() ? `${domain}/${module}` : domain;
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
    nodes.push({ id, label: labelFor(entry.file), group: groupFor(entry.file, entry.fact), path: entry.file });
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
    edges.push({ from: 'project', to: target, label: 'contains', evidence: [{ path: entry.file, line: 1 }] });
  }

  return {
    map: { nodes, edges },
    representedFiles: files.length,
    unresolvedRelationships: files.reduce((count, entry) => count + entry.fact.imports.filter((item) => item.specifier.startsWith('.') && !resolveImport(entry.file, item.specifier, known)).length, 0),
  };
}
