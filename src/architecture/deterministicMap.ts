import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { FileFacts } from '../scan/duplication';
import { resolveArchitectureSpecifier, resolveSpecifier } from '../scan/crossFile';
import type { StructuredEdge, StructuredMap, StructuredNode } from './mapValidate';

export const ARCHITECTURE_LAYERS = [
  'Frontend',
  'Backend',
  'Services',
  'Data',
  'Integration',
  'Utils',
  'Config',
  'Unclassified',
] as const;

export type ArchitectureLayer = (typeof ARCHITECTURE_LAYERS)[number];

export interface DeterministicMapResult {
  map: StructuredMap;
  representedFiles: number;
  unresolvedRelationships: number;
  isolatedFiles: number;
  unclassifiedFiles: number;
  fingerprint: string;
}

interface FileEntry {
  fact: FileFacts;
  relative: string;
  id: string;
  layer: ArchitectureLayer;
  module: string;
}

function absolutePath(value: string, root: string): string | undefined {
  try {
    if (/^file:/i.test(value)) {
      return fileURLToPath(value);
    }
    return path.resolve(root, value);
  } catch {
    return undefined;
  }
}

function relativeFile(root: string, value: string): string {
  const absolute = absolutePath(value, root);
  if (!absolute) {
    return value.replace(/\\/g, '/');
  }
  const relative = path.relative(path.resolve(root), absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, '/')
    : value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
}

function title(value: string): string {
  return value
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function labelFor(relative: string): string {
  const base = path.posix.basename(relative);
  const stem = base.replace(/\.[^.]+$/, '');
  if (/^(index|main|mod)$/i.test(stem)) {
    const parent = path.posix.dirname(relative);
    return path.posix.basename(parent) || stem;
  }
  return stem;
}

function frontendModule(relative: string): string {
  const rest = relative.replace(/^webview\/src\//, '');
  const base = path.posix.basename(rest);
  const stem = base.replace(/\.[^.]+$/, '');
  if (rest.startsWith('lib/')) return 'UI Utilities';
  if (rest === 'main.tsx' || rest === 'vscode.ts') return 'Shell';
  if (rest === 'App.tsx') return 'State & Context';
  if (rest.startsWith('components/')) {
    if (/context|state|header|status|thinking|sessiontab|promptrail|revertbanner/i.test(stem)) {
      return 'State & Context';
    }
    if (/chatview|renderboundary/i.test(stem)) return 'Shell';
    return 'Components';
  }
  return 'Shell';
}

function pathSegments(relative: string): string[] {
  return relative.toLowerCase().split('/').filter(Boolean);
}

function directorySegments(relative: string): string[] {
  const segments = pathSegments(relative);
  return segments.slice(0, -1);
}

function stemOf(relative: string): string {
  return path.posix.basename(relative).replace(/\.[^.]+$/, '').toLowerCase();
}

function titleModule(value: string): string {
  if (value === 'ui') return 'UI';
  if (value === 'ipc') return 'IPC';
  if (value === 'api') return 'API';
  return title(value);
}

interface Placement {
  layer: ArchitectureLayer;
  module: string;
}

const FRONTEND_FOLDERS: Record<string, string> = {
  components: 'Components',
  component: 'Components',
  views: 'Views',
  view: 'Views',
  screens: 'Screens',
  screen: 'Screens',
  pages: 'Pages',
  page: 'Pages',
  app: 'App',
  ui: 'UI',
  hooks: 'Hooks',
  hook: 'Hooks',
  contexts: 'Contexts',
  context: 'Contexts',
  layouts: 'Layouts',
  layout: 'Layouts',
  styles: 'Styles',
  state: 'State',
  frontend: 'Frontend',
  renderer: 'Renderer',
  client: 'Client',
};

const BACKEND_FOLDERS: Record<string, string> = {
  api: 'API',
  server: 'Server',
  backend: 'Backend',
  controllers: 'Handlers',
  controller: 'Handlers',
  handlers: 'Handlers',
  handler: 'Handlers',
  endpoints: 'Routes',
  endpoint: 'Routes',
  resolvers: 'Resolvers',
  resolver: 'Resolvers',
  middleware: 'Middleware',
  ipc: 'IPC',
  actions: 'Actions',
  trpc: 'TRPC',
};

const SERVICE_FOLDERS: Record<string, string> = {
  services: 'Services',
  service: 'Services',
  domain: 'Domain',
  core: 'Core',
  agent: 'Agent',
  agents: 'Agents',
  workers: 'Workers',
  worker: 'Workers',
  jobs: 'Jobs',
  job: 'Jobs',
  usecases: 'Use Cases',
  'use-cases': 'Use Cases',
  queues: 'Queues',
  queue: 'Queues',
  emails: 'Emails',
  email: 'Emails',
  events: 'Events',
  tasks: 'Tasks',
  task: 'Tasks',
};

const DATA_FOLDERS: Record<string, string> = {
  db: 'Database',
  database: 'Database',
  databases: 'Database',
  models: 'Models',
  model: 'Models',
  repositories: 'Repositories',
  repository: 'Repositories',
  repos: 'Repositories',
  repo: 'Repositories',
  migrations: 'Migrations',
  migration: 'Migrations',
  prisma: 'Prisma',
  drizzle: 'Drizzle',
  stores: 'Stores',
  store: 'Stores',
  storage: 'Storage',
  persistence: 'Persistence',
};

const INTEGRATION_FOLDERS: Record<string, string> = {
  integrations: 'Integrations',
  integration: 'Integrations',
  adapters: 'Adapters',
  adapter: 'Adapters',
  external: 'External',
  mcp: 'MCP',
  llm: 'LLM',
  http: 'HTTP',
  gateways: 'Gateways',
  gateway: 'Gateways',
  clients: 'Clients',
};

const UTILITY_FOLDERS: Record<string, string> = {
  utils: 'Utilities',
  util: 'Utilities',
  shared: 'Shared',
  common: 'Common',
  helpers: 'Helpers',
  helper: 'Helpers',
  lib: 'Lib',
  types: 'Types',
  constants: 'Constants',
  contracts: 'Contracts',
  schemas: 'Schemas',
  schema: 'Schemas',
  validators: 'Validators',
  validator: 'Validators',
  scripts: 'Scripts',
  script: 'Scripts',
  tools: 'Tools',
  tool: 'Tools',
  bin: 'Bin',
};

const CONFIG_FOLDERS: Record<string, string> = {
  config: 'Settings',
  configs: 'Settings',
  settings: 'Settings',
  env: 'Settings',
  environments: 'Settings',
  configuration: 'Settings',
};

const BACKEND_CONTEXT = new Set([
  'api', 'server', 'backend', 'services', 'service', 'controllers', 'controller',
  'handlers', 'handler', 'endpoints', 'endpoint', 'resolvers', 'resolver',
]);
const INTEGRATION_CONTEXT = new Set([
  'integrations', 'integration', 'adapters', 'adapter', 'external', 'clients',
]);
const ORM_IMPORT = /(^|\/)(@prisma\/client|prisma|drizzle-orm|mongoose|sequelize|typeorm|knex|pg|mysql2|better-sqlite3|@supabase)/i;
const SERVER_IMPORT = /(^|\/)(express|fastify|koa|hono|@nestjs|bullmq|ioredis|redis)/i;
const UI_IMPORT = /(^|\/)(react|react-dom|next|vue|svelte|@angular\/core|solid-js|preact)/i;

function folderPlacement(
  segment: string,
  directories: string[],
  fact: FileFacts,
): Placement | undefined {
  if (segment === 'routes' || segment === 'route' || segment === 'router' || segment === 'routers') {
    const backend = fact.handlers.length > 0 || directories.some((directory) => BACKEND_CONTEXT.has(directory));
    return { layer: backend ? 'Backend' : 'Frontend', module: 'Routes' };
  }
  if (segment === 'providers') {
    const integration = directories.some((directory) => INTEGRATION_CONTEXT.has(directory));
    return { layer: integration ? 'Integration' : 'Frontend', module: 'Providers' };
  }
  if (segment === 'store' || segment === 'stores') {
    const frontend = directories.some((directory) => FRONTEND_FOLDERS[directory]) ||
      fact.imports.some((entry) =>
        /(^|\/)(react|next|zustand|redux|@reduxjs|jotai|recoil|pinia|vuex)/i.test(entry.specifier));
    return { layer: frontend ? 'Frontend' : 'Data', module: 'Stores' };
  }
  const frontend = FRONTEND_FOLDERS[segment];
  if (frontend) return { layer: 'Frontend', module: frontend };
  const backend = BACKEND_FOLDERS[segment];
  if (backend) return { layer: 'Backend', module: backend };
  const service = SERVICE_FOLDERS[segment];
  if (service) return { layer: 'Services', module: service };
  const data = DATA_FOLDERS[segment];
  if (data) return { layer: 'Data', module: data };
  const integration = INTEGRATION_FOLDERS[segment];
  if (integration) return { layer: 'Integration', module: integration };
  const utility = UTILITY_FOLDERS[segment];
  if (utility) return { layer: 'Utils', module: utility };
  const config = CONFIG_FOLDERS[segment];
  if (config) return { layer: 'Config', module: config };
  return undefined;
}

function deepestPlacement(relative: string, fact: FileFacts): Placement | undefined {
  const directories = directorySegments(relative);
  for (let index = directories.length - 1; index >= 0; index--) {
    const placement = folderPlacement(directories[index], directories.slice(0, index), fact);
    if (!placement) continue;
    const next = directories[index + 1];
    return next ? { layer: placement.layer, module: titleModule(next) } : placement;
  }
  return undefined;
}

function specialPlacement(relative: string, fact: FileFacts): Placement | undefined {
  const lower = relative.toLowerCase();
  const directories = directorySegments(relative);
  const stem = stemOf(relative);
  if (/(^|\/)(app|pages)\/api(\/|$)/.test(lower)) {
    return { layer: 'Backend', module: 'Routes' };
  }
  if (stem === 'route' || stem === 'routes' || stem === 'router' || stem === 'routers') {
    const frontend = /\.(tsx|jsx|vue|svelte)$/i.test(relative) ||
      fact.imports.some((entry) =>
        /(^|\/)(react-router|react-router-dom|@tanstack\/react-router)/i.test(entry.specifier));
    return { layer: frontend ? 'Frontend' : 'Backend', module: 'Routes' };
  }
  if (/(^|\/)electron(\/|$)/.test(lower)) {
    if (directories.includes('renderer') || directories.includes('frontend')) {
      return { layer: 'Frontend', module: 'Electron' };
    }
    if (stem === 'preload' || stem === 'ipc' || directories.includes('preload') || directories.includes('ipc')) {
      return { layer: 'Backend', module: 'IPC' };
    }
    return { layer: 'Backend', module: 'Electron' };
  }
  if (/(^|\/)src-tauri(\/|$)/.test(lower)) {
    return { layer: 'Backend', module: 'Tauri' };
  }
  return undefined;
}

function strongFilePlacement(
  relative: string,
  fact: FileFacts,
  resolved: Placement | undefined,
): Placement | undefined {
  const stem = stemOf(relative);
  const weak = !resolved || resolved.layer === 'Utils' || resolved.layer === 'Unclassified';
  if (stem === 'db' || stem === 'database' || stem === 'repository' || stem === 'migration') {
    if (weak) return { layer: 'Data', module: 'Stores' };
  }
  if (fact.sql.length > 0 && weak) {
    return { layer: 'Data', module: 'Stores' };
  }
  if (fact.handlers.length > 0 && weak) {
    return { layer: 'Backend', module: 'Handlers' };
  }
  if (resolved?.layer === 'Backend' && /^(controller|handler|endpoint|resolver)$/.test(stem)) {
    return { layer: 'Backend', module: 'Handlers' };
  }
  if (!resolved) {
    if (stem === 'service') return { layer: 'Services', module: 'Services' };
    if (stem === 'provider') return { layer: 'Integration', module: 'Providers' };
    if (stem === 'config' || stem === 'settings' || stem === 'preset') {
      return { layer: 'Config', module: 'Settings' };
    }
    if (stem === 'util' || stem === 'helper' || stem === 'helpers') {
      return { layer: 'Utils', module: 'Utilities' };
    }
  }
  return undefined;
}

function classify(relative: string, fact: FileFacts): Placement {
  const lower = relative.toLowerCase();
  const base = path.posix.basename(lower);
  if (relative.startsWith('webview/src/')) {
    return { layer: 'Frontend', module: frontendModule(relative) };
  }
  if (relative.startsWith('src/webview/')) return { layer: 'Backend', module: 'Message Router' };
  if (relative === 'src/extension.ts') return { layer: 'Backend', module: 'Extension' };
  if (relative.startsWith('src/session/')) {
    if (/store|journal|ledger|snapshot/.test(base)) return { layer: 'Data', module: 'Stores' };
    if (/recovery/.test(base)) return { layer: 'Services', module: 'Recovery' };
    if (/connections/.test(base)) return { layer: 'Integration', module: 'Connections' };
    if (/contextindex/.test(base)) return { layer: 'Services', module: 'Indexing' };
    return { layer: 'Backend', module: 'Session' };
  }
  if (relative.startsWith('src/editor/')) return { layer: 'Backend', module: 'Editor Actions' };
  if (relative.startsWith('src/attention/')) return { layer: 'Backend', module: 'Attention' };
  if (relative.startsWith('src/worktree/')) return { layer: 'Backend', module: 'Worktrees' };
  if (relative.startsWith('src/planner/')) return { layer: 'Services', module: 'Planner' };
  if (relative.startsWith('src/agent/')) return { layer: 'Services', module: 'Agent' };
  if (relative.startsWith('src/scan/')) return { layer: 'Services', module: 'Scanner' };
  if (relative.startsWith('src/indexing/')) return { layer: 'Services', module: 'Indexing' };
  if (relative.startsWith('src/architecture/')) return { layer: 'Services', module: 'Architecture' };
  if (relative.startsWith('src/review/')) return { layer: 'Services', module: 'Review' };
  if (relative.startsWith('src/diff/')) return { layer: 'Services', module: 'Review' };
  if (relative.startsWith('src/skills/')) return { layer: 'Services', module: 'Skills' };
  if (relative.startsWith('src/autocomplete/')) return { layer: 'Services', module: 'Autocomplete' };
  if (relative.startsWith('src/memory/')) return { layer: 'Data', module: 'Memory' };
  if (relative.startsWith('src/checkpoints/')) return { layer: 'Data', module: 'Checkpoints' };
  if (relative.startsWith('src/llm/')) return { layer: 'Integration', module: 'LLM' };
  if (relative.startsWith('src/mcp/')) return { layer: 'Integration', module: 'MCP' };
  if (relative.startsWith('src/browser/')) return { layer: 'Integration', module: 'Browser' };
  if (relative.startsWith('src/resources/')) return { layer: 'Utils', module: 'Resources' };
  if (relative.startsWith('src/shared/')) {
    if (/settingsschema/.test(base)) return { layer: 'Config', module: 'Settings' };
    return { layer: 'Utils', module: 'Contracts' };
  }
  if (relative.startsWith('src/util/')) return { layer: 'Utils', module: 'Utilities' };
  if (relative.startsWith('src/config')) return { layer: 'Config', module: 'Settings' };

  const special = specialPlacement(relative, fact);
  if (special) return special;
  const resolved = deepestPlacement(relative, fact);
  const strong = strongFilePlacement(relative, fact, resolved);
  if (strong) return strong;
  if (resolved) return resolved;

  if (fact.sql.length > 0) return { layer: 'Data', module: 'Stores' };
  if (fact.handlers.length > 0) return { layer: 'Backend', module: 'Handlers' };
  if (/(^|\/)(package\.json|tsconfig|jsconfig|manifest\.json|cargo\.toml|go\.mod|pyproject\.toml|(?:eslint|vite|next|tailwind|postcss|webpack|rollup|jest|vitest|playwright|tsup)\.config\.[a-z]+)$/.test(lower)) {
    return { layer: 'Config', module: 'Settings' };
  }
  const directory = relative.includes('/') ? relative.split('/').slice(-2, -1)[0] : 'Root';
  return { layer: 'Unclassified', module: title(directory || 'Root') };
}

function inferUnclassifiedDirectories(entries: FileEntry[]): void {
  const byDirectory = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    if (entry.layer !== 'Unclassified') continue;
    const directory = path.posix.dirname(entry.relative);
    const list = byDirectory.get(directory) ?? [];
    list.push(entry);
    byDirectory.set(directory, list);
  }
  for (const [directory, list] of byDirectory) {
    const facts = list.map((entry) => entry.fact);
    const imports = facts.flatMap((fact) => fact.imports.map((entry) => entry.specifier));
    const module = title(path.posix.basename(directory) || 'Other');
    const has = (predicate: (fact: FileFacts) => boolean): boolean => facts.some(predicate);
    if (has((fact) => fact.handlers.length > 0)) {
      for (const entry of list) {
        entry.layer = 'Backend';
        entry.module = module;
      }
      continue;
    }
    if (facts.some((fact) => fact.sql.length > 0) || imports.some((specifier) => ORM_IMPORT.test(specifier))) {
      for (const entry of list) {
        entry.layer = 'Data';
        entry.module = module;
      }
      continue;
    }
    if (imports.some((specifier) => SERVER_IMPORT.test(specifier)) || has((fact) => fact.listeners.length > 0)) {
      for (const entry of list) {
        entry.layer = 'Services';
        entry.module = module;
      }
      continue;
    }
    if (has((fact) => fact.httpClients.length > 0 || fact.httpCalls.length > 0)) {
      for (const entry of list) {
        entry.layer = 'Integration';
        entry.module = module;
      }
      continue;
    }
    if (has((fact) => fact.storageKeys.length > 0)) {
      for (const entry of list) {
        entry.layer = 'Data';
        entry.module = module;
      }
      continue;
    }
    if (
      imports.some((specifier) => UI_IMPORT.test(specifier)) ||
      list.some((entry) => /\.(tsx|jsx|vue|svelte)$/i.test(entry.relative))
    ) {
      for (const entry of list) {
        entry.layer = 'Frontend';
        entry.module = module;
      }
    }
  }
}

function readMessageTypes(source: string): string[] {
  const types = new Set<string>();
  const send = /\b(?:post|postMessage)\s*\(\s*\{[\s\S]{0,300}?\btype\s*:\s*['"]([A-Za-z0-9_:-]+)['"]/g;
  for (const match of source.matchAll(send)) {
    types.add(match[1]);
  }
  return [...types];
}

function readHandlerTypes(source: string): string[] {
  const types = new Set<string>();
  const cases = /\bcase\s+['"]([A-Za-z0-9_:-]+)['"]\s*:/g;
  for (const match of source.matchAll(cases)) {
    types.add(match[1]);
  }
  const comparisons = /\b(?:message\.)?type\s*===\s*['"]([A-Za-z0-9_:-]+)['"]/g;
  for (const match of source.matchAll(comparisons)) {
    types.add(match[1]);
  }
  return [...types];
}

function layerRank(layer: ArchitectureLayer): number {
  const index = ARCHITECTURE_LAYERS.indexOf(layer);
  return index < 0 ? ARCHITECTURE_LAYERS.length : index;
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

async function readJson(file: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, any>;
  } catch {
    return undefined;
  }
}

async function detectFingerprint(root: string, facts: FileFacts[]): Promise<string> {
  const languageCounts = new Map<string, number>();
  const languageFor = (file: string): string | undefined => {
    const lower = file.toLowerCase();
    if (/\.(ts|tsx|mts|cts)$/.test(lower)) return 'TypeScript';
    if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return 'JavaScript';
    if (/\.py$/.test(lower)) return 'Python';
    if (/\.rs$/.test(lower)) return 'Rust';
    if (/\.go$/.test(lower)) return 'Go';
    if (/\.java$/.test(lower)) return 'Java';
    if (/\.rb$/.test(lower)) return 'Ruby';
    if (/\.php$/.test(lower)) return 'PHP';
    if (/\.(sh|bash)$/.test(lower)) return 'Shell';
    return undefined;
  };
  for (const fact of facts) {
    const language = languageFor(fact.file);
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([language]) => language);

  const frameworks = new Set<string>();
  const pkg = await readJson(path.join(root, 'package.json'));
  if (pkg) {
    if (pkg.engines?.vscode || pkg.contributes) frameworks.add('VS Code extension');
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.next) frameworks.add('Next.js');
    else if (deps.react) frameworks.add('React');
    if (deps.vue) frameworks.add('Vue');
    if (deps.svelte) frameworks.add('Svelte');
    if (deps.express) frameworks.add('Express');
    if (deps['@nestjs/core']) frameworks.add('NestJS');
  }
  const pyproject = await readText(path.join(root, 'pyproject.toml'));
  const requirements = await readText(path.join(root, 'requirements.txt'));
  const python = `${pyproject}\n${requirements}`.toLowerCase();
  if (/\bdjango\b/.test(python)) frameworks.add('Django');
  else if (/\bfastapi\b/.test(python)) frameworks.add('FastAPI');
  else if (/\bflask\b/.test(python)) frameworks.add('Flask');
  const cargo = (await readText(path.join(root, 'Cargo.toml'))).toLowerCase();
  if (/\baxum\b/.test(cargo)) frameworks.add('Axum');
  else if (/actix-web/.test(cargo)) frameworks.add('Actix');
  else if (/\brocket\b/.test(cargo)) frameworks.add('Rocket');
  const goMod = (await readText(path.join(root, 'go.mod'))).toLowerCase();
  if (/gin-gonic\/gin/.test(goMod)) frameworks.add('Gin');
  else if (/labstack\/echo/.test(goMod)) frameworks.add('Echo');
  else if (/gofiber\/fiber/.test(goMod)) frameworks.add('Fiber');
  const spring = `${await readText(path.join(root, 'pom.xml'))}\n${await readText(path.join(root, 'build.gradle'))}`.toLowerCase();
  if (/spring-boot/.test(spring)) frameworks.add('Spring Boot');

  return [...languages, ...[...frameworks].slice(0, 3)].filter(Boolean).join(' · ') || 'Unknown project';
}

/**
 * Deterministic architecture map. It never calls a model: nodes are files,
 * grouped by inferred layer and module, and edges are resolved imports plus
 * webview message types linked to their host handlers.
 */
export async function buildDeterministicMap(
  facts: FileFacts[],
  root: string,
  projectName: string,
): Promise<DeterministicMapResult> {
  const entries: FileEntry[] = [];
  const seenRelative = new Set<string>();
  for (const fact of facts) {
    const relative = relativeFile(root, fact.file);
    if (!relative || relative.startsWith('..') || relative.startsWith('/')) {
      continue;
    }
    if (seenRelative.has(relative)) {
      continue;
    }
    seenRelative.add(relative);
    const { layer, module } = classify(relative, fact);
    entries.push({
      fact,
      relative,
      id: `file_${slug(relative)}`,
      layer,
      module,
    });
  }
  inferUnclassifiedDirectories(entries);
  // Keep each layer readable. Modules with routes, entry files, or many files
  // stay visible; the remainder stays reachable under Layer/Other.
  const MAX_MODULES_PER_LAYER = 8;
  const moduleGroups = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const key = `${entry.layer}\u0000${entry.module}`;
    const list = moduleGroups.get(key) ?? [];
    list.push(entry);
    moduleGroups.set(key, list);
  }
  const keptModules = new Map<string, Set<string>>();
  for (const [key, list] of moduleGroups) {
    const separator = key.indexOf('\u0000');
    const layer = key.slice(0, separator);
    const module = key.slice(separator + 1);
    const routeCount = list.reduce((sum, entry) => sum + entry.fact.handlers.length, 0);
    const entryFile = list.some((entry) =>
      /^(index|main|app|server|entry)$/i.test(path.posix.basename(entry.relative).replace(/\.[^.]+$/, '')));
    const score = list.length + routeCount * 2 + (entryFile ? 3 : 0);
    const kept = keptModules.get(layer) ?? new Set<string>();
    kept.add(module);
    keptModules.set(layer, kept);
    moduleGroups.set(key, list);
    (list as FileEntry[] & { score?: number }).score = score;
  }
  for (const [layer, kept] of keptModules) {
    const modules = [...moduleGroups.entries()]
      .filter(([key]) => key.startsWith(`${layer}\u0000`))
      .map(([key, list]) => ({ module: key.slice(layer.length + 1), score: (list as FileEntry[] & { score?: number }).score ?? 0 }))
      .sort((a, b) => b.score - a.score || a.module.localeCompare(b.module));
    kept.clear();
    for (const item of modules.slice(0, MAX_MODULES_PER_LAYER)) {
      kept.add(item.module);
    }
  }
  for (const entry of entries) {
    if (!keptModules.get(entry.layer)?.has(entry.module)) {
      entry.module = 'Other';
    }
  }

  entries.sort((a, b) => {
    const layer = layerRank(a.layer) - layerRank(b.layer);
    if (layer !== 0) return layer;
    const module = a.module.localeCompare(b.module);
    if (module !== 0) return module;
    return a.relative.localeCompare(b.relative);
  });

  const idByRelative = new Map(entries.map((entry) => [entry.relative, entry.id]));
  const uriByRelative = new Map<string, string>();
  const relativeByUri = new Map<string, string>();
  for (const entry of entries) {
    const absolute = absolutePath(entry.fact.file, root);
    if (!absolute) continue;
    const uri = pathToFileURL(absolute).toString();
    uriByRelative.set(entry.relative, uri);
    relativeByUri.set(uri, entry.relative);
  }
  const known = new Set(relativeByUri.keys());

  const nodes: StructuredNode[] = entries.map((entry) => ({
    id: entry.id,
    label: labelFor(entry.relative),
    group: `${entry.layer}/${entry.module}`,
    path: entry.relative,
  }));

  const routeNodes: StructuredNode[] = [];
  const routeEdges: StructuredEdge[] = [];
  const routeIds = new Set<string>();
  const routeKeys = new Set<string>();
  for (const entry of entries) {
    for (const handler of entry.fact.handlers) {
      const method = handler.method?.trim() || 'ROUTE';
      const ipc = /^ipc$/i.test(method);
      const pathShape = handler.pathShape?.trim();
      const handlerKey = `${entry.relative}|${method.toLowerCase()}|${pathShape ?? ''}|${handler.name ?? ''}`;
      if (routeKeys.has(handlerKey)) continue;
      routeKeys.add(handlerKey);
      if (ipc && handler.name) {
        routeKeys.add(`${entry.relative}|ipc|${handler.name.toLowerCase()}`);
      }
      const label = ipc
        ? `IPC ${handler.name || pathShape || 'command'}`
        : `${method.toUpperCase()} ${pathShape || handler.name || 'route'}`;
      const id = `route_${slug(entry.relative)}_${handler.line}_${slug(handler.name || method)}`;
      if (routeIds.has(id)) continue;
      routeIds.add(id);
      routeNodes.push({
        id,
        label: label.slice(0, 48),
        group: ipc ? 'Backend/IPC' : 'Backend/Routes',
        path: entry.relative,
      });
      routeEdges.push({
        from: id,
        to: entry.id,
        label: handler.name ? `handles ${handler.name}` : 'handles',
        evidence: [{ path: entry.relative, line: handler.line }],
      });
    }
    for (const registration of entry.fact.tauriCommandRegistrations ?? []) {
      const name = typeof registration.name === 'string' ? registration.name.trim() : '';
      if (!name) continue;
      const ipcKey = `${entry.relative}|ipc|${name.toLowerCase()}`;
      if (routeKeys.has(ipcKey)) continue;
      routeKeys.add(ipcKey);
      const id = `route_${slug(entry.relative)}_tauri_${slug(name)}`;
      if (routeIds.has(id)) continue;
      routeIds.add(id);
      routeNodes.push({
        id,
        label: `IPC ${name}`.slice(0, 48),
        group: 'Backend/IPC',
        path: entry.relative,
      });
      routeEdges.push({
        from: id,
        to: entry.id,
        label: `handles ${name}`,
        evidence: [{ path: entry.relative, line: 1 }],
      });
    }
  }
  nodes.push(...routeNodes);

  const edges: StructuredEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (edge: StructuredEdge): void => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.label ?? ''}`;
    if (edge.from === edge.to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };
  for (const edge of routeEdges) {
    addEdge(edge);
  }
  let unresolvedRelationships = 0;

  for (const entry of entries) {
    const from = entry.id;
    const source = uriByRelative.get(entry.relative);
    for (const imported of entry.fact.imports) {
      const specifier = imported.specifier;
      if (!specifier) continue;
      let resolvedUri: string | undefined;
      if (source) {
        resolvedUri = entry.relative.endsWith('.rs')
          ? (resolveArchitectureSpecifier(source, specifier, known) ?? resolveSpecifier(source, specifier, known))
          : resolveSpecifier(source, specifier, known);
      }
      const relative = resolvedUri ? relativeByUri.get(resolvedUri) : undefined;
      const to = relative ? idByRelative.get(relative) : undefined;
      if (to) {
        addEdge({ from, to, label: 'imports', evidence: [{ path: entry.relative, line: imported.line }] });
      } else if (/^(?:\.|\/|@\/|~\/)/.test(specifier)) {
        unresolvedRelationships += 1;
      }
    }

    if (entry.fact.sql.length > 0) {
      addEdge({
        from,
        to: 'system_database',
        label: 'queries',
        evidence: [{ path: entry.relative, line: entry.fact.sql[0].line }],
      });
    }
    if (entry.fact.httpClients.length > 0 || entry.fact.httpCalls.length > 0) {
      const line = entry.fact.httpCalls[0]?.line ?? entry.fact.httpClients[0]?.line ?? 1;
      addEdge({
        from,
        to: 'system_external',
        label: 'calls',
        evidence: [{ path: entry.relative, line }],
      });
    }
    if (entry.fact.listeners.length > 0) {
      addEdge({
        from,
        to: 'system_events',
        label: 'listens',
        evidence: [{ path: entry.relative, line: entry.fact.listeners[0].line }],
      });
    }
    if (entry.fact.storageKeys.length > 0) {
      const storage = entry.fact.storageKeys[0];
      addEdge({
        from,
        to: 'system_storage',
        label: storage.access === 'write' ? 'writes' : 'reads',
        evidence: [{ path: entry.relative, line: storage.line }],
      });
    }
  }

  if (entries.some((entry) => entry.fact.sql.length > 0)) {
    nodes.push({ id: 'system_database', label: 'Database', group: 'Data/Database' });
  }
  if (entries.some((entry) => entry.fact.httpClients.length > 0 || entry.fact.httpCalls.length > 0)) {
    nodes.push({ id: 'system_external', label: 'External Services', group: 'Integration/External Services' });
  }
  if (entries.some((entry) => entry.fact.listeners.length > 0)) {
    nodes.push({ id: 'system_events', label: 'Events / Queues', group: 'Services/Events' });
  }
  if (entries.some((entry) => entry.fact.storageKeys.length > 0)) {
    nodes.push({ id: 'system_storage', label: 'Storage', group: 'Data/Storage' });
  }

  // Link webview message senders to host handlers by message type. This is
  // the deterministic replacement for AI-invented UI-to-backend arrows.
  const senders = new Map<string, string[]>();
  const handlers = new Map<string, string[]>();
  const readTypes = async (entry: FileEntry): Promise<void> => {
    const absolute = absolutePath(entry.fact.file, root);
    if (!absolute || !/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(entry.relative)) return;
    let source = '';
    try {
      source = await fs.readFile(absolute, 'utf-8');
    } catch {
      return;
    }
    if (entry.layer === 'Frontend') {
      for (const type of readMessageTypes(source)) {
        const list = senders.get(type) ?? [];
        if (list.length < 3) list.push(entry.relative);
        senders.set(type, list);
      }
    }
    if (entry.layer === 'Backend') {
      for (const type of readHandlerTypes(source)) {
        const list = handlers.get(type) ?? [];
        if (list.length < 4) list.push(entry.relative);
        handlers.set(type, list);
      }
    }
  };
  await Promise.all(entries.map((entry) => readTypes(entry)));
  for (const [type, senderFiles] of senders) {
    for (const handlerFile of handlers.get(type) ?? []) {
      const from = idByRelative.get(senderFiles[0]);
      const to = idByRelative.get(handlerFile);
      if (from && to) {
        addEdge({ from, to, label: 'message' });
      }
    }
  }

  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const isolatedFiles = entries.filter((entry) => !connected.has(entry.id)).length;
  const unclassifiedFiles = entries.filter((entry) => entry.layer === 'Unclassified').length;

  return {
    map: { nodes, edges },
    representedFiles: entries.length,
    unresolvedRelationships,
    isolatedFiles,
    unclassifiedFiles,
    fingerprint: await detectFingerprint(root, entries.map((entry) => entry.fact)),
  };
}

export { title as architectureModuleTitle };
