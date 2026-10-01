import type { FileFacts, HandlerRecord } from './duplication';
import type { CrossFileIndex } from './crossFile';
import { resolveSpecifier, shortName } from './crossFile';

export interface Convention {
  id: string;
  statement: string;
  confidence: number;
  evidence: string[];
}

export type ConventionDomain = 'auth' | 'validation' | 'naming' | 'layering';

export const CONVENTIONS_HEADING = '## Conventions';

const AUTH_HANDLER_MIN = 3;
const AUTH_PRESENT_RATIO = 0.6;
const AUTH_ABSENT_RATIO = 0.25;
const AUTH_ABSENT_HANDLER_MIN = 4;
const VALIDATION_MIN = 3;
const NAMING_MIN = 5;
const NAMING_LIMIT = 3;
const LAYERING_MIN = 3;
const LAYERING_RATIO = 0.8;
const EVIDENCE_LIMIT = 5;

const HANDLER_DIR = /^(handlers?|controllers?|routes?|routers?|endpoints?|resolvers?|middleware|api)$/i;
const SERVICE_DIR = /^(services?|domain|usecases?|use-cases|business|logic|managers?|interactors?)$/i;
const REPO_DIR = /^(repos?|repositories|daos?|database|db|persistence|storage|models?|entities?|gateways?)$/i;
const HANDLER_STEM = /(Handler|Controller|Route|Router|Endpoint|Resolver|Middleware)$/;
const SERVICE_STEM = /(Service|Manager|UseCase|Interactor)$/;
const REPO_STEM = /(Repo|Repository|Dao|Gateway)$/;
const VALIDATION_NAME = /validat|sanitiz|schema|zod|joi|yup|assert|guard/i;

export const NAMING_SUFFIXES = [
  'Service',
  'Controller',
  'Handler',
  'Repository',
  'Repo',
  'Manager',
  'Router',
  'Route',
  'Middleware',
  'Store',
  'Factory',
  'Client',
  'Adapter',
  'Validator',
  'Schema',
  'Model',
  'Dto',
  'Util',
  'Helper',
];

export type FileLayer = 'handlers' | 'services' | 'repositories';

interface FileInfo {
  dir: string;
  dirs: string[];
  stem: string;
  ext: string;
}

function fileInfo(uri: string): FileInfo | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  const pathname = url.pathname;
  const slash = pathname.lastIndexOf('/');
  const dir = slash >= 0 ? pathname.slice(0, slash) : '';
  const base = slash >= 0 ? pathname.slice(slash + 1) : pathname;
  const dot = base.lastIndexOf('.');
  return {
    dir,
    dirs: dir.split('/').filter(Boolean),
    stem: dot > 0 ? base.slice(0, dot) : base,
    ext: dot > 0 ? base.slice(dot) : '',
  };
}

export function dirOf(uri: string): string {
  const info = fileInfo(uri);
  return info?.dir ?? '';
}

export function classifyLayer(uri: string): FileLayer | undefined {
  const info = fileInfo(uri);
  if (!info) {
    return undefined;
  }
  for (const segment of info.dirs) {
    if (HANDLER_DIR.test(segment)) {
      return 'handlers';
    }
    if (SERVICE_DIR.test(segment)) {
      return 'services';
    }
    if (REPO_DIR.test(segment)) {
      return 'repositories';
    }
  }
  if (HANDLER_STEM.test(info.stem)) {
    return 'handlers';
  }
  if (SERVICE_STEM.test(info.stem)) {
    return 'services';
  }
  if (REPO_STEM.test(info.stem)) {
    return 'repositories';
  }
  return undefined;
}

function evidenceLabel(uri: string, line: number): string {
  return `${shortName(uri)}:${line + 1}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function mineConventions(index: CrossFileIndex): Convention[] {
  const conventions: Convention[] = [];
  const auth = mineAuthPlacement(index);
  if (auth) {
    conventions.push(auth);
  }
  const validation = mineValidationPlacement(index);
  if (validation) {
    conventions.push(validation);
  }
  conventions.push(...mineNamingSuffixes(index));
  const layering = mineRepositoryLayering(index);
  if (layering) {
    conventions.push(layering);
  }
  return conventions;
}

function handlersOf(index: CrossFileIndex): Array<{ file: string; handler: HandlerRecord }> {
  const out: Array<{ file: string; handler: HandlerRecord }> = [];
  for (const file of index.files) {
    for (const handler of file.handlers ?? []) {
      out.push({ file: file.file, handler });
    }
  }
  return out;
}

function mineAuthPlacement(index: CrossFileIndex): Convention | undefined {
  const handlers = handlersOf(index);
  if (handlers.length < AUTH_HANDLER_MIN) {
    return undefined;
  }
  const withAuth = handlers.filter((entry) => entry.handler.hasAuth);
  const ratio = withAuth.length / handlers.length;
  if (ratio >= AUTH_PRESENT_RATIO) {
    return {
      id: 'auth-placement',
      statement: `Authentication is enforced in the handler layer: ${withAuth.length} of ${handlers.length} handlers call an auth or session check.`,
      confidence: round2(ratio),
      evidence: withAuth
        .slice(0, EVIDENCE_LIMIT)
        .map((entry) => `${evidenceLabel(entry.file, entry.handler.line)} ${entry.handler.name}`),
    };
  }
  if (ratio <= AUTH_ABSENT_RATIO && handlers.length >= AUTH_ABSENT_HANDLER_MIN) {
    return {
      id: 'auth-placement',
      statement: `Authentication is not handled in most handlers (${withAuth.length} of ${handlers.length} call an auth or session check); it likely lives in middleware or a shared layer.`,
      confidence: round2(1 - ratio),
      evidence: handlers
        .slice(0, EVIDENCE_LIMIT)
        .map((entry) => `${evidenceLabel(entry.file, entry.handler.line)} ${entry.handler.name}`),
    };
  }
  return undefined;
}

function mineValidationPlacement(index: CrossFileIndex): Convention | undefined {
  const handlerValidators = handlersOf(index).filter((entry) => entry.handler.hasValidation);
  const serviceValidators: Array<{ file: string; line: number; name: string }> = [];
  for (const file of index.files) {
    if (classifyLayer(file.file) !== 'services') {
      continue;
    }
    for (const fn of file.functions ?? []) {
      if (fn.exported && VALIDATION_NAME.test(fn.name)) {
        serviceValidators.push({ file: file.file, line: fn.line, name: fn.name });
      }
    }
  }
  const handlerCount = handlerValidators.length;
  const serviceCount = serviceValidators.length;
  if (handlerCount + serviceCount < VALIDATION_MIN) {
    return undefined;
  }
  if (handlerCount >= serviceCount && handlerCount >= 2) {
    return {
      id: 'validation-placement',
      statement: `Validation happens in the handler layer: ${handlerCount} handler(s) validate input directly while ${serviceCount} validation function(s) live in service files.`,
      confidence: round2(handlerCount / (handlerCount + serviceCount)),
      evidence: handlerValidators
        .slice(0, EVIDENCE_LIMIT)
        .map((entry) => `${evidenceLabel(entry.file, entry.handler.line)} ${entry.handler.name} validates input`),
    };
  }
  return {
    id: 'validation-placement',
    statement: `Validation lives in the service layer: ${serviceCount} validation function(s) in service files versus ${handlerCount} handler(s) that validate directly.`,
    confidence: round2(serviceCount / (handlerCount + serviceCount)),
    evidence: serviceValidators
      .slice(0, EVIDENCE_LIMIT)
      .map((entry) => `${evidenceLabel(entry.file, entry.line)} ${entry.name}`),
  };
}

function mineNamingSuffixes(index: CrossFileIndex): Convention[] {
  const counts = new Map<string, Array<{ file: string; line: number; name: string }>>();
  const seen = new Set<string>();
  const add = (suffix: string, entry: { file: string; line: number; name: string }): void => {
    const key = `${entry.file}\u0000${suffix}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const list = counts.get(suffix);
    if (list) {
      list.push(entry);
    } else {
      counts.set(suffix, [entry]);
    }
  };
  for (const file of index.files) {
    const info = fileInfo(file.file);
    if (info) {
      for (const suffix of NAMING_SUFFIXES) {
        if (info.stem.length > suffix.length && info.stem.endsWith(suffix)) {
          add(suffix, { file: file.file, line: 0, name: info.stem });
        }
      }
    }
    for (const type of file.types ?? []) {
      if (type.kind !== 'class' && type.kind !== 'interface') {
        continue;
      }
      for (const suffix of NAMING_SUFFIXES) {
        if (type.name.length > suffix.length && type.name.endsWith(suffix)) {
          add(suffix, { file: file.file, line: type.line, name: type.name });
        }
      }
    }
  }
  let total = 0;
  for (const entries of counts.values()) {
    total += entries.length;
  }
  if (total === 0) {
    return [];
  }
  return [...counts.entries()]
    .filter(([, entries]) => entries.length >= NAMING_MIN)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, NAMING_LIMIT)
    .map(([suffix, entries]) => ({
      id: `naming-${suffix.toLowerCase()}`,
      statement: `Files and classes use the ${suffix} suffix: ${entries.length} occurrences (e.g. ${entries
        .slice(0, 3)
        .map((entry) => entry.name)
        .join(', ')}).`,
      confidence: round2(entries.length / total),
      evidence: entries
        .slice(0, EVIDENCE_LIMIT)
        .map((entry) => `${evidenceLabel(entry.file, entry.line)} ${entry.name}`),
    }));
}

function mineRepositoryLayering(index: CrossFileIndex): Convention | undefined {
  const known = new Set(index.files.map((file) => file.file));
  const imports: Array<{ from: string; to: string; line: number; layer: FileLayer }> = [];
  for (const file of index.files) {
    const layer = classifyLayer(file.file);
    if (layer !== 'handlers' && layer !== 'services') {
      continue;
    }
    for (const record of file.imports) {
      const to = resolveSpecifier(file.file, record.specifier, known);
      if (!to || to === file.file || classifyLayer(to) !== 'repositories') {
        continue;
      }
      imports.push({ from: file.file, to, line: record.line, layer });
    }
  }
  if (imports.length < LAYERING_MIN) {
    return undefined;
  }
  const services = imports.filter((entry) => entry.layer === 'services');
  const handlers = imports.filter((entry) => entry.layer === 'handlers');
  const dominant = services.length >= handlers.length ? services : handlers;
  const ratio = dominant.length / imports.length;
  if (ratio < LAYERING_RATIO) {
    return undefined;
  }
  const dominantName = dominant === services ? 'Service' : 'Handler';
  const otherName = dominant === services ? 'handlers' : 'services';
  return {
    id: 'layering-repository-imports',
    statement: `${dominantName} files import repositories directly (${dominant.length} of ${imports.length} imports into repository files); ${otherName} do not.`,
    confidence: round2(ratio),
    evidence: dominant
      .slice(0, EVIDENCE_LIMIT)
      .map((entry) => `${evidenceLabel(entry.from, entry.line)} imports ${shortName(entry.to)}`),
  };
}

const DOMAIN_KEYWORDS: Record<ConventionDomain, RegExp> = {
  auth: /\b(auth|authentication|authorization|authorize|login|logout|session|sessions|token|tokens|permission|permissions|guard|guards|jwt|oauth)\b/i,
  validation: /\b(validat\w*|sanitiz\w*|schema|schemas|payload|payloads|input|zod|joi|yup)\b/i,
  naming: /\b(nam\w*|renam\w*|suffix\w*|convention\w*)\b/i,
  layering: /\b(layer\w*|architect\w*|repositor\w*|import\w*)\b/i,
};

const STATEMENT_DOMAIN: Array<{ domain: ConventionDomain; pattern: RegExp }> = [
  { domain: 'auth', pattern: /\b(auth|login|session|token|permission|guard|jwt)\b/i },
  { domain: 'validation', pattern: /\b(validat\w*|sanitiz\w*|schema)\b/i },
  { domain: 'naming', pattern: /\b(suffix|naming|named|rename)\b/i },
  { domain: 'layering', pattern: /\b(repositor\w*|imports?|layer)\b/i },
];

export function conventionDomain(convention: Convention): ConventionDomain | undefined {
  if (convention.id.startsWith('auth')) {
    return 'auth';
  }
  if (convention.id.startsWith('validation')) {
    return 'validation';
  }
  if (convention.id.startsWith('naming')) {
    return 'naming';
  }
  if (convention.id.startsWith('layering')) {
    return 'layering';
  }
  for (const entry of STATEMENT_DOMAIN) {
    if (entry.pattern.test(convention.statement)) {
      return entry.domain;
    }
  }
  return undefined;
}

export function matchConvention(conventions: Convention[], text: string): Convention | undefined {
  if (!text.trim()) {
    return undefined;
  }
  for (const convention of conventions) {
    const domain = conventionDomain(convention);
    if (domain && DOMAIN_KEYWORDS[domain].test(text)) {
      return convention;
    }
  }
  return undefined;
}

export function formatConventionsSection(conventions: Convention[]): string {
  return `${CONVENTIONS_HEADING}\n${conventions.map((convention) => `- ${convention.statement.trim()}`).join('\n')}`;
}

export function parseConventionsSection(memory: string): Convention[] {
  return memorySection(memory, CONVENTIONS_HEADING)
    .filter((line) => line.startsWith('- '))
    .map((line) => ({ id: 'stored', statement: line.slice(2).trim(), confidence: 0, evidence: [] }))
    .filter((convention) => convention.statement.length > 0);
}

export function memorySection(memory: string, heading: string): string[] {
  const lines = memory.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.trim() === heading) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) {
      break;
    }
    if (inSection) {
      out.push(line);
    }
  }
  return out;
}

export function replaceMemorySection(
  memory: string,
  heading: string,
  section: string,
): string | undefined {
  const lines = memory.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    const base = memory.trimEnd();
    const next = `${base}${base ? '\n\n' : ''}${section.trimEnd()}`;
    return next === memory ? undefined : next;
  }
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) {
    end++;
  }
  const current = lines.slice(start, end).join('\n').trimEnd();
  if (current === section.trimEnd()) {
    return undefined;
  }
  return [...lines.slice(0, start), ...section.trimEnd().split('\n'), ...lines.slice(end)].join('\n');
}
