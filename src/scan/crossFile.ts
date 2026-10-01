import { execFile } from 'child_process';
import * as pathModule from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type {
  ConstantRecord,
  FileFacts,
  FunctionRecord,
  HandlerRecord,
  HttpCallRecord,
  HttpClientRecord,
  ListenerRecord,
  ModuleCacheRecord,
  StorageKeyRecord,
  TypeRecord,
} from './duplication';

export interface CrossFileIndex {
  files: FileFacts[];
}

export interface CrossFileRelated {
  file: string;
  line: number;
  message: string;
}

export interface CrossFileFinding {
  ruleId: string;
  category: 'bug' | 'smell' | 'architecture' | 'vulnerability';
  severity: 'warning' | 'info';
  message: string;
  file: string;
  line: number;
  related: CrossFileRelated[];
}

interface GraphEdge {
  to: string;
  line: number;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go', '.php'];
const ENTRY_NAMES = new Set([
  'index',
  'main',
  'app',
  'page',
  'route',
  'routes',
  'test',
  'tests',
  'spec',
  'config',
  'settings',
  'setup',
  'server',
  'cli',
  'entry',
  'bootstrap',
  'program',
  'module',
  'd',
]);
const FEATURE_FLAG = /^(is[A-Z]|enable|FF_|FEATURE_)/;
const HIGH_FANOUT = 8;
const LOW_FANOUT = 2;

export function shortName(file: string): string {
  const clean = file.replace(/^file:\/\//, '').replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

export function resolveSpecifier(
  from: string,
  specifier: string,
  known: Set<string>,
): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(specifier, from);
  } catch {
    return undefined;
  }
  url.hash = '';
  url.search = '';
  const direct = url.toString();
  if (known.has(direct)) {
    return direct;
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = new URL(`${direct}${extension}`).toString();
    if (known.has(candidate)) {
      return candidate;
    }
  }
  const base = direct.replace(/\/$/, '');
  for (const suffix of ['/index', '/__init__']) {
    const directory = `${base}${suffix}`;
    if (known.has(directory)) {
      return directory;
    }
    for (const extension of RESOLVE_EXTENSIONS) {
      const candidate = new URL(`${directory}${extension}`).toString();
      if (known.has(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function decodedFilePath(uri: string): string | undefined {
  try {
    if (!uri.startsWith('file:')) {
      return undefined;
    }
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function fileUri(path: string): string | undefined {
  try {
    return pathToFileURL(path).toString();
  } catch {
    return undefined;
  }
}

export function rustCrateRoot(from: string, known: Set<string>): string | undefined {
  const path = decodedFilePath(from);
  if (!path) {
    return undefined;
  }
  let directory = pathModule.dirname(path);
  while (directory) {
    const lib = fileUri(pathModule.join(directory, 'lib.rs'));
    const main = fileUri(pathModule.join(directory, 'main.rs'));
    if ((lib && known.has(lib)) || (main && known.has(main))) {
      return directory;
    }
    const parent = pathModule.dirname(directory);
    if (!parent || parent === directory) {
      break;
    }
    directory = parent;
  }
  return undefined;
}

function rustModuleBase(path: string): string {
  const directory = pathModule.dirname(path);
  const base = pathModule.basename(path);
  if (base === 'lib.rs' || base === 'main.rs' || base === 'mod.rs') {
    return directory;
  }
  const stem = pathModule.extname(base) ? pathModule.basename(base, pathModule.extname(base)) : base;
  return pathModule.join(directory, stem);
}

/** Resolves Rust crate/module paths against files already present in the scan index. */
export function resolveArchitectureSpecifier(
  from: string,
  specifier: string,
  known: Set<string>,
): string | undefined {
  const normal = resolveSpecifier(from, specifier, known);
  if (normal) {
    return normal;
  }
  if (!/^(crate|self|super)(?:::|$)/.test(specifier)) {
    return undefined;
  }
  const sourcePath = decodedFilePath(from);
  if (!sourcePath) {
    return undefined;
  }
  const crateRoot = rustCrateRoot(from, known);
  if (!crateRoot) {
    return undefined;
  }
  const parts = specifier.split('::');
  let base: string;
  if (parts[0] === 'crate') {
    base = crateRoot;
    parts.shift();
  } else {
    base = rustModuleBase(sourcePath);
    while (parts[0] === 'super') {
      base = base.slice(0, base.lastIndexOf('/'));
      parts.shift();
    }
    if (parts[0] === 'self') {
      parts.shift();
    }
  }
  if (parts.length === 0) {
    if (specifier === 'self') {
      return from;
    }
    for (const name of ['lib.rs', 'main.rs']) {
      const uri = fileUri(pathModule.join(crateRoot, name));
      if (uri && known.has(uri)) return uri;
    }
    return undefined;
  }
  for (let length = parts.length; length > 0; length--) {
    const modulePath = pathModule.join(base, ...parts.slice(0, length));
    const candidates = [modulePath, `${modulePath}.rs`, pathModule.join(modulePath, 'mod.rs')];
    for (const candidate of candidates) {
      const uri = fileUri(candidate);
      if (uri && known.has(uri)) {
        return uri;
      }
    }
  }
  return undefined;
}

function buildGraph(index: CrossFileIndex): Map<string, GraphEdge[]> {
  const known = new Set(index.files.map((file) => file.file));
  const graph = new Map<string, GraphEdge[]>();
  for (const file of index.files) {
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    for (const record of file.imports) {
      const to = resolveSpecifier(file.file, record.specifier, known);
      if (!to || to === file.file) {
        continue;
      }
      const key = `${to}\u0000${record.line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ to, line: record.line });
    }
    graph.set(file.file, edges);
  }
  return graph;
}

function importersOf(graph: Map<string, GraphEdge[]>): Map<string, Set<string>> {
  const importers = new Map<string, Set<string>>();
  for (const [from, edges] of graph) {
    for (const edge of edges) {
      let set = importers.get(edge.to);
      if (!set) {
        set = new Set();
        importers.set(edge.to, set);
      }
      set.add(from);
    }
  }
  return importers;
}

function normalizeCycle(cycle: string[]): string[] {
  let min = 0;
  for (let index = 1; index < cycle.length; index++) {
    if (cycle[index] < cycle[min]) {
      min = index;
    }
  }
  return [...cycle.slice(min), ...cycle.slice(0, min)];
}

function edgeLine(graph: Map<string, GraphEdge[]>, from: string, to: string): number {
  return graph.get(from)?.find((edge) => edge.to === to)?.line ?? 0;
}

export function findCircularImports(index: CrossFileIndex): CrossFileFinding[] {
  const graph = buildGraph(index);
  const nodes = [...graph.keys()].sort();
  const findings: CrossFileFinding[] = [];
  const seen = new Set<string>();
  const maxCycles = 200;

  const record = (cycle: string[]): void => {
    if (cycle.length < 2) {
      return;
    }
    const normalized = normalizeCycle(cycle);
    const key = normalized.join('\u0000');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const label = [...normalized, normalized[0]].map(shortName).join(' \u2192 ');
    for (let index = 0; index < normalized.length; index++) {
      const file = normalized[index];
      const next = normalized[(index + 1) % normalized.length];
      const related: CrossFileRelated[] = [];
      for (let other = 0; other < normalized.length; other++) {
        if (other === index) {
          continue;
        }
        const otherFile = normalized[other];
        const otherNext = normalized[(other + 1) % normalized.length];
        related.push({
          file: otherFile,
          line: edgeLine(graph, otherFile, otherNext),
          message: `Imports ${shortName(otherNext)}`,
        });
      }
      findings.push({
        ruleId: 'xf-circular-imports',
        category: 'bug',
        severity: 'warning',
        message: `Circular import: ${label}`,
        file,
        line: edgeLine(graph, file, next),
        related,
      });
    }
  };

  for (const start of nodes) {
    if (seen.size >= maxCycles) {
      break;
    }
    const path = [start];
    const visited = new Set([start]);
    const walk = (node: string): void => {
      if (seen.size >= maxCycles) {
        return;
      }
      for (const edge of graph.get(node) ?? []) {
        if (edge.to === start) {
          if (path.length >= 2) {
            record([...path]);
          }
          continue;
        }
        if (visited.has(edge.to) || edge.to < start) {
          continue;
        }
        visited.add(edge.to);
        path.push(edge.to);
        walk(edge.to);
        path.pop();
        visited.delete(edge.to);
      }
    };
    walk(start);
  }
  return findings;
}

export function findGodModules(index: CrossFileIndex, threshold = 15): CrossFileFinding[] {
  const graph = buildGraph(index);
  const importers = importersOf(graph);
  const findings: CrossFileFinding[] = [];
  for (const [file, set] of importers) {
    if (set.size <= threshold) {
      continue;
    }
    findings.push({
      ruleId: 'xf-god-modules',
      category: 'smell',
      severity: 'info',
      message: `Imported by ${set.size} files — consider splitting responsibilities`,
      file,
      line: 0,
      related: [...set]
        .sort()
        .slice(0, 10)
        .map((importer) => ({ file: importer, line: 0, message: 'Imports this module' })),
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

export function findDeepImportChains(index: CrossFileIndex, depth = 6): CrossFileFinding[] {
  const graph = buildGraph(index);
  const nodes = [...graph.keys()].sort();
  const findings: CrossFileFinding[] = [];
  const seen = new Set<string>();
  const maxChains = 100;
  const maxSteps = 20000;
  const limit = depth + 2;
  let steps = 0;

  for (const start of nodes) {
    if (findings.length >= maxChains || steps >= maxSteps) {
      break;
    }
    const path = [start];
    const visited = new Set([start]);
    const walk = (node: string): void => {
      if (findings.length >= maxChains || steps >= maxSteps) {
        return;
      }
      for (const edge of graph.get(node) ?? []) {
        if (steps++ >= maxSteps) {
          return;
        }
        if (visited.has(edge.to)) {
          continue;
        }
        path.push(edge.to);
        visited.add(edge.to);
        if (path.length >= limit) {
          const chain = [...path];
          const key = chain.join('\u0000');
          if (!seen.has(key)) {
            seen.add(key);
            const label = chain.map(shortName).join(' \u2192 ');
            for (let index = 0; index < chain.length; index++) {
              findings.push({
                ruleId: 'xf-deep-import-chains',
                category: 'smell',
                severity: 'info',
                message: `Import chain spans ${chain.length} files: ${label}`,
                file: chain[index],
                line:
                  index + 1 < chain.length
                    ? edgeLine(graph, chain[index], chain[index + 1])
                    : 0,
                related: chain
                  .filter((_file, other) => other !== index)
                  .map((other) => ({ file: other, line: 0, message: 'Part of the chain' })),
              });
            }
          }
        } else {
          walk(edge.to);
        }
        path.pop();
        visited.delete(edge.to);
      }
    };
    walk(start);
  }
  return findings;
}

export function findUnstableDependencies(index: CrossFileIndex): CrossFileFinding[] {
  const graph = buildGraph(index);
  const fanOut = new Map<string, number>();
  for (const [file, edges] of graph) {
    fanOut.set(file, edges.length);
  }
  const importers = importersOf(graph);
  const findings: CrossFileFinding[] = [];
  for (const [file, set] of importers) {
    if ((fanOut.get(file) ?? 0) <= HIGH_FANOUT) {
      continue;
    }
    const stable = [...set].filter((importer) => (fanOut.get(importer) ?? 0) <= LOW_FANOUT).sort();
    if (stable.length === 0) {
      continue;
    }
    findings.push({
      ruleId: 'xf-unstable-dependencies',
      category: 'smell',
      severity: 'info',
      message: `Depends on ${fanOut.get(file)} modules and is imported by stable file${
        stable.length === 1 ? '' : 's'
      } ${stable.map(shortName).join(', ')}`,
      file,
      line: 0,
      related: stable.map((importer) => ({
        file: importer,
        line: 0,
        message: `Low fan-out importer (${fanOut.get(importer) ?? 0})`,
      })),
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

function isEntryPoint(file: string): boolean {
  const base = shortName(file).toLowerCase();
  if (base.endsWith('.d.ts')) {
    return true;
  }
  if (/\.(test|spec)\.[a-z0-9]+$/.test(base)) {
    return true;
  }
  const stem = base.replace(/\.[a-z0-9]+$/, '');
  return ENTRY_NAMES.has(stem);
}

export function findOrphanedFiles(index: CrossFileIndex): CrossFileFinding[] {
  const graph = buildGraph(index);
  const imported = new Set<string>();
  for (const edges of graph.values()) {
    for (const edge of edges) {
      imported.add(edge.to);
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const file of index.files) {
    if (imported.has(file.file) || file.exports.length === 0 || isEntryPoint(file.file)) {
      continue;
    }
    findings.push({
      ruleId: 'xf-orphaned-files',
      category: 'smell',
      severity: 'info',
      message: `Nothing imports this file (${file.exports.length} export${
        file.exports.length === 1 ? '' : 's'
      })`,
      file: file.file,
      line: file.exports[0]?.line ?? 0,
      related: [],
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

export function findDeadExports(index: CrossFileIndex): CrossFileFinding[] {
  const known = new Set(index.files.map((file) => file.file));
  const used = new Map<string, Set<string>>();
  const wildcard = new Set<string>();
  for (const file of index.files) {
    for (const record of file.imports) {
      const to = resolveSpecifier(file.file, record.specifier, known);
      if (!to || to === file.file) {
        continue;
      }
      for (const name of record.names) {
        if (name === '*') {
          wildcard.add(to);
          continue;
        }
        let set = used.get(to);
        if (!set) {
          set = new Set();
          used.set(to, set);
        }
        set.add(name);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const file of index.files) {
    if (file.exports.length < 3 || wildcard.has(file.file)) {
      continue;
    }
    const names = used.get(file.file) ?? new Set<string>();
    for (const record of file.exports) {
      if (record.isDefault || record.name === 'default' || record.name.startsWith('_')) {
        continue;
      }
      if (names.has(record.name)) {
        continue;
      }
      findings.push({
        ruleId: 'xf-dead-exports',
        category: 'smell',
        severity: 'info',
        message: `Export "${record.name}" is never imported`,
        file: file.file,
        line: record.line,
        related: [],
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

interface PathInfo {
  prefix: string;
  dir: string;
  base: string;
  stem: string;
  ext: string;
}

function pathInfo(uri: string): PathInfo | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'file:') {
    return undefined;
  }
  const prefix = `${url.protocol}//${url.host}`;
  const pathname = url.pathname;
  const slash = pathname.lastIndexOf('/');
  const dir = slash >= 0 ? pathname.slice(0, slash) : '';
  const base = slash >= 0 ? pathname.slice(slash + 1) : pathname;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return { prefix, dir, base, stem, ext };
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function parentDir(dir: string): string {
  const index = dir.lastIndexOf('/');
  return index <= 0 ? '' : dir.slice(0, index);
}

export function isTestFile(uri: string): boolean {
  const info = pathInfo(uri);
  if (!info) {
    return false;
  }
  if (/\.(test|spec)$/i.test(info.stem)) {
    return true;
  }
  if (/^test_/.test(info.stem) || /_test$/.test(info.stem)) {
    return true;
  }
  if (/Test$/.test(info.stem) && info.ext === '.java') {
    return true;
  }
  return /(^|\/)__tests__$/.test(info.dir);
}

export function testTargets(uri: string): string[] {
  const info = pathInfo(uri);
  if (!info) {
    return [];
  }
  const targets = new Set<string>();
  const add = (dir: string, name: string): void => {
    if (name) {
      targets.add(`${info.prefix}${joinPath(dir, name)}`);
    }
  };
  const dir = info.dir;
  const parent = parentDir(dir);
  const testDir = /(^|\/)(__tests__|tests?)$/.test(dir);
  const dotted = /^(.*)\.(test|spec)$/i.exec(info.stem);
  if (dotted) {
    for (const extension of RESOLVE_EXTENSIONS) {
      add(dir, `${dotted[1]}${extension}`);
    }
    if (testDir) {
      for (const extension of RESOLVE_EXTENSIONS) {
        add(parent, `${dotted[1]}${extension}`);
      }
    }
    return [...targets];
  }
  if (/^test_/.test(info.stem)) {
    const name = info.stem.slice(5);
    for (const extension of RESOLVE_EXTENSIONS) {
      add(dir, `${name}${extension}`);
      add(parent, `${name}${extension}`);
    }
    return [...targets];
  }
  if (/_test$/.test(info.stem)) {
    const name = info.stem.slice(0, -5);
    for (const extension of RESOLVE_EXTENSIONS) {
      add(dir, `${name}${extension}`);
      add(parent, `${name}${extension}`);
    }
    return [...targets];
  }
  if (/Test$/.test(info.stem) && info.ext === '.java') {
    const name = info.stem.slice(0, -4);
    for (const extension of RESOLVE_EXTENSIONS) {
      add(dir, `${name}${extension}`);
    }
    return [...targets];
  }
  if (testDir) {
    for (const extension of RESOLVE_EXTENSIONS) {
      add(parent, `${info.stem}${extension}`);
    }
    if (/(^|\/)tests?$/.test(dir)) {
      const grand = parentDir(parent);
      for (const extension of RESOLVE_EXTENSIONS) {
        add(joinPath(grand, 'src'), `${info.stem}${extension}`);
      }
    }
    return [...targets];
  }
  return [];
}

export function adjacentTests(uri: string): string[] {
  const info = pathInfo(uri);
  if (!info || !info.ext) {
    return [];
  }
  const out = new Set<string>();
  const add = (dir: string, name: string): void => {
    out.add(`${info.prefix}${joinPath(dir, name)}`);
  };
  for (const extension of RESOLVE_EXTENSIONS) {
    add(info.dir, `${info.stem}.test${extension}`);
    add(info.dir, `${info.stem}.spec${extension}`);
    add(joinPath(info.dir, '__tests__'), `${info.stem}${extension}`);
  }
  add(joinPath(info.dir, '__tests__'), `${info.stem}.test${info.ext}`);
  add(info.dir, `test_${info.stem}${info.ext}`);
  add(info.dir, `${info.stem}_test${info.ext}`);
  if (info.ext === '.java') {
    add(info.dir, `${info.stem}Test${info.ext}`);
  }
  const parent = parentDir(info.dir);
  for (const extension of RESOLVE_EXTENSIONS) {
    for (const directory of ['test', 'tests', '__tests__']) {
      add(joinPath(parent, directory), `${info.stem}.test${extension}`);
      add(joinPath(parent, directory), `${info.stem}${extension}`);
    }
  }
  return [...out];
}

export function findOrphanedTests(index: CrossFileIndex): CrossFileFinding[] {
  const known = new Set(index.files.map((file) => file.file));
  const findings: CrossFileFinding[] = [];
  for (const file of index.files) {
    if (!isTestFile(file.file)) {
      continue;
    }
    const targets = testTargets(file.file);
    if (targets.length === 0 || targets.some((target) => known.has(target))) {
      continue;
    }
    findings.push({
      ruleId: 'xf-orphaned-tests',
      category: 'smell',
      severity: 'info',
      message: 'No matching source file found for this test',
      file: file.file,
      line: 0,
      related: [],
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

function namePrefix(stem: string): string | undefined {
  const snake = stem.includes('_') ? stem.split('_')[0] : '';
  if (snake.length >= 3) {
    return snake.toLowerCase();
  }
  const camel = /^([A-Za-z][a-z0-9]*)/.exec(stem)?.[1] ?? '';
  const normalized = camel.toLowerCase();
  return normalized.length >= 3 ? normalized : undefined;
}

export function findCoverageAsymmetry(index: CrossFileIndex): CrossFileFinding[] {
  const known = new Set(index.files.map((file) => file.file));
  const groups = new Map<string, string[]>();
  for (const file of index.files) {
    if (isTestFile(file.file)) {
      continue;
    }
    const info = pathInfo(file.file);
    if (!info || !info.ext) {
      continue;
    }
    const prefix = namePrefix(info.stem);
    if (!prefix) {
      continue;
    }
    const key = `${info.dir}\u0000${info.ext}\u0000${prefix}`;
    const list = groups.get(key);
    if (list) {
      list.push(file.file);
    } else {
      groups.set(key, [file.file]);
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const files of groups.values()) {
    if (files.length < 3) {
      continue;
    }
    const tested: string[] = [];
    const untested: string[] = [];
    for (const file of files) {
      if (adjacentTests(file).some((target) => known.has(target))) {
        tested.push(file);
      } else {
        untested.push(file);
      }
    }
    if (tested.length === 0 || untested.length === 0) {
      continue;
    }
    for (const file of untested.sort()) {
      findings.push({
        ruleId: 'xf-coverage-asymmetry',
        category: 'smell',
        severity: 'info',
        message: `No adjacent test while ${tested.length} sibling${
          tested.length === 1 ? '' : 's'
        } have one`,
        file,
        line: 0,
        related: tested.map((target) => ({
          file: target,
          line: 0,
          message: 'Has an adjacent test',
        })),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file));
}

function flagName(constant: ConstantRecord): string | undefined {
  if (FEATURE_FLAG.test(constant.name)) {
    return constant.name;
  }
  if (FEATURE_FLAG.test(constant.value)) {
    return constant.value;
  }
  return undefined;
}

export function findStaleFeatureFlags(index: CrossFileIndex): CrossFileFinding[] {
  if (index.files.length < 20) {
    return [];
  }
  const counts = new Map<string, Set<string>>();
  const candidates: Array<{ file: string; constant: ConstantRecord }> = [];
  for (const file of index.files) {
    for (const constant of file.constants) {
      const flag = flagName(constant);
      if (!flag) {
        continue;
      }
      let set = counts.get(flag);
      if (!set) {
        set = new Set();
        counts.set(flag, set);
      }
      set.add(file.file);
      candidates.push({ file: file.file, constant });
    }
  }
  const findings: CrossFileFinding[] = [];
  const emitted = new Set<string>();
  for (const { file, constant } of candidates) {
    const flag = flagName(constant);
    if (!flag || (counts.get(flag)?.size ?? 0) > 1) {
      continue;
    }
    const key = `${file}\u0000${flag}`;
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    findings.push({
      ruleId: 'xf-stale-feature-flags',
      category: 'smell',
      severity: 'info',
      message: `Feature flag "${flag}" is referenced in only one file`,
      file,
      line: constant.line,
      related: [],
    });
  }
  return findings;
}

function signatureParam(param: string): string {
  return param.replace(/\s+/g, '');
}

function signatureDrift(a: FunctionRecord, b: FunctionRecord): boolean {
  if (Math.abs(a.paramCount - b.paramCount) >= 1) {
    return true;
  }
  if (a.paramCount !== b.paramCount) {
    return false;
  }
  const left = a.params.map(signatureParam);
  const right = b.params.map(signatureParam);
  return left.some((value, index) => value !== right[index]);
}

export function findSignatureDrift(index: CrossFileIndex): CrossFileFinding[] {
  const byName = new Map<string, Array<{ file: string; fn: FunctionRecord }>>();
  for (const file of index.files) {
    for (const fn of file.functions ?? []) {
      if (!fn.exported || !fn.name) {
        continue;
      }
      const list = byName.get(fn.name);
      if (list) {
        list.push({ file: file.file, fn });
      } else {
        byName.set(fn.name, [{ file: file.file, fn }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [name, entries] of byName) {
    if (new Set(entries.map((entry) => entry.file)).size < 2) {
      continue;
    }
    for (const entry of entries) {
      const sibling = entries.find(
        (other) => other.file !== entry.file && signatureDrift(entry.fn, other.fn),
      );
      if (!sibling) {
        continue;
      }
      findings.push({
        ruleId: 'xf-signature-drift',
        category: 'smell',
        severity: 'info',
        message:
          entry.fn.paramCount === sibling.fn.paramCount
            ? `"${name}" parameters differ from ${shortName(sibling.file)}`
            : `"${name}" takes ${entry.fn.paramCount} parameter(s) here but ${sibling.fn.paramCount} in ${shortName(sibling.file)}`,
        file: entry.file,
        line: entry.fn.line,
        related: [
          {
            file: sibling.file,
            line: sibling.fn.line,
            message: `Declared with ${sibling.fn.paramCount} parameter(s)`,
          },
        ],
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findDuplicateTypeDefinitions(index: CrossFileIndex): CrossFileFinding[] {
  const byName = new Map<string, Array<{ file: string; type: TypeRecord }>>();
  for (const file of index.files) {
    for (const type of file.types ?? []) {
      if (type.name.length < 4 || /^[A-Z]$/.test(type.name)) {
        continue;
      }
      const list = byName.get(type.name);
      if (list) {
        list.push({ file: file.file, type });
      } else {
        byName.set(type.name, [{ file: file.file, type }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [name, entries] of byName) {
    const byFile = new Map<string, TypeRecord>();
    for (const entry of entries) {
      if (!byFile.has(entry.file)) {
        byFile.set(entry.file, entry.type);
      }
    }
    if (byFile.size < 2) {
      continue;
    }
    for (const [file, type] of byFile) {
      const others = [...byFile.entries()].filter(([other]) => other !== file);
      findings.push({
        ruleId: 'xf-duplicate-types',
        category: 'smell',
        severity: 'info',
        message: `"${name}" is declared in ${byFile.size} files (${type.kind})`,
        file,
        line: type.line,
        related: others.slice(0, 5).map(([other, otherType]) => ({
          file: other,
          line: otherType.line,
          message: `Declares "${name}" as ${otherType.kind}`,
        })),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findInterfaceImplementationDrift(index: CrossFileIndex): CrossFileFinding[] {
  const interfaces = new Map<string, Array<{ file: string; type: TypeRecord }>>();
  const classes: Array<{ file: string; type: TypeRecord }> = [];
  for (const file of index.files) {
    for (const type of file.types ?? []) {
      if (type.kind === 'interface' && type.methods.length > 0) {
        const list = interfaces.get(type.name);
        if (list) {
          list.push({ file: file.file, type });
        } else {
          interfaces.set(type.name, [{ file: file.file, type }]);
        }
      } else if (type.kind === 'class' && type.implements.length > 0) {
        classes.push({ file: file.file, type });
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [name, declarations] of interfaces) {
    const implementations = classes.filter((entry) => entry.type.implements.includes(name));
    if (implementations.length === 0) {
      continue;
    }
    const required = [...new Set(declarations.flatMap((entry) => entry.type.methods))];
    for (const implementation of implementations) {
      const missing = required.filter((method) => !implementation.type.methods.includes(method));
      if (missing.length === 0) {
        continue;
      }
      findings.push({
        ruleId: 'xf-interface-implementation-drift',
        category: 'smell',
        severity: 'info',
        message: `"${implementation.type.name}" implements "${name}" but is missing ${missing.length} method(s): ${missing.slice(0, 3).join(', ')}`,
        file: implementation.file,
        line: implementation.type.line,
        related: declarations.slice(0, 3).map((entry) => ({
          file: entry.file,
          line: entry.type.line,
          message: `Declares "${name}" with ${entry.type.methods.length} method(s)`,
        })),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]{3,}$/;

export function findDivergentConstants(index: CrossFileIndex): CrossFileFinding[] {
  const byName = new Map<string, Array<{ file: string; constant: ConstantRecord }>>();
  for (const file of index.files) {
    for (const constant of file.constants) {
      if (!UPPER_SNAKE.test(constant.name)) {
        continue;
      }
      const list = byName.get(constant.name);
      if (list) {
        list.push({ file: file.file, constant });
      } else {
        byName.set(constant.name, [{ file: file.file, constant }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [name, entries] of byName) {
    if (new Set(entries.map((entry) => entry.file)).size < 2) {
      continue;
    }
    if (new Set(entries.map((entry) => entry.constant.value)).size < 2) {
      continue;
    }
    const emitted = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.file}\u0000${name}`;
      if (emitted.has(key)) {
        continue;
      }
      emitted.add(key);
      const others = entries.filter(
        (other) => other.file !== entry.file && other.constant.value !== entry.constant.value,
      );
      if (others.length === 0) {
        continue;
      }
      const distinct = [...new Map(others.map((other) => [other.file, other])).values()];
      findings.push({
        ruleId: 'xf-divergent-constants',
        category: 'smell',
        severity: 'info',
        message: `${name} is ${entry.constant.value} here but ${distinct[0].constant.value} in ${shortName(distinct[0].file)}`,
        file: entry.file,
        line: entry.constant.line,
        related: distinct.slice(0, 5).map((other) => ({
          file: other.file,
          line: other.constant.line,
          message: `Defines ${name} = ${other.constant.value}`,
        })),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findMixedAsyncPatterns(index: CrossFileIndex): CrossFileFinding[] {
  const findings: CrossFileFinding[] = [];
  for (const file of index.files) {
    const functions = file.functions ?? [];
    const callbacks = functions.filter((fn) => fn.callbackStyle);
    const promises = functions.filter((fn) => fn.promiseStyle);
    if (callbacks.length < 2 || promises.length < 2) {
      continue;
    }
    const first = callbacks.reduce((min, fn) => (fn.line < min.line ? fn : min));
    const firstPromise = promises.reduce((min, fn) => (fn.line < min.line ? fn : min));
    findings.push({
      ruleId: 'xf-mixed-async-patterns',
      category: 'smell',
      severity: 'info',
      message: `File mixes callback-style (${callbacks.length}) and promise-style (${promises.length}) functions`,
      file: file.file,
      line: first.line,
      related: [
        {
          file: file.file,
          line: firstPromise.line,
          message: 'Promise-style function in the same file',
        },
      ],
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findDuplicateHttpClients(index: CrossFileIndex): CrossFileFinding[] {
  const byKind = new Map<string, Array<{ file: string; client: HttpClientRecord }>>();
  for (const file of index.files) {
    for (const client of file.httpClients ?? []) {
      const list = byKind.get(client.kind);
      if (list) {
        list.push({ file: file.file, client });
      } else {
        byKind.set(client.kind, [{ file: file.file, client }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [kind, entries] of byKind) {
    const byFile = new Map<string, HttpClientRecord>();
    for (const entry of entries) {
      if (!byFile.has(entry.file)) {
        byFile.set(entry.file, entry.client);
      }
    }
    if (byFile.size < 2) {
      continue;
    }
    if (new Set([...byFile.values()].map((client) => client.config)).size < 2) {
      continue;
    }
    for (const [file, client] of byFile) {
      const others = [...byFile.entries()].filter(([other]) => other !== file);
      findings.push({
        ruleId: 'xf-duplicate-http-clients',
        category: 'smell',
        severity: 'info',
        message: `HTTP client "${client.name}" (${kind}) is configured differently in ${others.length} sibling file(s)`,
        file,
        line: client.line,
        related: others.slice(0, 5).map(([other, otherClient]) => ({
          file: other,
          line: otherClient.line,
          message: `Uses ${kind} with ${(otherClient.config || 'default config').slice(0, 60)}`,
        })),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const NAMING_FAMILIES: Array<{ family: string; verbs: string[] }> = [
  { family: 'fetch', verbs: ['get', 'fetch', 'load', 'retrieve'] },
  { family: 'create', verbs: ['create', 'make', 'build', 'add'] },
];

function verbNoun(name: string): { family: string; verb: string; noun: string } | undefined {
  const match =
    /^(get|fetch|load|retrieve|create|make|build|add)([A-Z][A-Za-z0-9]*)$/.exec(name) ??
    /^(get|fetch|load|retrieve|create|make|build|add)_([a-z][a-z0-9_]*)$/.exec(name);
  if (!match) {
    return undefined;
  }
  const verb = match[1].toLowerCase();
  const family = NAMING_FAMILIES.find((entry) => entry.verbs.includes(verb))?.family;
  if (!family) {
    return undefined;
  }
  return { family, verb, noun: match[2].replace(/_/g, '').toLowerCase() };
}

export function conceptKey(name: string): string | undefined {
  const parsed = verbNoun(name);
  return parsed ? `${parsed.family}\u0000${parsed.noun}` : undefined;
}

export function findNamingDrift(index: CrossFileIndex): CrossFileFinding[] {
  const groups = new Map<string, Array<{ file: string; fn: FunctionRecord; verb: string }>>();
  for (const file of index.files) {
    for (const fn of file.functions ?? []) {
      if (!fn.exported) {
        continue;
      }
      const parsed = verbNoun(fn.name);
      if (!parsed) {
        continue;
      }
      const key = `${parsed.family}\u0000${parsed.noun}`;
      const list = groups.get(key);
      if (list) {
        list.push({ file: file.file, fn, verb: parsed.verb });
      } else {
        groups.set(key, [{ file: file.file, fn, verb: parsed.verb }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const entries of groups.values()) {
    const byFile = new Map<string, { fn: FunctionRecord; verb: string }>();
    for (const entry of entries) {
      if (!byFile.has(entry.file)) {
        byFile.set(entry.file, { fn: entry.fn, verb: entry.verb });
      }
    }
    if (byFile.size < 3) {
      continue;
    }
    if (new Set([...byFile.values()].map((entry) => entry.verb)).size < 2) {
      continue;
    }
    let emitted = 0;
    for (const [file, entry] of byFile) {
      if (emitted >= 3) {
        break;
      }
      emitted++;
      const others = [...byFile.entries()].filter(([other]) => other !== file);
      findings.push({
        ruleId: 'xf-naming-drift',
        category: 'smell',
        severity: 'info',
        message: `"${entry.fn.name}" — sibling files use ${[...new Set(others.map(([, other]) => other.verb))].join('/')} for the same concept`,
        file,
        line: entry.fn.line,
        related: others.slice(0, 3).map(([other, otherEntry]) => ({
          file: other,
          line: otherEntry.fn.line,
          message: `Exports "${otherEntry.fn.name}"`,
        })),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function handlerGroupKey(handler: HandlerRecord): string | undefined {
  if (!handler.method && !handler.pathShape) {
    return undefined;
  }
  return `${handler.method || 'ANY'}\u0000${handler.pathShape}`;
}

function findMissingSiblingFlag(
  index: CrossFileIndex,
  flag: 'hasAuth' | 'hasValidation',
  minSiblings: number,
): CrossFileFinding[] {
  const groups = new Map<string, Array<{ file: string; handler: HandlerRecord }>>();
  for (const file of index.files) {
    for (const handler of file.handlers ?? []) {
      const key = handlerGroupKey(handler);
      if (!key) {
        continue;
      }
      const list = groups.get(key);
      if (list) {
        list.push({ file: file.file, handler });
      } else {
        groups.set(key, [{ file: file.file, handler }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const entries of groups.values()) {
    const flagged = entries.filter((entry) => entry.handler[flag]);
    const flaggedFiles = new Set(flagged.map((entry) => entry.file));
    if (flaggedFiles.size < minSiblings) {
      continue;
    }
    const emitted = new Set<string>();
    for (const entry of entries) {
      if (entry.handler[flag] || emitted.has(entry.file)) {
        continue;
      }
      emitted.add(entry.file);
      const related: Array<{ file: string; handler: HandlerRecord }> = [];
      const seenRelated = new Set<string>();
      for (const other of flagged) {
        if (other.file === entry.file || seenRelated.has(other.file)) {
          continue;
        }
        seenRelated.add(other.file);
        related.push(other);
      }
      findings.push({
        ruleId: flag === 'hasAuth' ? 'xf-missing-sibling-auth' : 'xf-missing-sibling-validation',
        category: 'vulnerability',
        severity: 'warning',
        message:
          flag === 'hasAuth'
            ? `Handler "${entry.handler.name}" has no auth while ${flaggedFiles.size} sibling handler(s) do`
            : `Handler "${entry.handler.name}" has no validation while ${flaggedFiles.size} sibling handler(s) do`,
        file: entry.file,
        line: entry.handler.line,
        related: related.slice(0, 3).map((other) => ({
          file: other.file,
          line: other.handler.line,
          message: flag === 'hasAuth' ? 'Handler has auth' : 'Handler validates input',
        })),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findMissingSiblingAuth(index: CrossFileIndex): CrossFileFinding[] {
  return findMissingSiblingFlag(index, 'hasAuth', 2);
}

export function findMissingSiblingValidation(index: CrossFileIndex): CrossFileFinding[] {
  return findMissingSiblingFlag(index, 'hasValidation', 3);
}

export function findSqlTwinInconsistency(index: CrossFileIndex): CrossFileFinding[] {
  const parameterized = new Map<string, Array<{ file: string; line: number }>>();
  const concatenated: Array<{ file: string; line: number }> = [];
  for (const file of index.files) {
    for (const record of file.sql ?? []) {
      if (record.parameterized) {
        const directory = dirOf(file.file);
        const list = parameterized.get(directory);
        if (list) {
          list.push({ file: file.file, line: record.line });
        } else {
          parameterized.set(directory, [{ file: file.file, line: record.line }]);
        }
      }
      if (record.concatenated) {
        concatenated.push({ file: file.file, line: record.line });
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  const emitted = new Set<string>();
  for (const entry of concatenated) {
    if (emitted.has(entry.file)) {
      continue;
    }
    const twins = (parameterized.get(dirOf(entry.file)) ?? []).filter(
      (twin) => twin.file !== entry.file,
    );
    if (twins.length === 0) {
      continue;
    }
    emitted.add(entry.file);
    findings.push({
      ruleId: 'xf-sql-twin-inconsistency',
      category: 'vulnerability',
      severity: 'warning',
      message: `SQL string built by concatenation while ${twins.length} sibling file(s) use parameterized queries`,
      file: entry.file,
      line: entry.line,
      related: twins.slice(0, 3).map((twin) => ({
        file: twin.file,
        line: twin.line,
        message: 'Uses parameterized SQL',
      })),
    });
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findDuplicatedSecretsAcrossFiles(index: CrossFileIndex): CrossFileFinding[] {
  const byValue = new Map<string, Array<{ file: string; line: number }>>();
  for (const file of index.files) {
    for (const secret of file.secrets ?? []) {
      if (secret.value.length < 8) {
        continue;
      }
      const list = byValue.get(secret.value);
      if (list) {
        list.push({ file: file.file, line: secret.line });
      } else {
        byValue.set(secret.value, [{ file: file.file, line: secret.line }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const entries of byValue.values()) {
    const byFile = new Map<string, number>();
    for (const entry of entries) {
      if (!byFile.has(entry.file)) {
        byFile.set(entry.file, entry.line);
      }
    }
    if (byFile.size < 2) {
      continue;
    }
    for (const [file, line] of byFile) {
      const others = [...byFile.entries()].filter(([other]) => other !== file);
      findings.push({
        ruleId: 'xf-duplicated-secrets',
        category: 'vulnerability',
        severity: 'warning',
        message: `Secret-like literal is duplicated in ${byFile.size} files (also ${others
          .slice(0, 3)
          .map(([other]) => shortName(other))
          .join(', ')})`,
        file,
        line,
        related: others.slice(0, 3).map(([other, otherLine]) => ({
          file: other,
          line: otherLine,
          message: 'Same secret literal',
        })),
      });
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function normalizeStateName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function stateFinding(
  ruleId: string,
  category: CrossFileFinding['category'],
  severity: CrossFileFinding['severity'],
  message: string,
  file: string,
  line: number,
  related: CrossFileRelated[],
): CrossFileFinding {
  return { ruleId, category, severity, message, file, line, related };
}

export function findDuplicateStateStores(index: CrossFileIndex): CrossFileFinding[] {
  const findings: CrossFileFinding[] = [];
  const caches = new Map<string, Array<{ file: string; cache: ModuleCacheRecord }>>();
  for (const file of index.files) {
    for (const cache of file.moduleCaches ?? []) {
      const key = normalizeStateName(cache.name);
      if (key.length < 4) {
        continue;
      }
      const list = caches.get(key);
      if (list) {
        list.push({ file: file.file, cache });
      } else {
        caches.set(key, [{ file: file.file, cache }]);
      }
    }
  }
  for (const entries of caches.values()) {
    const byFile = new Map<string, ModuleCacheRecord>();
    for (const entry of entries) {
      if (!byFile.has(entry.file)) {
        byFile.set(entry.file, entry.cache);
      }
    }
    if (byFile.size < 2) {
      continue;
    }
    for (const [file, cache] of byFile) {
      const others = [...byFile.entries()].filter(([other]) => other !== file);
      findings.push(
        stateFinding(
          'xf-duplicate-state-stores',
          'smell',
          'info',
          `Module cache "${cache.name}" holds the same state as ${others.length} sibling file(s)`,
          file,
          cache.line,
          others.slice(0, 5).map(([other, otherCache]) => ({
            file: other,
            line: otherCache.line,
            message: `Also stores "${otherCache.name}"`,
          })),
        ),
      );
    }
  }
  const keys = new Map<string, Array<{ file: string; key: StorageKeyRecord }>>();
  for (const file of index.files) {
    for (const key of file.storageKeys ?? []) {
      const list = keys.get(key.key);
      if (list) {
        list.push({ file: file.file, key });
      } else {
        keys.set(key.key, [{ file: file.file, key }]);
      }
    }
  }
  for (const [name, entries] of keys) {
    const byFile = new Map<string, StorageKeyRecord>();
    for (const entry of entries) {
      if (!byFile.has(entry.file)) {
        byFile.set(entry.file, entry.key);
      }
    }
    if (byFile.size < 2) {
      continue;
    }
    for (const [file, key] of byFile) {
      const others = [...byFile.entries()].filter(([other]) => other !== file);
      findings.push(
        stateFinding(
          'xf-duplicate-state-stores',
          'smell',
          'info',
          `Storage key "${name}" is used in ${byFile.size} files`,
          file,
          key.line,
          others.slice(0, 5).map(([other, otherKey]) => ({
            file: other,
            line: otherKey.line,
            message: `Also uses "${name}"`,
          })),
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findSharedMutableState(index: CrossFileIndex): CrossFileFinding[] {
  const known = new Set(index.files.map((file) => file.file));
  const findings: CrossFileFinding[] = [];
  for (const file of index.files) {
    for (const state of file.mutableState ?? []) {
      if (!state.exported) {
        continue;
      }
      const writers: Array<{ file: string; line: number }> = [];
      for (const other of index.files) {
        if (other.file === file.file) {
          continue;
        }
        const imported = other.imports.some((record) => {
          const to = resolveSpecifier(other.file, record.specifier, known);
          return (
            to === file.file &&
            (record.names.includes(state.name) || record.names.includes('*'))
          );
        });
        if (!imported) {
          continue;
        }
        const write = (other.stateWrites ?? []).find((record) => record.name === state.name);
        if (write) {
          writers.push({ file: other.file, line: write.line });
        }
      }
      if (writers.length < 2) {
        continue;
      }
      findings.push(
        stateFinding(
          'xf-shared-mutable-state',
          'bug',
          'warning',
          `Exported mutable state "${state.name}" is written by ${writers.length} other files`,
          file.file,
          state.line,
          writers.slice(0, 5).map((writer) => ({
            file: writer.file,
            line: writer.line,
            message: `Writes "${state.name}"`,
          })),
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function memberSignature(type: TypeRecord): string {
  return [...type.members].sort().join('\u0000');
}

export function findEnumDrift(index: CrossFileIndex): CrossFileFinding[] {
  const byName = new Map<string, Array<{ file: string; type: TypeRecord }>>();
  for (const file of index.files) {
    for (const type of file.types ?? []) {
      const memberSet = type.kind === 'enum' || (type.members?.length ?? 0) > 0;
      if (!memberSet) {
        continue;
      }
      const list = byName.get(type.name);
      if (list) {
        list.push({ file: file.file, type });
      } else {
        byName.set(type.name, [{ file: file.file, type }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [name, entries] of byName) {
    const byFile = new Map<string, TypeRecord>();
    for (const entry of entries) {
      if (!byFile.has(entry.file)) {
        byFile.set(entry.file, entry.type);
      }
    }
    if (byFile.size < 2) {
      continue;
    }
    if (new Set([...byFile.values()].map(memberSignature)).size < 2) {
      continue;
    }
    for (const [file, type] of byFile) {
      const others = [...byFile.entries()].filter(
        ([other, otherType]) => other !== file && memberSignature(otherType) !== memberSignature(type),
      );
      if (others.length === 0) {
        continue;
      }
      findings.push(
        stateFinding(
          'xf-enum-drift',
          'smell',
          'info',
          `"${name}" has ${type.members.length} member(s) here but ${others[0][1].members.length} in ${shortName(others[0][0])}`,
          file,
          type.line,
          others.slice(0, 5).map(([other, otherType]) => ({
            file: other,
            line: otherType.line,
            message: `Members: ${otherType.members.slice(0, 6).join(', ') || '(none)'}`,
          })),
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function shapeSegments(shape: string): string[] {
  return shape.split('/').filter((segment) => segment.length > 0);
}

export function endpointShapesMatch(callShape: string, routeShape: string): boolean {
  const call = shapeSegments(callShape);
  const route = shapeSegments(routeShape);
  if (call.length !== route.length) {
    return false;
  }
  return call.every(
    (segment, index) => route[index] === segment || route[index] === ':p' || route[index] === ':n',
  );
}

export function endpointMethodsMatch(callMethod: string, routeMethod: string): boolean {
  return !callMethod || !routeMethod || callMethod === routeMethod;
}

export function findEndpointMismatch(index: CrossFileIndex): CrossFileFinding[] {
  const handlers: Array<{ file: string; handler: HandlerRecord }> = [];
  const calls: Array<{ file: string; call: HttpCallRecord }> = [];
  for (const file of index.files) {
    for (const handler of file.handlers ?? []) {
      if (handler.pathShape) {
        handlers.push({ file: file.file, handler });
      }
    }
    for (const call of file.httpCalls ?? []) {
      calls.push({ file: file.file, call });
    }
  }
  const findings: CrossFileFinding[] = [];
  if (handlers.length > 0) {
    for (const { file, call } of calls) {
      if (!call.path.startsWith('/')) {
        continue;
      }
      const matched = handlers.some(
        ({ handler }) =>
          endpointShapesMatch(call.pathShape, handler.pathShape) &&
          endpointMethodsMatch(call.method, handler.method),
      );
      if (matched) {
        continue;
      }
      findings.push(
        stateFinding(
          'xf-endpoint-mismatch',
          'bug',
          'warning',
          `HTTP ${call.method || 'call'} ${call.path} is called here but no route handler defines it`,
          file,
          call.line,
          [],
        ),
      );
    }
  }
  if (calls.length >= 10) {
    for (const { file, handler } of handlers) {
      const used = calls.some(
        ({ call }) =>
          call.path.startsWith('/') &&
          endpointShapesMatch(call.pathShape, handler.pathShape) &&
          endpointMethodsMatch(call.method, handler.method),
      );
      if (used) {
        continue;
      }
      findings.push(
        stateFinding(
          'xf-unused-endpoint',
          'smell',
          'info',
          `Route ${handler.method || 'ANY'} ${handler.pathShape} is never called by an indexed HTTP call site`,
          file,
          handler.line,
          [],
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findUnboundedCaches(index: CrossFileIndex): CrossFileFinding[] {
  const findings: CrossFileFinding[] = [];
  for (const file of index.files) {
    for (const cache of file.moduleCaches ?? []) {
      if (cache.evicted) {
        continue;
      }
      findings.push(
        stateFinding(
          'xf-unbounded-caches',
          'smell',
          'info',
          `"${cache.name}" (${cache.kind}) is written but never deleted, cleared, or evicted in this file`,
          file.file,
          cache.line,
          [],
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findListenerLeaks(index: CrossFileIndex): CrossFileFinding[] {
  const findings: CrossFileFinding[] = [];
  for (const file of index.files) {
    const listeners: ListenerRecord[] = file.listeners ?? [];
    const removed = new Set(
      listeners.filter((listener) => listener.kind === 'remove').map((listener) => listener.event),
    );
    const emitted = new Set<string>();
    for (const listener of listeners) {
      if (listener.kind !== 'add' || !listener.literal) {
        continue;
      }
      if (removed.has(listener.event) || emitted.has(listener.event)) {
        continue;
      }
      emitted.add(listener.event);
      findings.push(
        stateFinding(
          'xf-listener-leaks',
          'bug',
          'warning',
          `Listener for "${listener.event}" is added but never removed in this file`,
          file.file,
          listener.line,
          [],
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findOrphanedStorageKeys(index: CrossFileIndex): CrossFileFinding[] {
  const byKey = new Map<
    string,
    { reads: Array<{ file: string; line: number }>; writes: Array<{ file: string; line: number }> }
  >();
  for (const file of index.files) {
    for (const record of file.storageKeys ?? []) {
      let sites = byKey.get(record.key);
      if (!sites) {
        sites = { reads: [], writes: [] };
        byKey.set(record.key, sites);
      }
      const target = record.access === 'read' ? sites.reads : sites.writes;
      target.push({ file: file.file, line: record.line });
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [key, sites] of byKey) {
    const orphaned =
      sites.writes.length > 0 && sites.reads.length === 0
        ? { records: sites.writes, message: `Storage key "${key}" is written but never read in the indexed workspace` }
        : sites.reads.length > 0 && sites.writes.length === 0
          ? { records: sites.reads, message: `Storage key "${key}" is read but never written in the indexed workspace` }
          : undefined;
    if (!orphaned) {
      continue;
    }
    const emitted = new Set<string>();
    for (const record of orphaned.records) {
      if (emitted.has(record.file)) {
        continue;
      }
      emitted.add(record.file);
      findings.push(
        stateFinding(
          'xf-orphaned-storage-keys',
          'smell',
          'info',
          orphaned.message,
          record.file,
          record.line,
          [],
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function findPoolingInconsistency(index: CrossFileIndex): CrossFileFinding[] {
  const topLevel = new Map<string, Array<{ file: string; client: HttpClientRecord }>>();
  const scoped = new Map<string, Array<{ file: string; client: HttpClientRecord }>>();
  for (const file of index.files) {
    for (const client of file.httpClients ?? []) {
      const list = topLevel.get(client.kind);
      if (list) {
        list.push({ file: file.file, client });
      } else {
        topLevel.set(client.kind, [{ file: file.file, client }]);
      }
    }
    for (const client of file.scopedHttpClients ?? []) {
      const list = scoped.get(client.kind);
      if (list) {
        list.push({ file: file.file, client });
      } else {
        scoped.set(client.kind, [{ file: file.file, client }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [kind, entries] of scoped) {
    const topFiles = [...new Set((topLevel.get(kind) ?? []).map((entry) => entry.file))];
    if (topFiles.length === 0) {
      continue;
    }
    const emitted = new Set<string>();
    for (const entry of entries) {
      if (emitted.has(entry.file)) {
        continue;
      }
      const siblings = topFiles.filter((file) => file !== entry.file);
      if (siblings.length === 0) {
        continue;
      }
      emitted.add(entry.file);
      findings.push(
        stateFinding(
          'xf-pooling-inconsistency',
          'smell',
          'info',
          `Creates a new ${kind} client per call while ${siblings.length} sibling file(s) share one`,
          entry.file,
          entry.client.line,
          siblings.slice(0, 5).map((file) => ({
            file,
            line: 0,
            message: `Creates one ${kind} client at module level`,
          })),
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const TTL_CONSTANT = /(TTL|MAX_CACHE|EXPIRY|TIMEOUT_MS|MAX_RETRIES)/i;

export function findTtlDrift(index: CrossFileIndex): CrossFileFinding[] {
  const byName = new Map<string, Array<{ file: string; constant: ConstantRecord }>>();
  for (const file of index.files) {
    for (const constant of file.constants) {
      if (!TTL_CONSTANT.test(constant.name)) {
        continue;
      }
      const list = byName.get(constant.name);
      if (list) {
        list.push({ file: file.file, constant });
      } else {
        byName.set(constant.name, [{ file: file.file, constant }]);
      }
    }
  }
  const findings: CrossFileFinding[] = [];
  for (const [name, entries] of byName) {
    const byFile = new Map<string, ConstantRecord>();
    for (const entry of entries) {
      if (!byFile.has(entry.file)) {
        byFile.set(entry.file, entry.constant);
      }
    }
    if (byFile.size < 3) {
      continue;
    }
    if (new Set([...byFile.values()].map((constant) => constant.value)).size < 2) {
      continue;
    }
    for (const [file, constant] of byFile) {
      const others = [...byFile.entries()].filter(
        ([other, otherConstant]) => other !== file && otherConstant.value !== constant.value,
      );
      if (others.length === 0) {
        continue;
      }
      findings.push(
        stateFinding(
          'xf-ttl-drift',
          'smell',
          'info',
          `${name} is ${constant.value} here but ${others[0][1].value} in ${shortName(others[0][0])} (${byFile.size} files define it)`,
          file,
          constant.line,
          others.slice(0, 5).map(([other, otherConstant]) => ({
            file: other,
            line: otherConstant.line,
            message: `Defines ${name} = ${otherConstant.value}`,
          })),
        ),
      );
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export interface ShotgunOptions {
  maxCommits?: number;
  minTogether?: number;
}

function dirOf(file: string): string {
  const index = file.lastIndexOf('/');
  return index <= 0 ? '' : file.slice(0, index);
}

export function parseShotgunLog(output: string, minTogether = 5): CrossFileFinding[] {
  const commits: string[][] = [];
  let current: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (line === '__DF_COMMIT__') {
      if (current.length > 0) {
        commits.push(current);
      }
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    commits.push(current);
  }
  const counts = new Map<string, number>();
  for (const files of commits) {
    const unique = [...new Set(files)].sort();
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = `${unique[i]}\u0000${unique[j]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs = [...counts.entries()]
    .filter(([, count]) => count > minTogether)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200);
  const findings: CrossFileFinding[] = [];
  for (const [key, count] of pairs) {
    const [a, b] = key.split('\u0000');
    if (!a || !b || dirOf(a) === dirOf(b)) {
      continue;
    }
    findings.push({
      ruleId: 'xf-shotgun-surgery',
      category: 'smell',
      severity: 'info',
      message: `Changes together with ${shortName(b)} in ${count} commits`,
      file: a,
      line: 0,
      related: [{ file: b, line: 0, message: `Changed together ${count} times` }],
    });
    findings.push({
      ruleId: 'xf-shotgun-surgery',
      category: 'smell',
      severity: 'info',
      message: `Changes together with ${shortName(a)} in ${count} commits`,
      file: b,
      line: 0,
      related: [{ file: a, line: 0, message: `Changed together ${count} times` }],
    });
  }
  return findings;
}

function runGitLog(repoRoot: string, maxCommits: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['log', '--name-only', '--pretty=format:__DF_COMMIT__', '-n', String(maxCommits)],
      { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024, timeout: 10000 },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

export async function findShotgunSurgery(
  repoRoot: string,
  options: ShotgunOptions = {},
): Promise<CrossFileFinding[]> {
  const maxCommits = Math.max(1, Math.min(options.maxCommits ?? 200, 500));
  const minTogether = Math.max(2, options.minTogether ?? 5);
  let output: string;
  try {
    output = await runGitLog(repoRoot, maxCommits);
  } catch {
    return [];
  }
  return parseShotgunLog(output, minTogether);
}
