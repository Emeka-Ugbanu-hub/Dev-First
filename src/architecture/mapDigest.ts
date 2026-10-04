import type { FileFacts } from '../scan/duplication';

const MAX_DIGEST_CHARS = 6000;
const MAX_TREE_DEPTH = 3;
const MAX_ROUTE_LINES = 20;
const MAX_DATABASE_LINES = 10;
const MAX_EXTERNAL_LINES = 10;
const MAX_IPC_NAMES = 20;

const MANIFEST_BASENAMES = new Set([
  'package.json',
  'manifest.json',
  'cargo.toml',
  'go.mod',
  'pyproject.toml',
  'composer.json',
]);

const ENTRY_STEMS = new Set(['index', 'main', 'app', 'server', 'entry']);

const DATABASE_IMPORT =
  /(rusqlite|sqlx|prisma|sequelize|typeorm|mongoose|gorm\.io|pgx|java\.sql|hibernate)/i;
const EXTERNAL_CLIENT_IMPORT =
  /(reqwest|octocat|@octokit|@aws-sdk|stripe|twilio|sendgrid|@supabase|firebase)/i;

function decodePath(value: string): string {
  const trimmed = value.trim();
  if (!/^file:/i.test(trimmed)) {
    return trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(new URL(trimmed).pathname);
  } catch {
    decoded = trimmed.replace(/^file:\/\//i, '');
  }
  decoded = decoded.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^\/[A-Za-z]:\//.test(decoded)) {
    decoded = decoded.slice(1);
  }
  return decoded;
}

function baseName(value: string): string {
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}

function dirName(value: string): string {
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(0, index) : '';
}

function stemOf(base: string): string {
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(0, index) : base;
}

function relativePath(file: string, root: string): string {
  const path = decodePath(file);
  const rootPath = decodePath(root);
  if (!rootPath) {
    return path.replace(/^\/+/, '');
  }
  if (path === rootPath) {
    return '';
  }
  if (path.startsWith(`${rootPath}/`)) {
    return path.slice(rootPath.length + 1);
  }
  return path.replace(/^\/+/, '');
}

function folderTreeLines(facts: FileFacts[], root: string): string[] {
  const counts = new Map<string, number>();
  let rootFiles = 0;
  for (const fact of facts) {
    const relative = relativePath(fact.file, root);
    const segments = dirName(relative).split('/').filter(Boolean);
    if (segments.length === 0) {
      rootFiles++;
      continue;
    }
    const limit = Math.min(segments.length, MAX_TREE_DEPTH);
    for (let depth = 1; depth <= limit; depth++) {
      const key = segments.slice(0, depth).join('/');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const lines = [...counts.keys()]
    .sort()
    .map((key) => `- ${key}/ (${counts.get(key) ?? 0})`);
  if (rootFiles > 0) {
    lines.unshift(`- ./ (${rootFiles})`);
  }
  return lines;
}

function keyFileLines(facts: FileFacts[], root: string): string[] {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const relative = relativePath(fact.file, root);
    const base = baseName(relative);
    const segments = relative.split('/').filter(Boolean);
    const manifest = MANIFEST_BASENAMES.has(base.toLowerCase());
    const entry = ENTRY_STEMS.has(stemOf(base).toLowerCase()) && segments.length <= 2;
    if ((!manifest && !entry) || seen.has(relative)) {
      continue;
    }
    seen.add(relative);
    entries.push(relative);
  }
  entries.sort();
  return entries.map((entry) => `- ${entry}`);
}

function signalLines(facts: FileFacts[], root: string): string[] {
  const entryPoints: string[] = [];
  const routes: string[] = [];
  const ipcNames = new Set<string>();
  let ipcTotal = 0;
  const databases: string[] = [];
  const externals: string[] = [];

  for (const fact of facts) {
    const relative = relativePath(fact.file, root);
    const stem = stemOf(baseName(relative)).toLowerCase();
    if (ENTRY_STEMS.has(stem)) {
      entryPoints.push(relative);
    }
    for (const handler of fact.handlers) {
      if (handler.method === 'IPC') {
        ipcNames.add(handler.name);
        ipcTotal++;
        continue;
      }
      const label =
        [handler.method, handler.pathShape].filter(Boolean).join(' ') || handler.name;
      routes.push(`${label} -> ${relative}`);
    }
    for (const registration of fact.tauriCommandRegistrations ?? []) {
      ipcNames.add(registration.name);
      ipcTotal++;
    }
    if (
      fact.sql.length > 0 ||
      fact.imports.some((record) => DATABASE_IMPORT.test(record.specifier))
    ) {
      databases.push(`- Database: ${relative} (${fact.sql.length} queries)`);
    }
    if (
      fact.httpClients.length > 0 ||
      fact.imports.some((record) => EXTERNAL_CLIENT_IMPORT.test(record.specifier))
    ) {
      externals.push(`- External clients: ${relative}`);
    }
  }

  const lines: string[] = [];
  entryPoints.sort();
  if (entryPoints.length > 0) {
    lines.push(`- Entry points: ${entryPoints.join(', ')}`);
  }
  routes.sort();
  for (const route of routes.slice(0, MAX_ROUTE_LINES)) {
    lines.push(`- Routes: ${route}`);
  }
  const names = [...ipcNames].sort();
  if (ipcTotal > 0) {
    const shown = names.slice(0, MAX_IPC_NAMES).join(', ');
    const suffix = names.length > MAX_IPC_NAMES ? ', …' : '';
    lines.push(`- IPC commands: ${shown}${suffix} (${ipcTotal})`);
  }
  databases.sort();
  for (const line of databases.slice(0, MAX_DATABASE_LINES)) {
    lines.push(line);
  }
  externals.sort();
  for (const line of externals.slice(0, MAX_EXTERNAL_LINES)) {
    lines.push(line);
  }
  lines.push('- Workers/queues: none detected');
  return lines;
}

function truncateDigest(value: string): string {
  if (value.length <= MAX_DIGEST_CHARS) {
    return value;
  }
  const clipped = value.slice(0, MAX_DIGEST_CHARS);
  const lastNewline = clipped.lastIndexOf('\n');
  return (lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped).replace(/\s+$/, '');
}

export function buildMapDigest(facts: FileFacts[], root: string): string {
  const sections: string[] = [];
  const workspace = baseName(decodePath(root)) || 'workspace';
  sections.push(`Workspace: ${workspace}\nIndexed files: ${facts.length}`);

  const tree = folderTreeLines(facts, root);
  if (tree.length > 0) {
    sections.push(`Folder tree (folders only, files per folder):\n${tree.join('\n')}`);
  }

  const keyFiles = keyFileLines(facts, root);
  if (keyFiles.length > 0) {
    sections.push(`Key files:\n${keyFiles.join('\n')}`);
  }

  sections.push(`Signals:\n${signalLines(facts, root).join('\n')}`);
  return truncateDigest(sections.join('\n\n'));
}
