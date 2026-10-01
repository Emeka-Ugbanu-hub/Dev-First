import type { FileFacts } from '../scan/duplication';
import { isTestFile, shortName } from '../scan/crossFile';
import { findPackageRoots } from './manifests';
import type { PackageRoot } from './manifests';
import { analyzeArchitectureRelations } from './relations';

export type ArchitectureKind =
  | 'project'
  | 'domain'
  | 'subsystem'
  | 'component'
  | 'implementation'
  | 'file';

export interface ArchitectureNode {
  id: string;
  kind: ArchitectureKind;
  label: string;
  description: string;
  usedBy: string[];
  dependsOn: string[];
  implementedBy: number;
  files: string[];
  children: ArchitectureNode[];
}

export type DomainKey =
  | 'backend'
  | 'frontend'
  | 'database'
  | 'infrastructure'
  | 'configuration'
  | 'external-services'
  | 'workers'
  | 'shared'
  | 'desktop-shell'
  | 'unclassified';

export interface DomainGroup {
  key: string;
  label: string;
  description: string;
  files: FileFacts[];
  domain?: DomainKey;
}

interface FileEntry {
  uri: string;
  path: string;
  folder: string;
  segments: string[];
  base: string;
  stem: string;
  ext: string;
  facts: FileFacts;
}

interface SubsystemRule {
  label: string;
  match: (entry: FileEntry) => boolean;
}

const DOMAIN_ORDER: DomainKey[] = [
  'backend',
  'frontend',
  'database',
  'infrastructure',
  'configuration',
  'external-services',
  'workers',
  'shared',
  'desktop-shell',
  'unclassified',
];

const DOMAIN_META: Record<DomainKey, { label: string; description: string }> = {
  backend: {
    label: 'Backend',
    description: 'HTTP routes, controllers, middleware, and request handlers.',
  },
  frontend: {
    label: 'Frontend',
    description: 'UI components, hooks, pages, and client-side state.',
  },
  database: {
    label: 'Database',
    description: 'Schemas, models, migrations, and data access.',
  },
  infrastructure: {
    label: 'Infrastructure',
    description: 'Containers, deployment, and continuous integration.',
  },
  configuration: {
    label: 'Configuration',
    description: 'Environment, tooling, and application configuration files.',
  },
  'external-services': {
    label: 'External Services',
    description: 'Clients, webhooks, and integrations for third-party APIs.',
  },
  workers: {
    label: 'Workers',
    description: 'Background jobs, queues, and scheduled tasks.',
  },
  shared: {
    label: 'Shared',
    description: 'Reusable utilities, helpers, and shared types.',
  },
  'desktop-shell': {
    label: 'Desktop Shell',
    description: 'Native desktop application code and its frontend bridge.',
  },
  unclassified: {
    label: 'Unclassified',
    description:
      'Files that did not match any domain signal — verify their placement or add a signal.',
  },
};

const BACKEND_DIR = /^(routes?|routers?|controllers?|middleware|handlers?|endpoints?|resolvers?)$/i;
const FRONTEND_DIR = /^(components?|hooks?|pages?|views?|screens?|ui|widgets?|frontend|web)$/i;
const DATABASE_DIR = /^(repositories|repos?|models?|migrations?|database|db|entities|dao|persistence|schemas?)$/i;
const DATABASE_EXT = new Set(['.sql', '.prisma']);
const TAURI_DIR = /^src-tauri$/i;
const LANGUAGE_BACKEND_DIR = /^(cmd|internal)$/i;
const LANGUAGE_BACKEND_EXT = new Set(['.rs', '.go', '.java', '.kt', '.kts', '.cs']);
const LANGUAGE_INFRA_EXT = new Set(['.sh', '.bash', '.ps1']);
const LANGUAGE_STYLE_EXT = new Set(['.css', '.scss', '.less', '.sass']);
const LANGUAGE_CONFIG_EXT = new Set(['.ini']);
const DATABASE_DRIVER_IMPORT = /^(rusqlite|sqlx|diesel|sqlite3?|better-sqlite3|prisma|sequelize|typeorm|knex|mongoose|mongodb|drizzle-orm)(\/|::|$)/i;
const EXTERNAL_CLIENT_IMPORT = /^(reqwest|octocrab|github-graphql|@octokit|octokit)(\/|$)/i;
const INFRA_DIR = /^(k8s|kubernetes|terraform|infra|deploy|deployments?|helm|charts?|ci|workflows?)$/i;
const INFRA_BASE = /^(dockerfile|docker-compose\.ya?ml|compose\.ya?ml|jenkinsfile|\.gitlab-ci\.ya?ml)$/i;
const INFRA_EXT = new Set(['.tf', '.tfvars']);
const EXTERNAL_DIR = /^(clients?|webhooks?|integrations?|connectors?|external)$/i;
const WORKER_DIR = /^(jobs?|queues?|workers?|cron|tasks?|schedulers?|consumers?|producers?)$/i;
const SHARED_DIR = /^(utils?|helpers?|types?|common|shared|lib)$/i;
const COMPONENT_SUFFIX =
  /(Service|Controller|Handler|Repository|Repo|Manager|Router|Route|Middleware|Client|Store|Worker|Job|Queue|Gateway|Adapter|Provider|Factory|Resolver|Interceptor|Component|Hook)$/;

const BACKEND_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Routes',
    match: (entry) =>
      entry.segments.some((segment) => /^(routes?|routers?|api)$/i.test(segment)) ||
      /(Route|Router)$/.test(entry.stem),
  },
  {
    label: 'Controllers',
    match: (entry) =>
      entry.segments.some((segment) => /^(controllers?|handlers?|endpoints?|resolvers?)$/i.test(segment)) ||
      /(Controller|Handler|Endpoint|Resolver)$/.test(entry.stem),
  },
  {
    label: 'Middleware',
    match: (entry) =>
      entry.segments.some((segment) => /^middleware$/i.test(segment)) ||
      /Middleware$/.test(entry.stem),
  },
  {
    label: 'Repositories',
    match: (entry) =>
      entry.segments.some((segment) =>
        /^(repositories|repos?|dao|persistence|database|db)$/i.test(segment),
      ) || /(Repository|Repo|Dao|Gateway)$/.test(entry.stem),
  },
  {
    label: 'Models',
    match: (entry) =>
      entry.segments.some((segment) => /^(models?|entities|schemas?)$/i.test(segment)) ||
      /(Model|Entity|Schema)$/.test(entry.stem),
  },
  {
    label: 'Services',
    match: (entry) =>
      entry.segments.some((segment) =>
        /^(services?|usecases?|use-cases|managers?|logic)$/i.test(segment),
      ) || /(Service|Manager|UseCase|Interactor)$/.test(entry.stem),
  },
];

const FRONTEND_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Pages',
    match: (entry) =>
      entry.segments.some((segment) => /^(pages?|views?|screens?)$/i.test(segment)) ||
      /(Page|Screen)$/.test(entry.stem),
  },
  {
    label: 'Components',
    match: (entry) =>
      entry.segments.some((segment) => /^(components?|ui|widgets?)$/i.test(segment)) ||
      /Component$/.test(entry.stem) ||
      entry.ext === '.tsx' ||
      entry.ext === '.jsx',
  },
  {
    label: 'Hooks',
    match: (entry) =>
      entry.segments.some((segment) => /^hooks?$/i.test(segment)) ||
      /^use[A-Z0-9]/.test(entry.stem) ||
      /Hook$/.test(entry.stem),
  },
  {
    label: 'State',
    match: (entry) =>
      entry.segments.some((segment) => /^(state|stores?|context|redux|reducers|slices)$/i.test(segment)) ||
      /(Store|Context|Reducer|Slice)$/.test(entry.stem),
  },
  {
    label: 'Styles',
    match: (entry) =>
      entry.segments.some((segment) => /^(styles?|css|theme)$/i.test(segment)) ||
      ['.css', '.scss', '.less', '.sass'].includes(entry.ext),
  },
];

const DATABASE_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Migrations',
    match: (entry) =>
      entry.segments.some((segment) => /^migrations?$/i.test(segment)) ||
      /Migration$/.test(entry.stem),
  },
  {
    label: 'Models',
    match: (entry) =>
      entry.segments.some((segment) => /^(models?|entities|schemas?)$/i.test(segment)) ||
      entry.ext === '.prisma' ||
      /(Model|Entity|Schema)$/.test(entry.stem),
  },
  {
    label: 'Repositories',
    match: (entry) =>
      entry.segments.some((segment) =>
        /^(repositories|repos?|dao|persistence|database|db)$/i.test(segment),
      ) || /(Repository|Repo|Dao|Gateway)$/.test(entry.stem),
  },
  {
    label: 'Queries',
    match: (entry) =>
      entry.segments.some((segment) => /^(queries|sql)$/i.test(segment)) ||
      entry.ext === '.sql' ||
      /(Query|Queries)$/.test(entry.stem),
  },
];

const INFRA_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Containers',
    match: (entry) =>
      /^(dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i.test(entry.base) ||
      entry.segments.some((segment) => /^(docker|containers?)$/i.test(segment)),
  },
  {
    label: 'Kubernetes',
    match: (entry) => entry.segments.some((segment) => /^(k8s|kubernetes|helm|charts?)$/i.test(segment)),
  },
  {
    label: 'Terraform',
    match: (entry) =>
      entry.ext === '.tf' ||
      entry.ext === '.tfvars' ||
      entry.segments.some((segment) => /^terraform$/i.test(segment)),
  },
  {
    label: 'CI',
    match: (entry) =>
      entry.segments.some((segment) => /^(ci|workflows?|\.github)$/i.test(segment)) ||
      /^(jenkinsfile|\.gitlab-ci\.ya?ml)$/i.test(entry.base),
  },
];

const CONFIGURATION_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Config',
    match: (entry) =>
      entry.ext === '.ini' ||
      entry.segments.some((segment) => /^configs?$/i.test(segment)) ||
      /(Config|Settings|Options|Env)$/i.test(entry.stem),
  },
];

const EXTERNAL_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Clients',
    match: (entry) =>
      entry.segments.some((segment) => /^clients?$/i.test(segment)) ||
      /(Client|Api|Sdk)$/.test(entry.stem),
  },
  {
    label: 'Webhooks',
    match: (entry) =>
      entry.segments.some((segment) => /^webhooks?$/i.test(segment)) ||
      /Webhook$/.test(entry.stem),
  },
  {
    label: 'Integrations',
    match: (entry) =>
      entry.segments.some((segment) => /^(integrations?|connectors?)$/i.test(segment)) ||
      /(Integration|Connector|Adapter)$/.test(entry.stem),
  },
];

const WORKER_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Jobs',
    match: (entry) =>
      entry.segments.some((segment) => /^(jobs?|tasks?)$/i.test(segment)) ||
      /(Job|Task)$/.test(entry.stem),
  },
  {
    label: 'Queues',
    match: (entry) =>
      entry.segments.some((segment) => /^(queues?|brokers?|kafka|rabbitmq)$/i.test(segment)) ||
      /(Queue|Consumer|Producer)$/.test(entry.stem),
  },
  {
    label: 'Cron',
    match: (entry) =>
      entry.segments.some((segment) => /^(cron|schedulers?)$/i.test(segment)) ||
      /(Cron|Scheduler)$/.test(entry.stem),
  },
  {
    label: 'Workers',
    match: (entry) =>
      entry.segments.some((segment) => /^workers?$/i.test(segment)) || /Worker$/.test(entry.stem),
  },
];

const SHARED_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Utils',
    match: (entry) =>
      entry.segments.some((segment) => /^utils?$/i.test(segment)) ||
      /(Util|Utils)$/.test(entry.stem),
  },
  {
    label: 'Helpers',
    match: (entry) =>
      entry.segments.some((segment) => /^helpers?$/i.test(segment)) ||
      /(Helper|Helpers)$/.test(entry.stem),
  },
  {
    label: 'Types',
    match: (entry) =>
      entry.segments.some((segment) => /^types?$/i.test(segment)) || /Types?$/.test(entry.stem),
  },
];

const UNCLASSIFIED_SUBSYSTEMS: SubsystemRule[] = [
  { label: 'Tests', match: (entry) => isTestFile(entry.uri) },
  {
    label: 'Integrations',
    match: (entry) =>
      /^tauri$/i.test(entry.stem) ||
      entry.facts.imports.some((record) => /^@tauri-apps\//i.test(record.specifier)),
  },
  {
    label: 'Config',
    match: (entry) => /\.d\.ts$/i.test(entry.base),
  },
  {
    label: 'Entry',
    match: (entry) =>
      /^(main|index|app|server|cli|bootstrap|program|module)$/i.test(entry.stem),
  },
  {
    label: 'Config',
    match: (entry) =>
      entry.segments.some((segment) => /^configs?$/i.test(segment)) ||
      /(Config|Settings|Options|Env)$/i.test(entry.stem),
  },
];

const SUBSYSTEM_RULES: Record<DomainKey, SubsystemRule[]> = {
  backend: BACKEND_SUBSYSTEMS,
  frontend: FRONTEND_SUBSYSTEMS,
  database: DATABASE_SUBSYSTEMS,
  infrastructure: INFRA_SUBSYSTEMS,
  configuration: CONFIGURATION_SUBSYSTEMS,
  'external-services': EXTERNAL_SUBSYSTEMS,
  workers: WORKER_SUBSYSTEMS,
  shared: SHARED_SUBSYSTEMS,
  'desktop-shell': UNCLASSIFIED_SUBSYSTEMS,
  unclassified: UNCLASSIFIED_SUBSYSTEMS,
};

const SUBSYSTEM_FALLBACK: Record<DomainKey, string> = {
  backend: 'Other',
  frontend: 'Other',
  database: 'Other',
  infrastructure: 'Infrastructure',
  configuration: 'Config',
  'external-services': 'Other',
  workers: 'Other',
  shared: 'Other',
  'desktop-shell': 'Desktop shell',
  unclassified: 'Utilities',
};

function decodePath(uri: string): string {
  try {
    const url = new URL(uri);
    return decodeURIComponent(url.pathname);
  } catch {
    return uri.replace(/^file:\/\//, '');
  }
}

function dirOfPath(value: string): string {
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(0, index) : '';
}

function baseOfPath(value: string): string {
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}

function stemOf(base: string): string {
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(0, index) : base;
}

function extOf(base: string): string {
  const index = base.lastIndexOf('.');
  return index > 0 ? base.slice(index).toLowerCase() : '';
}

export function commonRootOf(uris: string[]): string {
  if (uris.length === 0) {
    return '';
  }
  const paths = uris.map(decodePath);
  let prefix = dirOfPath(paths[0]).split('/');
  for (const path of paths.slice(1)) {
    const parts = dirOfPath(path).split('/');
    let index = 0;
    while (index < prefix.length && index < parts.length && prefix[index] === parts[index]) {
      index++;
    }
    prefix = prefix.slice(0, index);
  }
  return prefix.join('/');
}

export function folderOf(uri: string, root: string): string {
  const dir = dirOfPath(decodePath(uri));
  const relative = root && dir.startsWith(root) ? dir.slice(root.length) : dir;
  return relative.replace(/^\/+/, '');
}

export function relativePathOf(uri: string, root: string): string {
  const path = decodePath(uri);
  const relative = root && path.startsWith(root) ? path.slice(root.length) : path;
  return relative.replace(/^\/+/, '');
}

function entryFor(facts: FileFacts, root: string): FileEntry {
  const path = decodePath(facts.file);
  const base = baseOfPath(path);
  const folder = folderOf(facts.file, root);
  const segments = folder.split('/').filter(Boolean);
  if (segments.length === 0 && root) {
    const rootBase = baseOfPath(root);
    if (rootBase) {
      segments.push(rootBase);
    }
  }
  return {
    uri: facts.file,
    path,
    folder,
    segments,
    base,
    stem: stemOf(base),
    ext: extOf(base),
    facts,
  };
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node'
  );
}

function classifyEntry(entry: FileEntry): DomainKey {
  if (LANGUAGE_INFRA_EXT.has(entry.ext)) {
    return 'infrastructure';
  }
  if (LANGUAGE_STYLE_EXT.has(entry.ext)) {
    return 'frontend';
  }
  if (LANGUAGE_CONFIG_EXT.has(entry.ext)) {
    return 'configuration';
  }
  const facts = entry.facts;
  const frontendLike =
    entry.ext === '.tsx' ||
    entry.ext === '.jsx' ||
    entry.segments.some((segment) => FRONTEND_DIR.test(segment));
  if (
    !entry.segments.some((segment) => TAURI_DIR.test(segment)) &&
    (entry.segments.some((segment) => BACKEND_DIR.test(segment)) ||
      entry.segments.some((segment) => LANGUAGE_BACKEND_DIR.test(segment)) ||
      (!frontendLike && facts.handlers.some((handler) => handler.method !== 'IPC')))
  ) {
    return 'backend';
  }
  if (frontendLike) {
    return 'frontend';
  }
  if (/^(cargo\.toml|package\.json|pyproject\.toml|go\.mod|composer\.json)$/i.test(entry.base)) {
    return 'configuration';
  }
  if (
    facts.sql.length > 0 ||
    facts.imports.some((record) => DATABASE_DRIVER_IMPORT.test(record.specifier)) ||
    DATABASE_EXT.has(entry.ext) ||
    entry.segments.some((segment) => DATABASE_DIR.test(segment))
  ) {
    return 'database';
  }
  if (
    INFRA_BASE.test(entry.base) ||
    INFRA_EXT.has(entry.ext) ||
    entry.segments.some((segment) => INFRA_DIR.test(segment))
  ) {
    return 'infrastructure';
  }
  if (
    facts.httpClients.length > 0 ||
    facts.imports.some((record) => EXTERNAL_CLIENT_IMPORT.test(record.specifier)) ||
    entry.segments.some((segment) => EXTERNAL_DIR.test(segment)) ||
    (entry.ext === '.rs' && /^github$/i.test(entry.stem))
  ) {
    return 'external-services';
  }
  if (LANGUAGE_BACKEND_EXT.has(entry.ext)) {
    return 'backend';
  }
  if (entry.segments.some((segment) => TAURI_DIR.test(segment))) {
    return 'desktop-shell';
  }
  if (
    entry.segments.some((segment) => WORKER_DIR.test(segment))
  ) {
    return 'workers';
  }
  if (
    entry.segments.some((segment) => SHARED_DIR.test(segment))
  ) {
    return 'shared';
  }
  return 'unclassified';
}

export function classifyFileDomain(file: FileFacts): DomainKey {
  return classifyEntry(entryFor(file, ''));
}

function signalDomainGroups(entries: FileEntry[]): DomainGroup[] {
  const buckets = new Map<DomainKey, FileEntry[]>();
  const push = (key: DomainKey, entry: FileEntry): void => {
    const list = buckets.get(key);
    if (list) {
      list.push(entry);
    } else {
      buckets.set(key, [entry]);
    }
  };
  for (const entry of entries) {
    push(classifyEntry(entry), entry);
  }
  const groups: DomainGroup[] = [];
  for (const key of DOMAIN_ORDER) {
    const list = buckets.get(key);
    if (!list || list.length === 0) {
      continue;
    }
    const meta = DOMAIN_META[key];
    groups.push({
      key,
      domain: key,
      label: meta.label,
      description: meta.description,
      files: list
        .map((entry) => entry.facts)
        .sort((a, b) => a.file.localeCompare(b.file)),
    });
  }
  return groups;
}

function dominantFolderOf(entries: FileEntry[]): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const top = entry.folder.split('/').filter(Boolean)[0];
    if (top) {
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best?.[0];
}

function packageDomainGroups(entries: FileEntry[], packages: PackageRoot[]): DomainGroup[] {
  const ordered = [...packages].sort((a, b) => b.root.length - a.root.length);
  const buckets = new Map<string, FileEntry[]>();
  const leftovers: FileEntry[] = [];
  for (const entry of entries) {
    const match = ordered.find((candidate) => {
      if (candidate.root === '.' || candidate.root === '') {
        return true;
      }
      return entry.folder === candidate.root || entry.folder.startsWith(`${candidate.root}/`);
    });
    if (!match) {
      leftovers.push(entry);
      continue;
    }
    const list = buckets.get(match.root);
    if (list) {
      list.push(entry);
    } else {
      buckets.set(match.root, [entry]);
    }
  }
  const roleFiles: FileEntry[] = [];
  const splitRoles = new Set<DomainKey>(['database', 'external-services']);
  for (const [rootKey, list] of buckets) {
    const kept: FileEntry[] = [];
    for (const entry of list) {
      if (splitRoles.has(classifyEntry(entry))) {
        roleFiles.push(entry);
      } else {
        kept.push(entry);
      }
    }
    buckets.set(rootKey, kept);
  }
  const roleLabels = new Map<string, string>();
  const labelCounts = new Map<string, number>();
  for (const pkg of packages) {
    const list = buckets.get(pkg.root);
    if (!list || list.length === 0) {
      continue;
    }
    const base = roleLabelFor(list) ?? pkg.name;
    roleLabels.set(pkg.root, base);
    labelCounts.set(base, (labelCounts.get(base) ?? 0) + 1);
  }
  const groups: DomainGroup[] = [];
  for (const pkg of packages) {
    const list = buckets.get(pkg.root);
    if (!list || list.length === 0) {
      continue;
    }
    const base = roleLabels.get(pkg.root) ?? pkg.name;
    const duplicated = (labelCounts.get(base) ?? 0) > 1;
    const suffix = duplicated ? dominantFolderOf(list) : undefined;
    groups.push({
      key: `pkg:${pkg.root}`,
      label: suffix ? `${base} · ${suffix}` : base,
      description: suffix
        ? `${base} code in ${suffix}.`
        : `${base} code.`,
      files: list
        .map((entry) => entry.facts)
        .sort((a, b) => a.file.localeCompare(b.file)),
    });
  }
  groups.push(...signalDomainGroups([...leftovers, ...roleFiles]));
  return groups;
}

function roleLabelFor(entries: FileEntry[]): string | undefined {
  const counts = new Map<DomainKey, number>();
  for (const entry of entries) {
    const key = classifyEntry(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || DOMAIN_ORDER.indexOf(a[0]) - DOMAIN_ORDER.indexOf(b[0]),
  );
  const best = ranked[0]?.[0];
  if (!best || best === 'unclassified') {
    return undefined;
  }
  return DOMAIN_META[best]?.label;
}

export function domainGroups(facts: FileFacts[]): DomainGroup[] {
  const rootPath = commonRootOf(facts.map((file) => file.file));
  const entries = facts.map((file) => entryFor(file, rootPath));
  const packages = findPackageRoots(rootPath);
  if (packages.length >= 2) {
    return packageDomainGroups(entries, packages);
  }
  return signalDomainGroups(entries);
}

const GENERIC_FOLDER_LABELS = new Set(['src', 'app', 'source', 'lib', 'packages', 'src-tauri']);

function folderLabelFor(entry: FileEntry): string | undefined {
  const segments = entry.folder.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last || last.length < 2 || GENERIC_FOLDER_LABELS.has(last.toLowerCase())) {
    return undefined;
  }
  const label = last.replace(/[-_]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function subsystemFor(entry: FileEntry, domain: DomainKey | undefined): string {
  const key = domain ?? classifyEntry(entry);
  for (const rule of SUBSYSTEM_RULES[key]) {
    if (rule.match(entry)) {
      return rule.label;
    }
  }
  return folderLabelFor(entry) ?? SUBSYSTEM_FALLBACK[key];
}

function subsystemDescription(domainLabel: string, label: string): string {
  if (label === 'Tests') {
    return `Tests covering the ${domainLabel.toLowerCase()} domain.`;
  }
  return `${label} in the ${domainLabel.toLowerCase()} domain.`;
}

function exportedComponentName(facts: FileFacts): string | undefined {
  for (const type of facts.types) {
    if (
      type.exported &&
      (type.kind === 'class' || type.kind === 'interface') &&
      COMPONENT_SUFFIX.test(type.name)
    ) {
      return type.name;
    }
  }
  for (const record of facts.exports) {
    if (record.name !== 'default' && COMPONENT_SUFFIX.test(record.name)) {
      return record.name;
    }
  }
  for (const handler of facts.handlers) {
    if (COMPONENT_SUFFIX.test(handler.name) || handler.method || handler.pathShape) {
      return handler.name;
    }
  }
  for (const fn of facts.functions) {
    if (fn.exported && COMPONENT_SUFFIX.test(fn.name)) {
      return fn.name;
    }
  }
  return undefined;
}

const GENERIC_SOURCE_FOLDERS = new Set(['src', 'app', 'source', 'entry']);
const ENTRY_STEMS = new Set(['app', 'main', 'index', 'entry', 'server']);

function componentFor(entry: FileEntry): { key: string; label: string; description: string } {
  const named = exportedComponentName(entry.facts);
  if (named) {
    return {
      key: `name:${named}`,
      label: named,
      description: `Files implementing ${named}.`,
    };
  }
  if (entry.ext === '.rs') {
    return {
      key: `module:${entry.stem}`,
      label: entry.stem,
      description: `Rust module ${entry.stem}.`,
    };
  }
  const folder = entry.folder;
  const segments = folder.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (GENERIC_SOURCE_FOLDERS.has(last.toLowerCase()) && ENTRY_STEMS.has(entry.stem.toLowerCase())) {
    return {
      key: `entry:${folder}`,
      label: 'Entry',
      description: `Entry files under ${folder}.`,
    };
  }
  const label = folder ? last || folder : 'Root';
  return {
    key: `dir:${folder || 'root'}`,
    label,
    description: folder ? `Files under ${folder}.` : 'Files at the project root.',
  };
}

function fileNode(entry: FileEntry, rootPath: string): ArchitectureNode {
  return {
    id: `file:${entry.uri}`,
    kind: 'file',
    label: entry.base,
    description: relativePathOf(entry.uri, rootPath),
    usedBy: [],
    dependsOn: [],
    implementedBy: 1,
    files: [entry.uri],
    children: [],
  };
}

function implementationNode(
  componentId: string,
  entry: FileEntry,
  rootPath: string,
  usedIds: Set<string>,
): ArchitectureNode {
  const stem = entry.stem || entry.base;
  let id = `${componentId}/implementation:${slug(stem)}`;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${componentId}/implementation:${slug(stem)}-${suffix}`;
    suffix++;
  }
  usedIds.add(id);
  return {
    id,
    kind: 'implementation',
    label: stem,
    description: relativePathOf(entry.uri, rootPath),
    usedBy: [],
    dependsOn: [],
    implementedBy: 1,
    files: [entry.uri],
    children: [fileNode(entry, rootPath)],
  };
}

function buildComponentNode(
  subsystemId: string,
  component: { key: string; label: string; description: string },
  entries: FileEntry[],
  rootPath: string,
): ArchitectureNode {
  const id = `${subsystemId}/component:${slug(component.key)}`;
  const files = entries.map((entry) => entry.uri).sort();
  const children: ArchitectureNode[] = [];
  if (entries.length > 1) {
    const usedIds = new Set<string>();
    for (const entry of entries) {
      children.push(implementationNode(id, entry, rootPath, usedIds));
    }
  } else if (entries.length === 1) {
    children.push(fileNode(entries[0], rootPath));
  }
  return {
    id,
    kind: 'component',
    label: component.label,
    description: component.description,
    usedBy: [],
    dependsOn: [],
    implementedBy: files.length,
    files,
    children,
  };
}

function buildSubsystemNode(
  domainId: string,
  domainKey: DomainKey | undefined,
  domainLabel: string,
  label: string,
  entries: FileEntry[],
  rootPath: string,
): ArchitectureNode {
  const id = `${domainId}/subsystem:${slug(label)}`;
  const components = new Map<string, { key: string; label: string; description: string; entries: FileEntry[] }>();
  for (const entry of [...entries].sort((a, b) => a.uri.localeCompare(b.uri))) {
    const component = componentFor(entry);
    const existing = components.get(component.key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      components.set(component.key, { ...component, entries: [entry] });
    }
  }
  return {
    id,
    kind: 'subsystem',
    label,
    description: subsystemDescription(domainLabel, label),
    usedBy: [],
    dependsOn: [],
    implementedBy: entries.length,
    files: entries.map((entry) => entry.uri).sort(),
    children: [...components.values()].map((component) =>
      buildComponentNode(id, component, component.entries, rootPath),
    ),
  };
}

export function buildDomainNode(group: DomainGroup, rootPath: string): ArchitectureNode {
  const entries = group.files.map((file) => entryFor(file, rootPath));
  const id = `domain:${slug(group.key.replace(/^ai:/, ''))}`;
  const buckets = new Map<string, FileEntry[]>();
  for (const entry of [...entries].sort((a, b) => a.uri.localeCompare(b.uri))) {
    const label = subsystemFor(entry, group.domain);
    const list = buckets.get(label);
    if (list) {
      list.push(entry);
    } else {
      buckets.set(label, [entry]);
    }
  }
  return {
    id,
    kind: 'domain',
    label: group.label,
    description: group.description,
    usedBy: [],
    dependsOn: [],
    implementedBy: entries.length,
    files: entries.map((entry) => entry.uri).sort(),
    children: [...buckets.entries()].map(([label, list]) =>
      buildSubsystemNode(id, group.domain, group.label, label, list, rootPath),
    ),
  };
}

function finalize(node: ArchitectureNode): void {
  node.children = [...node.children]
    .sort(
      (a, b) =>
        b.files.length - a.files.length ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    );
  for (const child of node.children) {
    finalize(child);
  }
}

function normalizedLabel(label: string): string {
  const lower = label.trim().toLowerCase();
  const singular = lower.replace(/s$/, '');
  return singular || lower;
}

function stemForUri(uri: string): string {
  const base = baseOfPath(decodePath(uri));
  return stemOf(base) || base;
}

function flattenSingleFileComponent(component: ArchitectureNode): ArchitectureNode {
  const uri = component.files[0];
  const label = uri ? stemForUri(uri) : component.label;
  const existing = uri
    ? component.children.find((child) => child.kind === 'file' && child.files[0] === uri)
    : undefined;
  if (existing) {
    existing.label = label;
    return existing;
  }
  return {
    id: uri ? `file:${uri}` : component.id,
    kind: 'file',
    label,
    description: uri ? decodePath(uri) : component.description,
    usedBy: [],
    dependsOn: [],
    implementedBy: 1,
    files: uri ? [uri] : [],
    children: [],
  };
}

function canMergeSingleChild(node: ArchitectureNode): boolean {
  if (node.kind === 'project' || node.children.length !== 1) {
    return false;
  }
  const child = node.children[0];
  return child.kind !== 'file' && child.kind !== 'component';
}

export function refineTree(node: ArchitectureNode): void {
  for (const child of [...node.children]) {
    refineTree(child);
  }
  let changed = true;
  while (changed) {
    changed = false;
    const flattened = node.children.map((child) =>
      (child.kind === 'component' || child.kind === 'implementation') &&
      child.files.length === 1 &&
      child.children.every((c) => c.kind === 'file')
        ? flattenSingleFileComponent(child)
        : child,
    );
    if (flattened.some((child, index) => child !== node.children[index])) {
      node.children = flattened;
      changed = true;
    }
    const parentLabel = normalizedLabel(node.label);
    const collapsed: ArchitectureNode[] = [];
    let didCollapse = false;
    for (const child of node.children) {
      if (
        parentLabel.length > 0 &&
        child.kind !== 'file' &&
        child.kind !== 'implementation' &&
        (child.files.length <= 1 ||
          (child.kind === 'component' && child.files.length === node.files.length)) &&
        normalizedLabel(child.label) === parentLabel
      ) {
        collapsed.push(...child.children);
        didCollapse = true;
      } else {
        collapsed.push(child);
      }
    }
    if (didCollapse) {
      node.children = collapsed;
      changed = true;
    }
    if (canMergeSingleChild(node)) {
      node.children = node.children[0].children;
      changed = true;
    }
  }
}

function attachRelationships(root: ArchitectureNode, facts: FileFacts[]): void {
  const fileNodes = new Map<string, ArchitectureNode>();
  const ancestors = new Map<string, ArchitectureNode[]>();
  const walk = (node: ArchitectureNode, path: ArchitectureNode[]): void => {
    const next = [...path, node];
    if (node.kind === 'file' && node.files.length > 0) {
      fileNodes.set(node.files[0], node);
      ancestors.set(node.files[0], next);
    }
    for (const child of node.children) {
      walk(child, next);
    }
  };
  walk(root, []);
  const fileNodeMap = new Map(facts.map((file) => [file.file, file.file]));
  const edges = new Map<string, { from: string; to: string }>();
  for (const relation of analyzeArchitectureRelations(facts, fileNodeMap)) {
    for (const evidence of relation.evidence) {
      const key = `${evidence.fromFile}\u0000${evidence.toFile}`;
      edges.set(key, { from: evidence.fromFile, to: evidence.toFile });
    }
  }
  const add = (list: string[], value: string): void => {
    if (value && !list.includes(value)) {
      list.push(value);
    }
  };
  for (const edge of edges.values()) {
    const fromNode = fileNodes.get(edge.from);
    const toNode = fileNodes.get(edge.to);
    if (fromNode) {
      add(fromNode.dependsOn, shortName(edge.to));
    }
    if (toNode) {
      add(toNode.usedBy, shortName(edge.from));
    }
    const fromPath = ancestors.get(edge.from);
    const toPath = ancestors.get(edge.to);
    if (!fromPath || !toPath) {
      continue;
    }
    let index = 0;
    while (
      index < fromPath.length &&
      index < toPath.length &&
      fromPath[index] === toPath[index]
    ) {
      index++;
    }
    const fromConcept = fromPath[index];
    const toConcept = toPath[index];
    if (!fromConcept || !toConcept || fromConcept === toConcept) {
      continue;
    }
    if (fromConcept.kind === 'file' || toConcept.kind === 'file') {
      continue;
    }
    add(fromConcept.dependsOn, toConcept.label);
    add(toConcept.usedBy, fromConcept.label);
  }
  const sortNode = (node: ArchitectureNode): void => {
    node.usedBy.sort((a, b) => a.localeCompare(b));
    node.dependsOn.sort((a, b) => a.localeCompare(b));
    for (const child of node.children) {
      sortNode(child);
    }
  };
  sortNode(root);
}

export function assembleTree(groups: DomainGroup[], facts: FileFacts[]): ArchitectureNode {
  const rootPath = commonRootOf(facts.map((file) => file.file));
  const project: ArchitectureNode = {
    id: 'project',
    kind: 'project',
    label: 'Project',
    description: 'The codebase organized by domain, subsystem, and component.',
    usedBy: [],
    dependsOn: [],
    implementedBy: facts.length,
    files: facts.map((file) => file.file).sort(),
    children: groups.map((group) => buildDomainNode(group, rootPath)),
  };
  finalize(project);
  refineTree(project);
  finalize(project);
  attachRelationships(project, facts);
  return project;
}

export function buildArchitectureTree(facts: FileFacts[]): ArchitectureNode {
  return assembleTree(domainGroups(facts), facts);
}

export function findArchitectureNode(
  root: ArchitectureNode,
  id: string,
): ArchitectureNode | undefined {
  if (root.id === id) {
    return root;
  }
  for (const child of root.children) {
    const found = findArchitectureNode(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function resolveNodeAfterRebuild(
  oldId: string,
  newTree: ArchitectureNode,
): ArchitectureNode {
  let id = oldId;
  while (id) {
    const node = findArchitectureNode(newTree, id);
    if (node) {
      return node;
    }
    const cut = id.lastIndexOf('/');
    if (cut <= 0) {
      break;
    }
    id = id.slice(0, cut);
  }
  return newTree;
}

export function breadcrumbPath(root: ArchitectureNode, id: string): ArchitectureNode[] {
  if (root.id === id) {
    return [root];
  }
  for (const child of root.children) {
    const path = breadcrumbPath(child, id);
    if (path.length > 0) {
      return [root, ...path];
    }
  }
  return [];
}
