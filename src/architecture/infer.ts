import { createHash } from 'crypto';
import { repairJson } from '../agent/jsonRepair';
import type { LLMProvider } from '../llm/types';
import { extractBalanced, parseJsonLoose, tryParseJson } from '../util/json';
import { collectCompletion } from '../scan/aiScanner';
import type { AiPrompt } from '../scan/aiScanner';
import type { FileFacts } from '../scan/duplication';
import { assembleTree, commonRootOf, folderOf, relativePathOf } from './model';
import type { ArchitectureNode, DomainGroup } from './model';

export const DOMAIN_INFER_MAX_TOKENS = 900;
const MAX_SUMMARY_FOLDERS = 40;
const MAX_FOLDER_SAMPLES = 3;

export const DOMAIN_INFER_SYSTEM = [
  'You group a codebase into high-level architecture domains.',
  'Use the folder summary and the deterministic domains as evidence. Every folder must belong to exactly one domain.',
  'Name domains by ROLE from the evidence: Frontend, Backend, Database, Workers, Infrastructure, Integrations.',
  'Keep the Unclassified label only for folders whose samples show no clearer role.',
  'You may rename Unclassified only when you assign its folders to a named domain with evidence.',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"domains":[{"label":"","description":"","folders":[],"subsystems":[]}]}',
  'Rules: 2 to 8 domains; label is 1-3 words; description is one short factual sentence; folders are exact relative paths copied from the summary; subsystems lists the main subsystem names inside the domain; every folder from the summary appears in exactly one domain.',
].join('\n');

export interface InferredDomain {
  label: string;
  description: string;
  folders: string[];
  subsystems: string[];
}

export interface InferDomainsDeps {
  provider: LLMProvider | undefined;
  model: string;
  signal?: AbortSignal;
  cache?: Map<string, InferredDomain[]>;
}

function repairAndParse(raw: string): unknown {
  const repaired = repairJson(raw);
  const direct = tryParseJson(repaired);
  if (direct !== undefined) {
    return direct;
  }
  const extracted = extractBalanced(repaired);
  return extracted ? tryParseJson(extracted) : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed) {
      out.push(trimmed);
    }
  }
  return out;
}

export function parseInferredDomains(raw: string): InferredDomain[] | undefined {
  const parsed = parseJsonLoose(raw) ?? repairAndParse(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const entries = (parsed as { domains?: unknown }).domains;
  if (!Array.isArray(entries) || entries.length === 0) {
    return undefined;
  }
  const domains: InferredDomain[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!label || /^application$/i.test(label)) {
      return undefined;
    }
    const folders = stringList(record.folders);
    if (folders.length === 0) {
      return undefined;
    }
    domains.push({
      label,
      description: typeof record.description === 'string' ? record.description.trim() : '',
      folders,
      subsystems: stringList(record.subsystems),
    });
  }
  return domains;
}

const SERVICE_NAME = /(Service|Manager|UseCase|Interactor)$/i;
const SERVICE_SEGMENT = /^(services?|usecases?|use-cases|managers?|logic)$/i;
const COMPONENT_SEGMENT = /^(components?|ui|widgets?)$/i;
const DB_IMPORT =
  /(^|\/)(pg|mysql2?|sqlite3?|better-sqlite3|prisma|sequelize|typeorm|knex|mongoose|mongodb|drizzle-orm)(\/|$)/i;
const IPC_IMPORT = /@tauri-apps|(^|\/)(electron|ipcRenderer|ipcMain)(\/|$)/i;

interface FolderInfo {
  count: number;
  samples: string[];
  extensions: Map<string, number>;
  roles: Set<string>;
  domains: Map<string, number>;
}

function stemOfRelative(relative: string): string {
  const base = relative.slice(relative.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function extensionOfRelative(relative: string): string {
  const base = relative.slice(relative.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '(none)';
}

function fileRoles(file: FileFacts, relative: string): string[] {
  const roles: string[] = [];
  const stem = stemOfRelative(relative);
  const segments = relative.split('/').slice(0, -1);
  if (file.handlers.length > 0) {
    roles.push('handlers');
  }
  if (SERVICE_NAME.test(stem) || segments.some((segment) => SERVICE_SEGMENT.test(segment))) {
    roles.push('services');
  }
  if (
    /\.(tsx|jsx)$/i.test(relative) ||
    /Component$/.test(stem) ||
    segments.some((segment) => COMPONENT_SEGMENT.test(segment))
  ) {
    roles.push('components');
  }
  if (file.sql.length > 0 || file.imports.some((record) => DB_IMPORT.test(record.specifier))) {
    roles.push('db-imports');
  }
  if (file.imports.some((record) => IPC_IMPORT.test(record.specifier))) {
    roles.push('ipc');
  }
  return roles;
}

function topEntries(counts: Map<string, number>, limit: number): Array<[string, number]> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

export function buildDomainSummary(facts: FileFacts[], tree: ArchitectureNode): string {
  const root = commonRootOf(facts.map((file) => file.file));
  const domainByFile = new Map<string, string>();
  for (const child of tree.children) {
    for (const file of child.files) {
      domainByFile.set(file, child.label);
    }
  }
  const folders = new Map<string, FolderInfo>();
  for (const file of facts) {
    const folder = folderOf(file.file, root) || '.';
    const relative = relativePathOf(file.file, root);
    const entry = folders.get(folder) ?? {
      count: 0,
      samples: [],
      extensions: new Map<string, number>(),
      roles: new Set<string>(),
      domains: new Map<string, number>(),
    };
    entry.count++;
    if (entry.samples.length < MAX_FOLDER_SAMPLES) {
      entry.samples.push(relative);
    }
    const extension = extensionOfRelative(relative);
    entry.extensions.set(extension, (entry.extensions.get(extension) ?? 0) + 1);
    for (const role of fileRoles(file, relative)) {
      entry.roles.add(role);
    }
    const domain = domainByFile.get(file.file);
    if (domain) {
      entry.domains.set(domain, (entry.domains.get(domain) ?? 0) + 1);
    }
    folders.set(folder, entry);
  }
  const top = [...folders.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, MAX_SUMMARY_FOLDERS);
  const lines: string[] = ['Folders (relative to project root):'];
  for (const [folder, entry] of top) {
    const extensions = topEntries(entry.extensions, 3)
      .map(([extension, count]) => `${extension} x${count}`)
      .join(', ');
    const roles = [...entry.roles].sort().join(', ');
    const domains = topEntries(entry.domains, 1).map(([label]) => label);
    lines.push(
      `- ${folder} (${entry.count} file${entry.count === 1 ? '' : 's'}) [ext ${extensions || 'none'}] [roles ${roles || 'none'}] [domain ${domains[0] ?? 'unknown'}]`,
    );
    if (entry.samples.length > 0) {
      lines.push(`  samples: ${entry.samples.join(', ')}`);
    }
  }
  lines.push('', 'Deterministic domains:');
  for (const child of tree.children) {
    lines.push(`- ${child.label} (${child.files.length} file${child.files.length === 1 ? '' : 's'})`);
  }
  return lines.join('\n');
}

function normalizedFolder(folder: string): string {
  return folder.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
}

function domainKey(label: string, index: number, used: Set<string>): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let key = `ai:${base || 'domain'}`;
  if (used.has(key)) {
    key = `${key}-${index + 1}`;
  }
  used.add(key);
  return key;
}

export function assignDomains(
  facts: FileFacts[],
  domains: InferredDomain[],
): DomainGroup[] | undefined {
  const root = commonRootOf(facts.map((file) => file.file));
  const used = new Set<string>();
  const groups: DomainGroup[] = domains.map((domain, index) => ({
    key: domainKey(domain.label, index, used),
    label: domain.label,
    description: domain.description || `Files grouped as ${domain.label}.`,
    files: [],
  }));
  for (const file of facts) {
    const folder = folderOf(file.file, root);
    let best = -1;
    let bestLength = -1;
    domains.forEach((domain, index) => {
      for (const raw of domain.folders) {
        const candidate = normalizedFolder(raw);
        if (!candidate || candidate === '.') {
          if (bestLength < 0) {
            best = index;
            bestLength = 0;
          }
          continue;
        }
        if (folder === candidate || folder.startsWith(`${candidate}/`)) {
          if (candidate.length > bestLength) {
            best = index;
            bestLength = candidate.length;
          }
        }
      }
    });
    if (best === -1) {
      return undefined;
    }
    groups[best].files.push(file);
  }
  const nonEmpty = groups.filter((group) => group.files.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : undefined;
}

export async function inferDomains(
  facts: FileFacts[],
  deterministicTree: ArchitectureNode,
  deps: InferDomainsDeps,
): Promise<ArchitectureNode> {
  if (facts.length === 0 || !deps.provider) {
    return deterministicTree;
  }
  const summary = buildDomainSummary(facts, deterministicTree);
  const hash = createHash('sha1').update(summary).digest('hex');
  const cached = deps.cache?.get(hash);
  if (cached) {
    const groups = assignDomains(facts, cached);
    if (groups) {
      return assembleTree(groups, facts);
    }
  }
  try {
    const prompt: AiPrompt = { system: DOMAIN_INFER_SYSTEM, user: summary };
    const raw = await collectCompletion(
      deps.provider,
      deps.model,
      prompt,
      deps.signal ?? new AbortController().signal,
      DOMAIN_INFER_MAX_TOKENS,
    );
    const domains = parseInferredDomains(raw);
    if (!domains) {
      return deterministicTree;
    }
    const groups = assignDomains(facts, domains);
    if (!groups) {
      return deterministicTree;
    }
    deps.cache?.set(hash, domains);
    return assembleTree(groups, facts);
  } catch {
    return deterministicTree;
  }
}
