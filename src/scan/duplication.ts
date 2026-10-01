import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import type { Node, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from './languages/profiles';
import { profileFor, scanProfileFor } from './languages/profiles';
import {
  bodyOf,
  descendantsOf,
  functionsOf,
  named,
  statementsOf,
  stringContent,
} from './rules/analyzerUtils';
import { listWorkspaceFiles, TEXT_EXTENSIONS } from '../util/fsWalk';
import { matchGlob } from '../util/glob';
import { isRegexRule } from './ruleTypes';
import { stripForAi } from './strip';
import { anyPack } from './rules/any';
import { secretsMorePack } from './rules/secretsMore';

const MIN_TOKENS = 30;
const DEFAULT_SHINGLE_SIZE = 5;
const INDEX_MIN_STATEMENTS = 2;
const MAX_FILES = 2000;
const UNSUPPORTED_SOURCE_EXTENSIONS = new Set<string>();
const YIELD_EVERY = 25;
const SAVE_DEBOUNCE_MS = 1000;

const LITERAL_TEXTS = new Set(['true', 'false', 'null', 'undefined', 'none', 'nil']);

export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.php': 'php',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.sh': 'bash',
  '.bash': 'bash',
  '.ps1': 'powershell',
  '.cs': 'csharp',
  '.c': 'cpp',
  '.h': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.css': 'css',
  '.ini': 'ini',
};

export const STRUCTURAL_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.dart': 'dart',
  '.scala': 'scala',
  '.clj': 'clojure',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.lua': 'lua',
};

const STRUCTURAL_LANGUAGES = new Set(Object.values(STRUCTURAL_LANGUAGE_BY_EXTENSION));

export function isStructuralLanguage(languageId: string): boolean {
  return STRUCTURAL_LANGUAGES.has(languageId);
}

function emptyTree(): Tree {
  const node = {
    type: 'program',
    text: '',
    namedChildren: [],
    children: [],
    childForFieldName: () => null,
    descendantsOfType: () => [],
  };
  return { rootNode: node } as unknown as Tree;
}

export interface DuplicationEntry {
  file: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
  fingerprint: string;
  shingles: string[];
  name: string;
  exported: boolean;
  body: string;
}

export interface DuplicationMatch {
  file: string;
  startLine: number;
  endLine: number;
  line: number;
  similarity: number;
}

export interface DuplicationOptions {
  minStatements: number;
  threshold: number;
  maxPerFunction: number;
}

export interface DuplicationCancellationToken {
  isCancellationRequested: boolean;
}

export interface ArchitectureScanCoverage {
  unsupportedSourceFiles: number;
  parseFailures: number;
  oversizedSourceFiles: number;
  scanLimitReached: boolean;
}

export interface DuplicationIndexOptions {
  parse: (text: string, languageId: string) => Promise<Tree | undefined>;
  root?: string;
  storageFile?: string;
  getScanIgnore?: () => string[];
  getMaxFileKb?: () => number;
  getMaxFiles?: () => number;
  onProgress?: (message: string) => void;
}

export interface ImportRecord {
  specifier: string;
  names: string[];
  line: number;
}

export interface RustModuleRecord {
  name: string;
  line: number;
}

export interface TauriCommandRegistrationRecord {
  name: string;
  line: number;
}

export interface ExportRecord {
  name: string;
  line: number;
  isDefault: boolean;
}

export interface HandlerRecord {
  name: string;
  line: number;
  hasAuth: boolean;
  hasValidation: boolean;
  method: string;
  pathShape: string;
}

export interface ConstantRecord {
  name: string;
  value: string;
  line: number;
}

export interface FunctionRecord {
  name: string;
  line: number;
  paramCount: number;
  params: string[];
  exported: boolean;
  async: boolean;
  callbackStyle: boolean;
  promiseStyle: boolean;
  returnHint?: string;
}

export interface TypeRecord {
  name: string;
  kind: 'interface' | 'type' | 'class' | 'enum';
  line: number;
  exported: boolean;
  methods: string[];
  implements: string[];
  members: string[];
}

export interface HttpClientRecord {
  name: string;
  line: number;
  kind: string;
  config: string;
}

export interface HttpCallRecord {
  method: string;
  path: string;
  pathShape: string;
  line: number;
}

export interface SqlRecord {
  line: number;
  parameterized: boolean;
  concatenated: boolean;
}

export interface SecretRecord {
  value: string;
  line: number;
  ruleId: string;
}

export interface ModuleCacheRecord {
  name: string;
  kind: 'map' | 'set' | 'array' | 'object';
  line: number;
  evicted: boolean;
}

export interface ListenerRecord {
  event: string;
  line: number;
  kind: 'add' | 'remove';
  literal: boolean;
}

export interface StorageKeyRecord {
  key: string;
  access: 'read' | 'write';
  line: number;
}

export interface MutableStateRecord {
  name: string;
  kind: 'let' | 'var' | 'object' | 'array' | 'map' | 'set';
  line: number;
  exported: boolean;
}

export interface StateWriteRecord {
  name: string;
  line: number;
}

export interface PairVerdictRecord {
  verdict: 'same' | 'drifted' | 'unrelated';
  reason: string;
  recommendation: string;
}

export interface FileFacts {
  file: string;
  imports: ImportRecord[];
  rustModules?: RustModuleRecord[];
  tauriCommandRegistrations?: TauriCommandRegistrationRecord[];
  exports: ExportRecord[];
  handlers: HandlerRecord[];
  constants: ConstantRecord[];
  moduleCaches: ModuleCacheRecord[];
  listeners: ListenerRecord[];
  storageKeys: StorageKeyRecord[];
  functions: FunctionRecord[];
  types: TypeRecord[];
  httpClients: HttpClientRecord[];
  httpCalls: HttpCallRecord[];
  scopedHttpClients: HttpClientRecord[];
  mutableState: MutableStateRecord[];
  stateWrites: StateWriteRecord[];
  sql: SqlRecord[];
  secrets: SecretRecord[];
}

interface StoredFile extends FileFacts {
  mtime: number;
  size: number;
  hash: string;
  entries: DuplicationEntry[];
}

interface IndexData {
  version: number;
  files: Record<string, StoredFile>;
  aiPairs?: Record<string, PairVerdictRecord>;
}

const INDEX_VERSION = 6;
const HANDLER_NAME = /^(handle|on[A-Z_])|(handler|route|controller|endpoint|middleware)$/i;
const AUTH_HINT = /auth|authoriz|authenticate|permission|session|token|login|requireuser/i;
const VALIDATION_HINT = /validat|sanitiz|schema|zod|joi|yup|checkbody|parsebody|assert|guard/i;
const CACHE_MUTATORS = new Set([
  'set',
  'add',
  'push',
  'unshift',
  'splice',
  'pop',
  'shift',
  'delete',
  'clear',
  'append',
  'extend',
]);
const CACHE_EVICTORS = new Set(['delete', 'clear', 'pop', 'shift', 'splice']);
const STORAGE_HINT = /localstorage|sessionstorage|globalstate|workspacestate|indexeddb|asyncstorage/i;
const STORAGE_READERS = new Set(['get', 'getitem', 'has', 'contains', 'read']);
const STORAGE_WRITERS = new Set(['set', 'setitem', 'update', 'remove', 'delete', 'clear', 'push', 'store']);
const LISTENER_METHOD = /^(addeventlistener|addlistener|on|once|subscribe|listen|addhandler)$/i;
const LISTENER_REMOVER = /^(removeeventlistener|removelistener|off|unsubscribe|stoplistening|removehandler)$/i;
const HTTP_METHOD_NAMES = /^(get|post|put|patch|delete|head|options)$/i;
const HTTP_OBJECT_HINT = /fetch|axios|got|superagent|requests|httpx|api|client|http|session|rest|graphql/i;
const MAX_PAIR_BODY_CHARS = 3000;

export function normalizeFunctionTokens(node: Node, profile: LanguageProfile, text: string): string {
  const tokens: string[] = [];
  collectTokens(node, profile, text, tokens);
  return tokens.join(' ');
}

function collectTokens(node: Node, profile: LanguageProfile, text: string, out: string[]): void {
  if (profile.commentNode.includes(node.type)) {
    return;
  }
  if (profile.stringNode.includes(node.type)) {
    out.push('$STR');
    return;
  }
  if (profile.numberNode.includes(node.type)) {
    out.push('$LIT');
    return;
  }
  if (profile.trueLiteral.includes(node.type) || profile.falseLiteral.includes(node.type)) {
    out.push('$LIT');
    return;
  }
  if (node.childCount === 0) {
    const raw = node.text || text.slice(node.startIndex, node.endIndex);
    if (LITERAL_TEXTS.has(raw.toLowerCase())) {
      out.push('$LIT');
    } else if (profile.identifierNode.includes(node.type)) {
      out.push('$ID');
    } else {
      out.push(raw);
    }
    return;
  }
  for (const child of node.children) {
    if (child) {
      collectTokens(child, profile, text, out);
    }
  }
}

export function tokenShingles(tokens: string[], size = DEFAULT_SHINGLE_SIZE): string[] {
  if (size <= 0 || tokens.length < size) {
    return [];
  }
  const shingles: string[] = [];
  for (let index = 0; index + size <= tokens.length; index++) {
    shingles.push(tokens.slice(index, index + size).join(' '));
  }
  return shingles;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const value of small) {
    if (large.has(value)) {
      intersection++;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export function fingerprint(tokens: string[]): string {
  return createHash('sha1').update(tokens.join(' ')).digest('hex');
}

function isJsLike(profile: LanguageProfile): boolean {
  return profile.language === 'javascript' || profile.language === 'typescript';
}

function topLevelNodes(tree: Tree, profile: LanguageProfile): Node[] {
  const out: Node[] = [];
  for (const child of named(tree.rootNode, profile)) {
    if (child.type === 'export_statement') {
      for (const inner of named(child, profile)) {
        if (inner.type !== 'export_clause') {
          out.push(inner);
        }
      }
      continue;
    }
    out.push(child);
  }
  return out;
}

function literalValue(node: Node, profile: LanguageProfile): string | undefined {
  if (profile.stringNode.includes(node.type)) {
    if (
      node.type === 'template_string' &&
      node.namedChildren.some((child) => child?.type === 'template_substitution')
    ) {
      return undefined;
    }
    return stringContent(node);
  }
  if (profile.numberNode.includes(node.type)) {
    return node.text;
  }
  if (profile.trueLiteral.includes(node.type) || profile.falseLiteral.includes(node.type)) {
    return node.text;
  }
  if (
    node.type === 'null' ||
    node.type === 'undefined' ||
    node.type === 'none' ||
    node.type === 'nil'
  ) {
    return node.text;
  }
  return undefined;
}

function dedupeRecords<T>(records: T[], keyOf: (record: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const record of records) {
    const key = keyOf(record);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(record);
  }
  return out;
}

function callTarget(call: Node): string | undefined {
  const target =
    call.childForFieldName('function') ?? call.childForFieldName('name') ?? call.namedChildren[0];
  return target?.text;
}

function callArguments(call: Node): Node | undefined {
  const args =
    call.childForFieldName('arguments') ??
    call.namedChildren.find(
      (child) => child?.type === 'arguments' || child?.type === 'argument_list',
    );
  return args ?? undefined;
}

function importNames(node: Node, profile: LanguageProfile): string[] {
  const names: string[] = [];
  const add = (value: string | undefined): void => {
    if (value) {
      names.push(value);
    }
  };
  if (node.type === 'import_statement') {
    const clause = node.namedChildren.find((child) => child?.type === 'import_clause');
    if (clause) {
      for (const child of named(clause, profile)) {
        if (child.type === 'identifier') {
          add('default');
        } else if (child.type === 'namespace_import') {
          add('*');
        } else if (child.type === 'named_imports') {
          for (const specifier of named(child, profile)) {
            if (specifier.type !== 'import_specifier') {
              continue;
            }
            add(
              specifier.childForFieldName('alias')?.text ??
                specifier.childForFieldName('name')?.text,
            );
          }
        }
      }
    }
  } else if (node.type === 'export_statement') {
    if (node.text.replace(/\s+/g, '').startsWith('export*')) {
      add('*');
    }
    const clause = node.namedChildren.find((child) => child?.type === 'export_clause');
    if (clause) {
      for (const specifier of named(clause, profile)) {
        if (specifier.type !== 'export_specifier') {
          continue;
        }
        add(
          specifier.childForFieldName('alias')?.text ??
            specifier.childForFieldName('name')?.text,
        );
      }
    }
  }
  return [...new Set(names)];
}

function pythonFromNames(node: Node): string[] {
  const names: string[] = [];
  for (const child of node.namedChildren) {
    if (!child) {
      continue;
    }
    if (child.type === 'wildcard_import') {
      names.push('*');
    } else if (child.type === 'aliased_import') {
      const alias = child.childForFieldName('alias') ?? child.childForFieldName('name');
      if (alias) {
        names.push(alias.text);
      }
    } else if (child.type === 'dotted_name') {
      names.push(child.text.split('.').pop() ?? child.text);
    }
  }
  return [...new Set(names)];
}

interface RustUseRecord {
  specifier: string;
  names: string[];
}

function rustUseRecords(node: Node): RustUseRecord[] {
  const records: RustUseRecord[] = [];
  const walk = (current: Node, prefix: string): void => {
    if (current.type === 'scoped_identifier') {
      const full = prefix ? `${prefix}::${current.text}` : current.text;
      const name = current.childForFieldName('name')?.text ?? full.split('::').pop() ?? full;
      records.push({ specifier: full, names: [name] });
      return;
    }
    if (current.type === 'identifier') {
      records.push({
        specifier: prefix ? `${prefix}::${current.text}` : current.text,
        names: [current.text],
      });
      return;
    }
    if (current.type === 'scoped_use_list') {
      const path = current.childForFieldName('path')?.text ?? prefix;
      const list =
        current.childForFieldName('list') ??
        current.namedChildren.find((child) => child?.type === 'use_list');
      for (const child of list ? list.namedChildren : []) {
        if (child) {
          walk(child, path);
        }
      }
      return;
    }
    if (current.type === 'use_list') {
      for (const child of current.namedChildren) {
        if (child) {
          walk(child, prefix);
        }
      }
      return;
    }
    if (current.type === 'use_as_clause') {
      const path = current.childForFieldName('path')?.text ?? prefix;
      const full = prefix && !path.includes('::') ? `${prefix}::${path}` : path;
      const alias = current.childForFieldName('alias')?.text;
      records.push({ specifier: full, names: [alias ?? full.split('::').pop() ?? full] });
      return;
    }
    if (current.type === 'use_wildcard') {
      const path = current.text.replace(/::\*$/, '');
      records.push({
        specifier: prefix && !path.includes('::') ? `${prefix}::${path}` : path,
        names: ['*'],
      });
      return;
    }
    records.push({
      specifier: current.text,
      names: [current.text.split('::').pop() ?? current.text],
    });
  };
  const argument = node.childForFieldName('argument') ?? node.namedChildren[0];
  if (argument) {
    walk(argument, '');
  }
  return records;
}

function csharpUsingName(node: Node): string | undefined {
  const name = node.namedChildren.find(
    (child) => child !== null && child.type !== 'identifier',
  ) ?? node.namedChildren[0];
  return name?.text;
}

export function extractImports(tree: Tree, profile: LanguageProfile, text: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const push = (specifier: string, names: string[], line: number): void => {
    const value = specifier.trim();
    if (value) {
      out.push({ specifier: value, names, line });
    }
  };
  if (isJsLike(profile)) {
    for (const node of descendantsOf(tree.rootNode, ['import_statement', 'export_statement'])) {
      const source = node.childForFieldName('source');
      if (!source) {
        continue;
      }
      const specifier = literalValue(source, profile);
      if (specifier === undefined) {
        continue;
      }
      push(specifier, importNames(node, profile), node.startPosition.row);
    }
    for (const node of descendantsOf(tree.rootNode, ['call_expression'])) {
      const fn = node.childForFieldName('function');
      if (!fn || (fn.text !== 'require' && fn.type !== 'import')) {
        continue;
      }
      const first = callArguments(node)?.namedChildren.find((child) => child !== null);
      const specifier = first ? literalValue(first, profile) : undefined;
      if (specifier !== undefined) {
        push(specifier, [], node.startPosition.row);
      }
    }
  } else if (profile.language === 'python') {
    for (const node of descendantsOf(tree.rootNode, ['import_statement', 'import_from_statement'])) {
      if (node.type === 'import_statement') {
        const modules = descendantsOf(node, ['dotted_name']).map((child) => child.text);
        if (modules.length === 0) {
          const first = node.namedChildren[0];
          if (first) {
            modules.push(first.text);
          }
        }
        for (const module of modules) {
          push(module, [module.split('.').pop() ?? module], node.startPosition.row);
        }
      } else {
        const module = node.childForFieldName('module_name');
        if (module) {
          push(module.text, pythonFromNames(node), node.startPosition.row);
        }
      }
    }
  } else if (profile.language === 'java') {
    for (const node of descendantsOf(tree.rootNode, ['import_declaration'])) {
      const scoped = descendantsOf(node, ['scoped_identifier', 'identifier'])[0];
      if (scoped) {
        const parts = scoped.text.split('.');
        push(scoped.text, [parts[parts.length - 1]], node.startPosition.row);
      }
    }
  } else if (profile.language === 'go') {
    for (const node of descendantsOf(tree.rootNode, ['import_spec'])) {
      const literal =
        node.childForFieldName('path') ??
        descendantsOf(node, ['interpreted_string_literal', 'raw_string_literal'])[0];
      const specifier = literal ? literalValue(literal, profile) : undefined;
      if (specifier !== undefined) {
        push(specifier, [], node.startPosition.row);
      }
    }
  } else if (profile.language === 'php') {
    for (const node of descendantsOf(tree.rootNode, ['namespace_use_clause'])) {
      const name = node.childForFieldName('name') ?? node.namedChildren[0];
      if (name) {
        const parts = name.text.split('\\');
        push(name.text, [parts[parts.length - 1]], node.startPosition.row);
      }
    }
  } else if (profile.language === 'rust') {
    for (const node of descendantsOf(tree.rootNode, ['use_declaration'])) {
      for (const record of rustUseRecords(node)) {
        push(record.specifier, record.names, node.startPosition.row);
      }
    }
  } else if (profile.language === 'csharp') {
    for (const node of descendantsOf(tree.rootNode, ['using_directive'])) {
      const name = csharpUsingName(node);
      if (name) {
        const parts = name.split('.');
        push(name, [parts[parts.length - 1]], node.startPosition.row);
      }
    }
  } else if (profile.language === 'cpp') {
    for (const node of descendantsOf(tree.rootNode, ['preproc_include'])) {
      const pathNode = node.childForFieldName('path') ?? node.namedChildren[0];
      if (!pathNode) {
        continue;
      }
      const specifier =
        pathNode.type === 'system_lib_string'
          ? pathNode.text.replace(/^</, '').replace(/>$/, '').trim()
          : stringContent(pathNode).trim();
      if (specifier) {
        const base = specifier.split('/').pop() ?? specifier;
        push(specifier, [base.replace(/\.[^.]+$/, '')], node.startPosition.row);
      }
    }
  } else if (profile.language === 'ruby') {
    for (const node of descendantsOf(tree.rootNode, ['call'])) {
      const method = node.childForFieldName('method')?.text;
      if (method !== 'require' && method !== 'require_relative') {
        continue;
      }
      const args = node.childForFieldName('arguments');
      const first = args?.namedChildren.find(
        (child) => child !== null && profile.stringNode.includes(child.type),
      );
      if (!first) {
        continue;
      }
      const specifier = stringContent(first).trim();
      if (specifier) {
        const base = specifier.split('/').pop() ?? specifier;
        push(specifier, [base.replace(/\.[^.]+$/, '')], node.startPosition.row);
      }
    }
  } else if (profile.language === 'bash') {
    for (const node of descendantsOf(tree.rootNode, ['command'])) {
      const name = node.childForFieldName('name')?.text;
      if (name !== 'source' && name !== '.') {
        continue;
      }
      const first = node.childrenForFieldName('argument')[0];
      if (!first) {
        continue;
      }
      const specifier = (stringContent(first) || first.text).trim();
      if (specifier) {
        const base = specifier.split('/').pop() ?? specifier;
        push(specifier, [base.replace(/\.[^.]+$/, '')], node.startPosition.row);
      }
    }
  } else if (profile.language === 'powershell') {
    for (const node of descendantsOf(tree.rootNode, ['command'])) {
      const name = node.childForFieldName('command_name')?.text ?? node.namedChildren[0]?.text;
      if (!/^Import-Module$/i.test(name ?? '')) {
        continue;
      }
      const first = descendantsOf(node, [
        'generic_token',
        'verbatim_command_argument',
        'string_literal',
        'expandable_string_literal',
      ])[0];
      if (first) {
        const specifier = (stringContent(first) || first.text).trim();
        if (specifier) {
          push(specifier, [specifier.split('/').pop() ?? specifier], node.startPosition.row);
        }
      }
    }
    for (const node of descendantsOf(tree.rootNode, ['pipeline'])) {
      const match = /^\s*using\s+(?:module|namespace)\s+([^\s;]+)/.exec(node.text);
      if (match) {
        push(match[1], [match[1].split('.').pop() ?? match[1]], node.startPosition.row);
      }
    }
  }
  return dedupeRecords(
    out,
    (record) => `${record.specifier}\u0000${record.line}\u0000${record.names.join(',')}`,
  );
}

function extractRustModules(tree: Tree, profile: LanguageProfile): RustModuleRecord[] {
  if (profile.language !== 'rust') {
    return [];
  }
  return descendantsOf(tree.rootNode, ['mod_item'])
    .filter((node) => !node.childForFieldName('body'))
    .flatMap((node) => {
      const name = node.childForFieldName('name')?.text;
      return name ? [{ name, line: node.startPosition.row }] : [];
    });
}

function extractTauriCommandRegistrations(
  tree: Tree,
  profile: LanguageProfile,
): TauriCommandRegistrationRecord[] {
  if (profile.language !== 'rust') {
    return [];
  }
  const registrations: TauriCommandRegistrationRecord[] = [];
  for (const node of descendantsOf(tree.rootNode, ['macro_invocation'])) {
    const invocation = node.text;
    if (!/\bgenerate_handler\s*!/.test(invocation)) {
      continue;
    }
    const body = invocation.match(/\bgenerate_handler\s*!\s*\[([\s\S]*?)\]/)?.[1];
    if (!body) {
      continue;
    }
    for (const candidate of body.split(',')) {
      const path = candidate.trim().replace(/\s+/g, '');
      const name = path.split('::').filter(Boolean).at(-1);
      if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        registrations.push({ name, line: node.startPosition.row });
      }
    }
  }
  return registrations;
}

export function extractExports(tree: Tree, profile: LanguageProfile, text: string): ExportRecord[] {
  const out: ExportRecord[] = [];
  const add = (name: string | undefined, line: number, isDefault: boolean): void => {
    const value = name?.trim();
    if (value) {
      out.push({ name: value, line, isDefault });
    }
  };
  if (profile.language === 'rust') {
    for (const match of text.matchAll(/^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|union|type)\s+([A-Za-z_]\w*)/gm)) {
      add(match[1], lineAt(text, match.index ?? 0), false);
    }
  } else if (profile.language === 'csharp') {
    for (const match of text.matchAll(/^\s*public\s+(?:sealed\s+|abstract\s+|static\s+|partial\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/gm)) {
      add(match[1], lineAt(text, match.index ?? 0), false);
    }
  }
  if (isJsLike(profile)) {
    for (const node of named(tree.rootNode, profile)) {
      if (node.type !== 'export_statement') {
        continue;
      }
      const line = node.startPosition.row;
      const stripped = node.text.replace(/\s+/g, '');
      if (stripped.startsWith('export*')) {
        add('*', line, false);
        continue;
      }
      const clause = node.namedChildren.find((child) => child?.type === 'export_clause');
      if (clause) {
        for (const specifier of named(clause, profile)) {
          if (specifier.type !== 'export_specifier') {
            continue;
          }
          const name =
            specifier.childForFieldName('alias')?.text ??
            specifier.childForFieldName('name')?.text;
          add(name, line, name === 'default');
        }
        continue;
      }
      if (/^export\s+default\b/.test(node.text)) {
        add('default', line, true);
        continue;
      }
      for (const child of named(node, profile)) {
        if (
          child.type === 'function_declaration' ||
          child.type === 'generator_function_declaration' ||
          child.type === 'class_declaration' ||
          child.type === 'abstract_class_declaration' ||
          child.type === 'interface_declaration' ||
          child.type === 'type_alias_declaration' ||
          child.type === 'enum_declaration'
        ) {
          add(child.childForFieldName('name')?.text, line, false);
        } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
          for (const declarator of named(child, profile)) {
            if (declarator.type === 'variable_declarator') {
              add(declarator.childForFieldName('name')?.text, line, false);
            }
          }
        }
      }
    }
  } else if (profile.language === 'python') {
    for (const child of named(tree.rootNode, profile)) {
      if (child.type === 'function_definition' || child.type === 'class_definition') {
        add(child.childForFieldName('name')?.text, child.startPosition.row, false);
      }
    }
  } else if (profile.language === 'java') {
    for (const child of named(tree.rootNode, profile)) {
      if (
        child.type === 'class_declaration' ||
        child.type === 'interface_declaration' ||
        child.type === 'enum_declaration'
      ) {
        add(child.childForFieldName('name')?.text, child.startPosition.row, false);
      }
    }
  } else if (profile.language === 'go') {
    for (const child of named(tree.rootNode, profile)) {
      if (child.type === 'function_declaration' || child.type === 'type_declaration') {
        const name =
          child.childForFieldName('name')?.text ??
          descendantsOf(child, ['type_identifier'])[0]?.text;
        if (name && /^[A-Z]/.test(name)) {
          add(name, child.startPosition.row, false);
        }
      }
    }
  } else if (profile.language === 'php') {
    for (const child of named(tree.rootNode, profile)) {
      if (child.type === 'function_definition' || child.type === 'class_declaration') {
        add(child.childForFieldName('name')?.text, child.startPosition.row, false);
      }
    }
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.line}`);
}

function handlerRecord(
  fn: Node,
  name: string,
  profile: LanguageProfile,
  method?: string,
  pathShape?: string,
): HandlerRecord {
  const body = bodyOf(fn) ?? fn;
  let hasAuth = false;
  let hasValidation = false;
  for (const call of descendantsOf(body, profile.callNode)) {
    const target = callTarget(call);
    if (!target) {
      continue;
    }
    if (!hasAuth && AUTH_HINT.test(target)) {
      hasAuth = true;
    }
    if (!hasValidation && VALIDATION_HINT.test(target)) {
      hasValidation = true;
    }
    if (hasAuth && hasValidation) {
      break;
    }
  }
  return {
    name,
    line: fn.startPosition.row,
    hasAuth,
    hasValidation,
    method: method ?? handlerMethod(name),
    pathShape: pathShape ?? handlerPathShape(body, profile),
  };
}

function rustAttributes(fn: Node): string {
  const parts: string[] = [];
  let current = fn.previousNamedSibling;
  while (current && current.type === 'attribute_item') {
    parts.push(current.text);
    current = current.previousNamedSibling;
  }
  return parts.join('');
}

function csharpRouteAttribute(
  fn: Node,
): { method: string; path: string } | undefined {
  for (const attribute of descendantsOf(fn, ['attribute'])) {
    const name = attribute.childForFieldName('name')?.text ?? attribute.namedChildren[0]?.text ?? '';
    const http = /^Http(Get|Post|Put|Patch|Delete|Head|Options)$/i.exec(name);
    if (!http && !/^Route$/i.test(name)) {
      continue;
    }
    const literal = descendantsOf(attribute, [
      'string_literal',
      'verbatim_string_literal',
      'raw_string_literal',
    ])[0];
    const raw = literal ? stringContent(literal).trim() : '';
    const path = raw ? normalizePathShape(raw.startsWith('/') ? raw : `/${raw}`) : '';
    return { method: http ? http[1].toUpperCase() : '', path };
  }
  return undefined;
}

function routeShapeOf(route: string): string {
  const normalized = route && !route.startsWith('/') ? `/${route}` : route;
  return normalized
    .replace(/\{[^}]+\}/g, ':p')
    .replace(/:[A-Za-z_][\w]*/g, ':p')
    .replace(/\/\d+/g, '/:n');
}

function frameworkHandlers(text: string): HandlerRecord[] {
  const out: HandlerRecord[] = [];
  const push = (name: string, method: string, route: string, index: number): void => {
    out.push({
      name,
      line: lineAt(text, index),
      hasAuth: false,
      hasValidation: false,
      method,
      pathShape: routeShapeOf(route),
    });
  };
  let match: RegExpExecArray | null;
  const nest = /@(Get|Post|Put|Patch|Delete|All)\(\s*(['"`])([^'"`]*)\2?\s*\)/g;
  while ((match = nest.exec(text)) !== null) {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 240);
    const name = /(?:async\s+)([A-Za-z_$][\w$]*)\s*\(|([A-Za-z_$][\w$]*)\s*\(/.exec(after);
    push(name?.[1] ?? name?.[2] ?? 'handler', match[1].toUpperCase(), match[3], match.index);
  }
  const express = /(?:app|router|server)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]*)\2\s*,\s*(?:async\s+)?([A-Za-z_$][\w$]*)?/g;
  while ((match = express.exec(text)) !== null) {
    push(match[4] ?? 'handler', match[1].toUpperCase(), match[3], match.index);
  }
  const spring = /@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?(?:['"]([^'"]*)['"]|\{)/g;
  while ((match = spring.exec(text)) !== null) {
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 400);
    const signature = /[\w<>\[\], .?]+\s+([A-Za-z_]\w*)\s*\(/.exec(after);
    push(
      signature?.[1] ?? 'handler',
      match[1] === 'Request' ? '' : match[1].toUpperCase(),
      match[2] ?? '',
      match.index,
    );
  }
  return out;
}

export function extractHandlers(tree: Tree, profile: LanguageProfile, text: string): HandlerRecord[] {
  const out: HandlerRecord[] = [];
  for (const fn of functionsOf(tree, profile)) {
    const name = fn.childForFieldName('name')?.text;
    if (!name || !HANDLER_NAME.test(name)) {
      continue;
    }
    out.push(handlerRecord(fn, name, profile));
  }
  if (profile.language === 'rust') {
    for (const fn of descendantsOf(tree.rootNode, ['function_item'])) {
      const name = fn.childForFieldName('name')?.text;
      if (!name) {
        continue;
      }
      const attributes = rustAttributes(fn).replace(/\s+/g, '');
      if (/#\[(tauri::)?command[(\]]/.test(attributes)) {
        out.push(handlerRecord(fn, name, profile, 'IPC', ''));
      }
    }
  } else if (profile.language === 'csharp') {
    for (const fn of descendantsOf(tree.rootNode, ['method_declaration', 'local_function_statement'])) {
      const name = fn.childForFieldName('name')?.text;
      if (!name) {
        continue;
      }
      const route = csharpRouteAttribute(fn);
      if (route) {
        out.push(
          handlerRecord(
            fn,
            name,
            profile,
            route.method,
            route.path || handlerPathShape(bodyOf(fn) ?? fn, profile),
          ),
        );
      }
    }
  }
  out.push(...frameworkHandlers(text));
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.line}`);
}

function handlerMethod(name: string): string {
  const stripped = name.replace(/^(handle|on|route|process)/i, '');
  const match = /^(get|post|put|patch|delete|head|options)/i.exec(stripped);
  return match ? match[1].toUpperCase() : '';
}

function handlerPathShape(body: Node, profile: LanguageProfile): string {
  for (const node of descendantsOf(body, profile.stringNode)) {
    const content = stringContent(node);
    if (content.length > 1 && content.startsWith('/')) {
      return normalizePathShape(content);
    }
  }
  return '';
}

function normalizePathShape(path: string): string {
  const normalized = path
    .replace(/\{[^}]+\}/g, ':p')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
  return normalized || '/';
}

export function extractConstants(tree: Tree, profile: LanguageProfile, text: string): ConstantRecord[] {
  const out: ConstantRecord[] = [];
  const add = (name: string | undefined, value: string | undefined, line: number): void => {
    if (name && value !== undefined) {
      out.push({ name, value, line });
    }
  };
  if (isJsLike(profile)) {
    for (const node of topLevelNodes(tree, profile)) {
      if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
        continue;
      }
      for (const declarator of named(node, profile)) {
        if (declarator.type !== 'variable_declarator') {
          continue;
        }
        const name = declarator.childForFieldName('name');
        const value = declarator.childForFieldName('value');
        if (!name || !value || name.type !== 'identifier') {
          continue;
        }
        add(name.text, literalValue(value, profile), declarator.startPosition.row);
      }
    }
  } else if (profile.language === 'python') {
    for (const node of topLevelNodes(tree, profile)) {
      if (node.type !== 'expression_statement') {
        continue;
      }
      for (const assignment of named(node, profile)) {
        if (assignment.type !== 'assignment') {
          continue;
        }
        const name = assignment.childForFieldName('left');
        const value = assignment.childForFieldName('right');
        if (!name || !value || name.type !== 'identifier') {
          continue;
        }
        add(name.text, literalValue(value, profile), assignment.startPosition.row);
      }
    }
  } else if (profile.language === 'go') {
    for (const node of topLevelNodes(tree, profile)) {
      if (node.type !== 'const_declaration' && node.type !== 'var_declaration') {
        continue;
      }
      for (const spec of named(node, profile)) {
        if (spec.type !== 'const_spec' && spec.type !== 'var_spec') {
          continue;
        }
        const name = spec.childForFieldName('name') ?? spec.namedChildren[0];
        const value =
          spec.childForFieldName('value') ?? spec.namedChildren[spec.namedChildren.length - 1];
        if (name && value) {
          add(name.text, literalValue(value, profile), spec.startPosition.row);
        }
      }
    }
  } else if (profile.language === 'java') {
    for (const node of topLevelNodes(tree, profile)) {
      if (node.type !== 'field_declaration') {
        continue;
      }
      for (const declarator of named(node, profile)) {
        if (declarator.type !== 'variable_declarator') {
          continue;
        }
        const name = declarator.childForFieldName('name');
        const value = declarator.childForFieldName('value');
        if (name && value) {
          add(name.text, literalValue(value, profile), declarator.startPosition.row);
        }
      }
    }
  } else if (profile.language === 'php') {
    for (const node of descendantsOf(tree.rootNode, ['const_element'])) {
      const name = node.childForFieldName('name') ?? node.namedChildren[0];
      const value = node.childForFieldName('value') ?? node.namedChildren[1];
      if (name && value) {
        add(name.text, literalValue(value, profile), node.startPosition.row);
      }
    }
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.value}\u0000${record.line}`);
}

function parameterNodes(node: Node, profile: LanguageProfile): Node[] {
  const params = node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
  return params ? named(params, profile) : [];
}

function parameterText(node: Node): string {
  if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
    const pattern = node.childForFieldName('pattern') ?? node.namedChildren[0];
    return (pattern ?? node).text.trim();
  }
  if (node.type === 'assignment_pattern') {
    const left = node.childForFieldName('left') ?? node.namedChildren[0];
    return (left ?? node).text.trim();
  }
  if (
    node.type === 'typed_parameter' ||
    node.type === 'default_parameter' ||
    node.type === 'typed_default_parameter'
  ) {
    const name = node.childForFieldName('name') ?? node.namedChildren[0];
    return (name ?? node).text.trim();
  }
  return node.text.trim();
}

function isCallbackStyle(params: string[]): boolean {
  if (params.length < 2) {
    return false;
  }
  const first = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(params[0])?.[1]?.toLowerCase();
  const second = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(params[1])?.[1]?.toLowerCase();
  if (!first || !second) {
    return false;
  }
  return (
    /^(err|error|e)$/.test(first) &&
    /^(res|result|response|data|rows|value|reply|body|record)$/.test(second)
  );
}

function isPromiseStyle(node: Node, body: Node | null, profile: LanguageProfile): boolean {
  if (/^\s*async\b/.test(node.text)) {
    return true;
  }
  if (!body) {
    return false;
  }
  if (profile.language === 'python') {
    return /\bawait\b/.test(body.text) || /\.then\s*\(/.test(body.text);
  }
  if (!isJsLike(profile)) {
    return false;
  }
  if (descendantsOf(body, ['await_expression']).length > 0) {
    return true;
  }
  return /\.then\s*\(/.test(body.text);
}

function cppDeclaratorName(node: Node | null): string | undefined {
  if (!node) {
    return undefined;
  }
  if (
    node.type === 'identifier' ||
    node.type === 'field_identifier' ||
    node.type === 'destructor_name' ||
    node.type === 'operator_name'
  ) {
    return node.text;
  }
  if (node.type === 'qualified_identifier') {
    return node.childForFieldName('name')?.text ?? node.text.split('::').pop();
  }
  const inner = node.childForFieldName('declarator');
  return inner ? cppDeclaratorName(inner) : undefined;
}

function cppDeclaratorParameters(node: Node | null): Node[] {
  if (!node) {
    return [];
  }
  if (node.type === 'function_declarator') {
    const params = node.childForFieldName('parameters');
    return params
      ? params.namedChildren.filter(
          (child): child is Node => child !== null && !child.type.includes('comment'),
        )
      : [];
  }
  const inner = node.childForFieldName('declarator');
  return inner ? cppDeclaratorParameters(inner) : [];
}

export function extractFunctions(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): FunctionRecord[] {
  const out: FunctionRecord[] = [];
  const add = (
    name: string,
    node: Node,
    exported: boolean,
    parameters?: Node[],
  ): void => {
    const params = (parameters ?? parameterNodes(node, profile)).map(parameterText);
    out.push({
      name,
      line: node.startPosition.row,
      paramCount: params.length,
      params,
      exported,
      async: /^\s*async\b/.test(node.text),
      callbackStyle: isCallbackStyle(params),
      promiseStyle: isPromiseStyle(node, bodyOf(node), profile),
      returnHint:
        node.childForFieldName('return_type')?.text ?? node.childForFieldName('result')?.text,
    });
  };
  if (isJsLike(profile)) {
    for (const node of named(tree.rootNode, profile)) {
      const exported = node.type === 'export_statement';
      const declarations = exported
        ? named(node, profile).filter((child) => child.type !== 'export_clause')
        : [node];
      for (const declaration of declarations) {
        if (
          declaration.type === 'function_declaration' ||
          declaration.type === 'generator_function_declaration'
        ) {
          const name = declaration.childForFieldName('name')?.text;
          if (name) {
            add(name, declaration, exported);
          }
        } else if (
          declaration.type === 'lexical_declaration' ||
          declaration.type === 'variable_declaration'
        ) {
          for (const declarator of named(declaration, profile)) {
            if (declarator.type !== 'variable_declarator') {
              continue;
            }
            const nameNode = declarator.childForFieldName('name');
            const value = declarator.childForFieldName('value');
            if (!nameNode || !value || nameNode.type !== 'identifier') {
              continue;
            }
            if (
              value.type !== 'arrow_function' &&
              value.type !== 'function_expression' &&
              value.type !== 'generator_function'
            ) {
              continue;
            }
            add(nameNode.text, value, exported);
          }
        }
      }
    }
  } else if (profile.language === 'python') {
    for (const node of named(tree.rootNode, profile)) {
      if (node.type !== 'function_definition') {
        continue;
      }
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, node, !name.startsWith('_'));
      }
    }
  } else if (profile.language === 'go') {
    for (const node of named(tree.rootNode, profile)) {
      if (node.type !== 'function_declaration') {
        continue;
      }
      const name = node.childForFieldName('name')?.text;
      if (name && /^[A-Z]/.test(name)) {
        add(name, node, true);
      }
    }
  } else if (profile.language === 'rust') {
    for (const node of descendantsOf(tree.rootNode, ['function_item'])) {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, node, hasVisibility(node));
      }
    }
  } else if (profile.language === 'csharp') {
    for (const node of descendantsOf(tree.rootNode, [
      'method_declaration',
      'local_function_statement',
      'constructor_declaration',
    ])) {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, node, hasModifier(node, 'public'));
      }
    }
  } else if (profile.language === 'cpp') {
    for (const node of descendantsOf(tree.rootNode, ['function_definition'])) {
      const declarator = node.childForFieldName('declarator');
      const name = cppDeclaratorName(declarator);
      if (name) {
        add(name, node, false, cppDeclaratorParameters(declarator));
      }
    }
  } else if (profile.language === 'ruby') {
    for (const node of descendantsOf(tree.rootNode, ['method', 'singleton_method'])) {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, node, !name.startsWith('_'));
      }
    }
  } else if (profile.language === 'bash') {
    for (const node of descendantsOf(tree.rootNode, ['function_definition'])) {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, node, true);
      }
    }
  } else if (profile.language === 'powershell') {
    for (const node of descendantsOf(tree.rootNode, ['function_statement'])) {
      const name = descendantsOf(node, ['function_name'])[0]?.text;
      if (name) {
        add(name, node, true);
      }
    }
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.line}`);
}

function declarationKind(type: string): TypeRecord['kind'] | undefined {
  if (type === 'interface_declaration') {
    return 'interface';
  }
  if (type === 'type_alias_declaration') {
    return 'type';
  }
  if (type === 'class_declaration' || type === 'abstract_class_declaration') {
    return 'class';
  }
  if (type === 'enum_declaration') {
    return 'enum';
  }
  return undefined;
}

function typeMethods(node: Node, profile: LanguageProfile): string[] {
  const body =
    node.childForFieldName('body') ??
    descendantsOf(node, ['interface_body', 'class_body', 'declaration_list'])[0];
  if (!body) {
    return [];
  }
  const names: string[] = [];
  for (const child of named(body, profile)) {
    if (
      child.type === 'method_signature' ||
      child.type === 'method_definition' ||
      child.type === 'abstract_method_signature' ||
      child.type === 'method_declaration' ||
      child.type === 'function_definition' ||
      child.type === 'function_item' ||
      child.type === 'method' ||
      child.type === 'singleton_method'
    ) {
      const name =
        child.childForFieldName('name')?.text ??
        child.childForFieldName('property')?.text ??
        child.namedChildren[0]?.text;
      if (name) {
        names.push(name);
      }
    }
  }
  return [...new Set(names)];
}

function collectTypeNames(node: Node, profile: LanguageProfile, out: string[]): void {
  for (const child of named(node, profile)) {
    if (child.type === 'type_list') {
      collectTypeNames(child, profile, out);
      continue;
    }
    if (child.type === 'type_arguments') {
      continue;
    }
    if (child.type === 'generic_type') {
      const base = child.namedChildren[0];
      if (base) {
        out.push(base.text);
      }
      continue;
    }
    out.push(child.text);
  }
}

function typeImplements(node: Node, profile: LanguageProfile): string[] {
  const names: string[] = [];
  for (const clause of descendantsOf(node, ['implements_clause', 'super_interfaces'])) {
    collectTypeNames(clause, profile, names);
  }
  const superclasses = node.childForFieldName('superclasses');
  if (superclasses) {
    collectTypeNames(superclasses, profile, names);
  }
  const cleaned = names
    .map((name) => name.replace(/<.*$/, '').split('.').pop()?.trim() ?? '')
    .filter((name) => name.length > 0 && name !== 'object');
  return [...new Set(cleaned)];
}

function typeMembers(node: Node, profile: LanguageProfile): string[] {
  if (node.type === 'enum_declaration') {
    const body = descendantsOf(node, ['enum_body'])[0];
    if (!body) {
      return [];
    }
    const names: string[] = [];
    for (const child of named(body, profile)) {
      if (child.type === 'enum_assignment') {
        const name = child.childForFieldName('name') ?? child.namedChildren[0];
        if (name) {
          names.push(name.text);
        }
      } else if (child.type === 'property_identifier' || child.type === 'identifier') {
        names.push(child.text);
      }
    }
    return [...new Set(names)];
  }
  if (node.type === 'type_alias_declaration') {
    const value =
      node.childForFieldName('value') ?? node.namedChildren[node.namedChildren.length - 1];
    if (value && value.type === 'union_type') {
      return [...new Set(named(value, profile).map((child) => child.text))];
    }
  }
  return [];
}

function rustTypeKind(type: string): TypeRecord['kind'] | undefined {
  if (type === 'struct_item' || type === 'impl_item' || type === 'union_item') {
    return 'class';
  }
  if (type === 'enum_item') {
    return 'enum';
  }
  if (type === 'trait_item') {
    return 'interface';
  }
  if (type === 'type_item') {
    return 'type';
  }
  return undefined;
}

function csharpTypeKind(type: string): TypeRecord['kind'] | undefined {
  if (type === 'interface_declaration') {
    return 'interface';
  }
  if (type === 'enum_declaration') {
    return 'enum';
  }
  if (
    type === 'class_declaration' ||
    type === 'struct_declaration' ||
    type === 'record_declaration' ||
    type === 'record_struct_declaration'
  ) {
    return 'class';
  }
  return undefined;
}

function hasModifier(node: Node, name: string): boolean {
  return node.children.some(
    (child) => child?.type === 'modifier' && child.text.includes(name),
  );
}

function hasVisibility(node: Node): boolean {
  return node.children.some(
    (child) => child?.type === 'visibility_modifier' && /(^|\s)pub(\s|$)/.test(child.text),
  );
}

export function extractTypes(tree: Tree, profile: LanguageProfile, text: string): TypeRecord[] {
  const out: TypeRecord[] = [];
  const add = (name: string, kind: TypeRecord['kind'], node: Node, exported: boolean): void => {
    out.push({
      name,
      kind,
      line: node.startPosition.row,
      exported,
      methods: typeMethods(node, profile),
      implements: typeImplements(node, profile),
      members: typeMembers(node, profile),
    });
  };
  if (profile.language === 'go') {
    for (const match of text.matchAll(/^\s*type\s+([A-Z]\w*)\s+(struct|interface)\b/gm)) {
      out.push({
        name: match[1],
        kind: match[2] === 'interface' ? 'interface' : 'class',
        line: lineAt(text, match.index ?? 0),
        exported: true,
        methods: [],
        implements: [],
        members: [],
      });
    }
  }
  if (isJsLike(profile)) {
    for (const node of named(tree.rootNode, profile)) {
      const exported = node.type === 'export_statement';
      const declarations = exported
        ? named(node, profile).filter((child) => child.type !== 'export_clause')
        : [node];
      for (const declaration of declarations) {
        const kind = declarationKind(declaration.type);
        if (!kind) {
          continue;
        }
        const name = declaration.childForFieldName('name')?.text;
        if (name) {
          add(name, kind, declaration, exported);
        }
      }
    }
  } else if (profile.language === 'python') {
    for (const node of named(tree.rootNode, profile)) {
      if (node.type !== 'class_definition') {
        continue;
      }
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, 'class', node, !name.startsWith('_'));
      }
    }
  } else if (profile.language === 'java') {
    for (const node of named(tree.rootNode, profile)) {
      const kind = declarationKind(node.type);
      if (!kind) {
        continue;
      }
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, kind, node, true);
      }
    }
  } else if (profile.language === 'rust') {
    for (const node of named(tree.rootNode, profile)) {
      const kind = rustTypeKind(node.type);
      if (!kind) {
        continue;
      }
      const name =
        node.childForFieldName('name')?.text ?? node.childForFieldName('type')?.text;
      if (name) {
        add(name, kind, node, hasVisibility(node));
      }
    }
  } else if (profile.language === 'csharp') {
    for (const node of descendantsOf(tree.rootNode, profile.classNode)) {
      const kind = csharpTypeKind(node.type);
      const name = node.childForFieldName('name')?.text;
      if (kind && name) {
        add(name, kind, node, hasModifier(node, 'public'));
      }
    }
  } else if (profile.language === 'cpp') {
    for (const node of descendantsOf(tree.rootNode, [
      'class_specifier',
      'struct_specifier',
      'union_specifier',
      'enum_specifier',
    ])) {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, node.type === 'enum_specifier' ? 'enum' : 'class', node, true);
      }
    }
  } else if (profile.language === 'ruby') {
    for (const node of descendantsOf(tree.rootNode, ['class', 'module'])) {
      const name = node.childForFieldName('name')?.text;
      if (name) {
        add(name, 'class', node, true);
      }
    }
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.line}`);
}

const HTTP_CLIENT_TARGETS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'axios', pattern: /(^|\.)axios(\.create)?$/i },
  { kind: 'fetch', pattern: /(^|\.)fetch$/i },
  { kind: 'got', pattern: /(^|\.)got(\.extend)?$/i },
  { kind: 'superagent', pattern: /(^|\.)superagent$/i },
  { kind: 'requests', pattern: /(^|\.)requests(\.session)?$/i },
  { kind: 'httpx', pattern: /(^|\.)httpx(\.client)?$/i },
];

function httpClientKind(target: string): string | undefined {
  const text = target.replace(/\s+/g, '');
  if (!text) {
    return undefined;
  }
  for (const candidate of HTTP_CLIENT_TARGETS) {
    if (candidate.pattern.test(text)) {
      return candidate.kind;
    }
  }
  if (/\.create$/i.test(text) && /axios/i.test(text)) {
    return 'axios';
  }
  if (/http\.client/i.test(text)) {
    return 'http';
  }
  if (/(new)?(http|rest|api|web|graphql)client/i.test(text)) {
    return 'httpclient';
  }
  return undefined;
}

function normalizeConfigText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function httpClientConfig(kind: string, node: Node): string {
  if (kind === 'fetch') {
    const url = /['"`](https?:\/\/[^'"`\s]+)['"`]/.exec(node.text)?.[1];
    if (url) {
      return url;
    }
  }
  return normalizeConfigText(node.text);
}

export function extractHttpClients(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): HttpClientRecord[] {
  const out: HttpClientRecord[] = [];
  const add = (name: string, line: number, kind: string | undefined, node: Node): void => {
    if (!kind) {
      return;
    }
    out.push({ name, line, kind, config: httpClientConfig(kind, node) });
  };
  if (isJsLike(profile)) {
    for (const node of topLevelNodes(tree, profile)) {
      if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
        continue;
      }
      for (const declarator of named(node, profile)) {
        if (declarator.type !== 'variable_declarator') {
          continue;
        }
        const nameNode = declarator.childForFieldName('name');
        const value = declarator.childForFieldName('value');
        if (!nameNode || !value || nameNode.type !== 'identifier') {
          continue;
        }
        if (value.type === 'call_expression') {
          add(nameNode.text, declarator.startPosition.row, httpClientKind(callTarget(value) ?? ''), value);
        } else if (value.type === 'new_expression') {
          const constructor =
            value.childForFieldName('constructor')?.text ?? value.namedChildren[0]?.text ?? '';
          add(nameNode.text, declarator.startPosition.row, httpClientKind(constructor), value);
        } else if (value.type === 'arrow_function' || value.type === 'function_expression') {
          if (/\b(fetch|axios|got|superagent)\s*\(/.test(value.text)) {
            add(nameNode.text, declarator.startPosition.row, 'fetch', value);
          }
        }
      }
    }
  } else if (profile.language === 'python') {
    for (const node of topLevelNodes(tree, profile)) {
      if (node.type !== 'expression_statement') {
        continue;
      }
      for (const assignment of named(node, profile)) {
        if (assignment.type !== 'assignment') {
          continue;
        }
        const name = assignment.childForFieldName('left');
        const value = assignment.childForFieldName('right');
        if (!name || name.type !== 'identifier' || !value || value.type !== 'call') {
          continue;
        }
        add(name.text, assignment.startPosition.row, httpClientKind(callTarget(value) ?? ''), value);
      }
    }
  } else if (profile.language === 'go') {
    for (const node of topLevelNodes(tree, profile)) {
      if (node.type !== 'var_declaration' && node.type !== 'const_declaration') {
        continue;
      }
      for (const spec of named(node, profile)) {
        const name = spec.childForFieldName('name') ?? spec.namedChildren[0];
        if (name) {
          add(name.text, spec.startPosition.row, httpClientKind(spec.text), spec);
        }
      }
    }
  } else if (profile.language === 'java') {
    for (const node of topLevelNodes(tree, profile)) {
      if (node.type !== 'field_declaration') {
        continue;
      }
      for (const declarator of named(node, profile)) {
        if (declarator.type !== 'variable_declarator') {
          continue;
        }
        const name = declarator.childForFieldName('name');
        if (name) {
          add(name.text, declarator.startPosition.row, httpClientKind(declarator.text), declarator);
        }
      }
    }
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.line}`);
}

const SQL_HINT = /\b(select|insert|update|delete|from|where|join|values|into|table)\b/i;
const SQL_TARGET =
  /(query|execute|exec|raw|prepare|run|all|get|insert|update|delete|select|find|scan|sql|db|conn|pool|client|cursor|session)/i;
const SQL_PLACEHOLDER = /\?|\$\d+|:[A-Za-z_][A-Za-z0-9_]*/;

export function extractSql(tree: Tree, profile: LanguageProfile, text: string): SqlRecord[] {
  const out: SqlRecord[] = [];
  for (const call of descendantsOf(tree.rootNode, profile.callNode)) {
    const target = callTarget(call) ?? '';
    if (!SQL_TARGET.test(target)) {
      continue;
    }
    const args = callArguments(call);
    const first = args?.namedChildren.find((child) => child !== null);
    if (!first) {
      continue;
    }
    if (
      first.type === 'template_string' &&
      first.namedChildren.some((child) => child?.type === 'template_substitution')
    ) {
      if (SQL_HINT.test(first.text)) {
        out.push({ line: call.startPosition.row, parameterized: false, concatenated: true });
      }
      continue;
    }
    if (profile.stringNode.includes(first.type)) {
      const content = stringContent(first);
      if (!SQL_HINT.test(content)) {
        continue;
      }
      const rest = (args?.namedChildren ?? []).filter((child) => child !== null && child !== first);
      if (SQL_PLACEHOLDER.test(content) && rest.length > 0) {
        out.push({ line: call.startPosition.row, parameterized: true, concatenated: false });
      }
      continue;
    }
    if (first.type === 'binary_expression' || first.type === 'binary_operator') {
      if (SQL_HINT.test(first.text)) {
        out.push({ line: call.startPosition.row, parameterized: false, concatenated: true });
      }
    }
  }
  return dedupeRecords(
    out,
    (record) => `${record.line}\u0000${record.parameterized}\u0000${record.concatenated}`,
  );
}

const SECRET_RULES: Array<{ id: string; pattern: RegExp }> = (() => {
  const rules: Array<{ id: string; pattern: RegExp }> = [];
  for (const pack of [anyPack, secretsMorePack]) {
    for (const rule of pack.rules) {
      if (rule.category !== 'secret' || !isRegexRule(rule)) {
        continue;
      }
      const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
      rules.push({ id: rule.id, pattern: new RegExp(rule.pattern.source, flags) });
    }
  }
  return rules;
})();

function lineAt(text: string, index: number): number {
  let line = 0;
  for (let position = 0; position < index; position++) {
    if (text.charCodeAt(position) === 10) {
      line++;
    }
  }
  return line;
}

export function extractSecrets(text: string): SecretRecord[] {
  const out: SecretRecord[] = [];
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = rule.pattern.exec(text)) !== null && count < 10) {
      const value = match[0].trim();
      if (value.length >= 8) {
        out.push({ value, line: lineAt(text, match.index), ruleId: rule.id });
      }
      count++;
      if (match.index === rule.pattern.lastIndex) {
        rule.pattern.lastIndex++;
      }
    }
  }
  return dedupeRecords(out, (record) => `${record.value}\u0000${record.line}`);
}

function cacheKind(value: Node): ModuleCacheRecord['kind'] | undefined {
  if (value.type === 'array') {
    return 'array';
  }
  if (value.type === 'object') {
    return 'object';
  }
  if (value.type === 'new_expression') {
    const constructor =
      value.childForFieldName('constructor')?.text ?? value.namedChildren[0]?.text ?? '';
    if (/^(Weak)?Map$/.test(constructor)) {
      return 'map';
    }
    if (/^(Weak)?Set$/.test(constructor)) {
      return 'set';
    }
  }
  return undefined;
}

function isCacheMutated(root: Node, name: string, profile: LanguageProfile): boolean {
  for (const node of descendantsOf(root, profile.memberNode)) {
    const object =
      node.childForFieldName('object') ?? node.childForFieldName('value') ?? node.namedChildren[0];
    if (!object || object.text !== name) {
      continue;
    }
    if (node.type === 'subscript_expression' || node.type === 'subscript') {
      const parent = node.parent;
      if (
        parent &&
        (parent.type === 'assignment_expression' ||
          parent.type === 'augmented_assignment_expression' ||
          parent.type === 'assignment' ||
          parent.type === 'augmented_assignment')
      ) {
        return true;
      }
      continue;
    }
    const property =
      node.childForFieldName('property') ?? node.namedChildren[node.namedChildren.length - 1];
    if (property && CACHE_MUTATORS.has(property.text)) {
      return true;
    }
  }
  return false;
}

function isCacheEvicted(root: Node, name: string, profile: LanguageProfile): boolean {
  for (const node of descendantsOf(root, profile.memberNode)) {
    const object =
      node.childForFieldName('object') ?? node.childForFieldName('value') ?? node.namedChildren[0];
    if (!object || object.text !== name) {
      continue;
    }
    if (node.type === 'subscript_expression' || node.type === 'subscript') {
      const parent = node.parent;
      if (parent && parent.type === 'unary_expression' && /^\s*delete\b/.test(parent.text)) {
        return true;
      }
      continue;
    }
    const property =
      node.childForFieldName('property') ?? node.namedChildren[node.namedChildren.length - 1];
    if (property && CACHE_EVICTORS.has(property.text)) {
      return true;
    }
  }
  return false;
}

export function extractModuleCaches(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): ModuleCacheRecord[] {
  if (!isJsLike(profile)) {
    return [];
  }
  const out: ModuleCacheRecord[] = [];
  for (const node of topLevelNodes(tree, profile)) {
    if (node.type !== 'lexical_declaration' && node.type !== 'variable_declaration') {
      continue;
    }
    for (const declarator of named(node, profile)) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const name = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      if (!name || !value || name.type !== 'identifier') {
        continue;
      }
      const kind = cacheKind(value);
      if (!kind || !isCacheMutated(tree.rootNode, name.text, profile)) {
        continue;
      }
      out.push({
        name: name.text,
        kind,
        line: declarator.startPosition.row,
        evicted: isCacheEvicted(tree.rootNode, name.text, profile),
      });
    }
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.kind}\u0000${record.line}`);
}

export function extractListeners(tree: Tree, profile: LanguageProfile, text: string): ListenerRecord[] {
  const out: ListenerRecord[] = [];
  for (const call of descendantsOf(tree.rootNode, profile.callNode)) {
    const target =
      call.childForFieldName('function') ?? call.childForFieldName('name') ?? call.namedChildren[0];
    if (!target) {
      continue;
    }
    const method = /\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(target.text)?.[1];
    if (!method) {
      continue;
    }
    const add = LISTENER_METHOD.test(method);
    const remove = LISTENER_REMOVER.test(method);
    if (!add && !remove) {
      continue;
    }
    const kind: ListenerRecord['kind'] = add ? 'add' : 'remove';
    const first = callArguments(call)?.namedChildren.find((child) => child !== null);
    const literal = first !== undefined && profile.stringNode.includes(first.type);
    const event = literal ? stringContent(first) : target.text;
    out.push({ event, line: call.startPosition.row, kind, literal });
  }
  return dedupeRecords(out, (record) => `${record.event}\u0000${record.kind}\u0000${record.line}`);
}

export function extractStorageKeys(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): StorageKeyRecord[] {
  const out: StorageKeyRecord[] = [];
  for (const call of descendantsOf(tree.rootNode, profile.callNode)) {
    const target =
      call.childForFieldName('function') ?? call.childForFieldName('name') ?? call.namedChildren[0];
    if (!target || target.type === 'identifier') {
      continue;
    }
    const targetText = target.text;
    if (!STORAGE_HINT.test(targetText)) {
      continue;
    }
    const method = /\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(targetText)?.[1]?.toLowerCase();
    if (!method) {
      continue;
    }
    const access: StorageKeyRecord['access'] | undefined = STORAGE_READERS.has(method)
      ? 'read'
      : STORAGE_WRITERS.has(method)
        ? 'write'
        : undefined;
    if (!access) {
      continue;
    }
    const first = callArguments(call)?.namedChildren.find((child) => child !== null);
    if (!first || !profile.stringNode.includes(first.type)) {
      continue;
    }
    out.push({ key: stringContent(first), access, line: call.startPosition.row });
  }
  return dedupeRecords(out, (record) => `${record.key}\u0000${record.access}\u0000${record.line}`);
}

function declarationKeyword(node: Node): string {
  return node.child(0)?.text ?? 'const';
}

export function extractMutableState(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): MutableStateRecord[] {
  if (!isJsLike(profile)) {
    return [];
  }
  const out: MutableStateRecord[] = [];
  for (const node of named(tree.rootNode, profile)) {
    const exported = node.type === 'export_statement';
    const declarations = exported
      ? named(node, profile).filter((child) => child.type !== 'export_clause')
      : [node];
    for (const declaration of declarations) {
      if (declaration.type !== 'lexical_declaration' && declaration.type !== 'variable_declaration') {
        continue;
      }
      const keyword = declarationKeyword(declaration);
      for (const declarator of named(declaration, profile)) {
        if (declarator.type !== 'variable_declarator') {
          continue;
        }
        const name = declarator.childForFieldName('name');
        if (!name || name.type !== 'identifier') {
          continue;
        }
        if (keyword === 'let' || keyword === 'var') {
          if (exported) {
            out.push({ name: name.text, kind: keyword, line: declarator.startPosition.row, exported: true });
          }
          continue;
        }
        const value = declarator.childForFieldName('value');
        const kind = value ? cacheKind(value) : undefined;
        if (exported && kind && isCacheMutated(tree.rootNode, name.text, profile)) {
          out.push({ name: name.text, kind, line: declarator.startPosition.row, exported: true });
        }
      }
    }
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.line}`);
}

function rootIdentifier(node: Node | null): string | undefined {
  let current = node;
  while (current) {
    if (current.type === 'identifier' || current.type === 'property_identifier') {
      return current.text;
    }
    if (current.type === 'member_expression' || current.type === 'subscript_expression') {
      current = current.childForFieldName('object') ?? current.childForFieldName('value');
      continue;
    }
    if (current.type === 'subscript' || current.type === 'attribute') {
      current = current.childForFieldName('value') ?? current.childForFieldName('object') ?? current.namedChildren[0] ?? null;
      continue;
    }
    return undefined;
  }
  return undefined;
}

export function extractStateWrites(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): StateWriteRecord[] {
  if (!isJsLike(profile)) {
    return [];
  }
  const out: StateWriteRecord[] = [];
  for (const node of descendantsOf(tree.rootNode, [
    'assignment_expression',
    'augmented_assignment_expression',
  ])) {
    const name = rootIdentifier(node.childForFieldName('left'));
    if (name) {
      out.push({ name, line: node.startPosition.row });
    }
  }
  for (const node of descendantsOf(tree.rootNode, profile.memberNode)) {
    const object =
      node.childForFieldName('object') ?? node.childForFieldName('value') ?? node.namedChildren[0];
    const name = rootIdentifier(object ?? null);
    if (!name) {
      continue;
    }
    if (node.type === 'subscript_expression' || node.type === 'subscript') {
      const parent = node.parent;
      if (
        parent &&
        (parent.type === 'assignment_expression' ||
          parent.type === 'augmented_assignment_expression' ||
          parent.type === 'assignment' ||
          parent.type === 'augmented_assignment')
      ) {
        out.push({ name, line: node.startPosition.row });
      }
      continue;
    }
    const property =
      node.childForFieldName('property') ?? node.namedChildren[node.namedChildren.length - 1];
    if (property && CACHE_MUTATORS.has(property.text)) {
      out.push({ name, line: node.startPosition.row });
    }
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.line}`);
}

function httpCallTarget(target: string): { method: string } | undefined {
  const text = target.replace(/\s+/g, '');
  if (!text) {
    return undefined;
  }
  const member = /^(.*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (member && HTTP_METHOD_NAMES.test(member[2])) {
    return HTTP_OBJECT_HINT.test(member[1]) ? { method: member[2].toUpperCase() } : undefined;
  }
  if (/(^|\.)fetch$/i.test(text)) {
    return { method: '' };
  }
  if (/(^|\.)(axios|requests|httpx|superagent)$/i.test(text)) {
    return { method: '' };
  }
  if (/(^|\.)(got)$/i.test(text)) {
    return { method: '' };
  }
  return undefined;
}

function literalPath(node: Node | undefined, profile: LanguageProfile): string | undefined {
  if (!node || !profile.stringNode.includes(node.type)) {
    return undefined;
  }
  if (
    node.type === 'template_string' &&
    node.namedChildren.some((child) => child?.type === 'template_substitution')
  ) {
    return undefined;
  }
  const raw = stringContent(node).trim();
  if (raw.startsWith('/')) {
    return raw;
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).pathname || '/';
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function ipcCommandName(
  call: Node,
  target: string,
  profile: LanguageProfile,
): string | undefined {
  const text = target.replace(/\s+/g, '');
  if (text !== 'invoke' && !text.includes('__TAURI')) {
    return undefined;
  }
  const args = callArguments(call);
  const first = args?.namedChildren.find((child) => child !== null);
  if (!first || !profile.stringNode.includes(first.type)) {
    return undefined;
  }
  const name = (first.type === 'template_string' ? '' : stringContent(first)).trim();
  return name || undefined;
}

export function extractHttpCalls(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): HttpCallRecord[] {
  const out: HttpCallRecord[] = [];
  for (const call of descendantsOf(tree.rootNode, profile.callNode)) {
    const target = callTarget(call) ?? '';
    const info = httpCallTarget(target);
    if (!info) {
      if (isJsLike(profile)) {
        const command = ipcCommandName(call, target, profile);
        if (command) {
          out.push({ method: 'IPC', path: command, pathShape: '', line: call.startPosition.row });
        }
      }
      continue;
    }
    const args = callArguments(call);
    const first = args?.namedChildren.find((child) => child !== null);
    const path = literalPath(first, profile);
    if (!path) {
      continue;
    }
    out.push({
      method: info.method,
      path,
      pathShape: normalizePathShape(path),
      line: call.startPosition.row,
    });
  }
  return dedupeRecords(
    out,
    (record) => `${record.method}\u0000${record.pathShape}\u0000${record.line}`,
  );
}

function insideFunction(node: Node, profile: LanguageProfile): boolean {
  let current = node.parent;
  while (current) {
    if (profile.functionNodes.includes(current.type)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function extractScopedHttpClients(
  tree: Tree,
  profile: LanguageProfile,
  text: string,
): HttpClientRecord[] {
  const out: HttpClientRecord[] = [];
  for (const node of descendantsOf(tree.rootNode, profile.callNode)) {
    if (!insideFunction(node, profile)) {
      continue;
    }
    const target =
      node.type === 'new_expression'
        ? (node.childForFieldName('constructor')?.text ?? node.namedChildren[0]?.text ?? '')
        : callTarget(node) ?? '';
    const kind = httpClientKind(target);
    if (!kind || kind === 'fetch') {
      continue;
    }
    out.push({
      name: target.replace(/\s+/g, ''),
      line: node.startPosition.row,
      kind,
      config: normalizeConfigText(node.text),
    });
  }
  return dedupeRecords(out, (record) => `${record.name}\u0000${record.kind}\u0000${record.line}`);
}

export function extractFileFacts(
  tree: Tree,
  text: string,
  profile: LanguageProfile,
): Omit<FileFacts, 'file'> {
  return {
    imports: extractImports(tree, profile, text),
    rustModules: extractRustModules(tree, profile),
    tauriCommandRegistrations: extractTauriCommandRegistrations(tree, profile),
    exports: extractExports(tree, profile, text),
    handlers: extractHandlers(tree, profile, text),
    constants: extractConstants(tree, profile, text),
    moduleCaches: extractModuleCaches(tree, profile, text),
    listeners: extractListeners(tree, profile, text),
    storageKeys: extractStorageKeys(tree, profile, text),
    functions: extractFunctions(tree, profile, text),
    types: extractTypes(tree, profile, text),
    httpClients: extractHttpClients(tree, profile, text),
    httpCalls: extractHttpCalls(tree, profile, text),
    scopedHttpClients: extractScopedHttpClients(tree, profile, text),
    mutableState: extractMutableState(tree, profile, text),
    stateWrites: extractStateWrites(tree, profile, text),
    sql: extractSql(tree, profile, text),
    secrets: extractSecrets(text),
  };
}

function functionName(fn: Node): string {
  const direct = fn.childForFieldName('name')?.text;
  if (direct) {
    return direct;
  }
  if (fn.type === 'function_definition') {
    const name = cppDeclaratorName(fn.childForFieldName('declarator'));
    if (name) {
      return name;
    }
  }
  if (fn.type === 'function_statement') {
    return descendantsOf(fn, ['function_name'])[0]?.text ?? '';
  }
  let current = fn.parent;
  let depth = 0;
  while (current && depth < 4) {
    if (current.type === 'variable_declarator' || current.type === 'pair') {
      const name =
        current.childForFieldName('name') ??
        current.childForFieldName('key') ??
        current.namedChildren[0];
      if (name) {
        return name.text;
      }
    }
    if (
      current.type === 'lexical_declaration' ||
      current.type === 'variable_declaration' ||
      current.type === 'program'
    ) {
      break;
    }
    current = current.parent;
    depth++;
  }
  return '';
}

function isExportedFunction(fn: Node, name: string, profile: LanguageProfile): boolean {
  if (profile.language === 'python') {
    return name.length > 0 && !name.startsWith('_');
  }
  if (profile.language === 'go') {
    return /^[A-Z]/.test(name);
  }
  if (profile.language === 'rust') {
    return hasVisibility(fn);
  }
  if (profile.language === 'csharp' || profile.language === 'cpp') {
    return hasModifier(fn, 'public') || fn.parent?.type === 'translation_unit';
  }
  if (profile.language === 'ruby' || profile.language === 'bash' || profile.language === 'powershell') {
    return name.length > 0 && !name.startsWith('_');
  }
  let current = fn.parent;
  while (current) {
    if (current.type === 'export_statement') {
      return true;
    }
    if (
      current.type === 'program' ||
      current.type === 'class_body' ||
      current.type === 'module'
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function pairBody(body: Node, profile: LanguageProfile): string {
  return stripForAi(body.text, profile.language).text.slice(0, MAX_PAIR_BODY_CHARS);
}

export class DuplicationIndex {
  private data: IndexData = { version: INDEX_VERSION, files: {} };
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private built = false;
  private building: Promise<void> | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private revision = 0;
  private shingleIndex: Map<string, DuplicationEntry[]> | undefined;
  private shingleIndexRevision = -1;
  private architectureCoverage: ArchitectureScanCoverage = {
    unsupportedSourceFiles: 0,
    parseFailures: 0,
    oversizedSourceFiles: 0,
    scanLimitReached: false,
  };

  constructor(private readonly options: DuplicationIndexOptions) {}

  async indexFile(uri: string, text: string, languageId: string, tree?: Tree): Promise<void> {
    await this.ensureLoaded();
    const structural = isStructuralLanguage(languageId);
    const profile = profileFor(languageId) ?? (structural ? scanProfileFor(languageId) : undefined);
    if (!profile) {
      await this.removeFile(uri);
      return;
    }
    const parsed = structural ? emptyTree() : tree ?? (await this.options.parse(text, languageId));
    if (!parsed) {
      return;
    }
    const stats = await this.statsFor(uri, text);
    this.data.files[uri] = {
      file: uri,
      ...stats,
      hash: createHash('sha1').update(text).digest('hex'),
      ...extractFileFacts(parsed, text, profile),
      entries: this.entriesFor(uri, parsed, text, profile, INDEX_MIN_STATEMENTS),
    };
    this.revision++;
    this.scheduleSave();
  }

  async getFacts(): Promise<FileFacts[]> {
    await this.ensureLoaded();
    return Object.values(this.data.files).map((file) => ({
      file: file.file,
      imports: file.imports,
      rustModules: file.rustModules ?? [],
      tauriCommandRegistrations: file.tauriCommandRegistrations ?? [],
      exports: file.exports,
      handlers: file.handlers,
      constants: file.constants,
      moduleCaches: file.moduleCaches,
      listeners: file.listeners,
      storageKeys: file.storageKeys,
      functions: file.functions ?? [],
      types: file.types ?? [],
      httpClients: file.httpClients ?? [],
      httpCalls: file.httpCalls ?? [],
      scopedHttpClients: file.scopedHttpClients ?? [],
      mutableState: file.mutableState ?? [],
      stateWrites: file.stateWrites ?? [],
      sql: file.sql ?? [],
      secrets: file.secrets ?? [],
    }));
  }

  async getArchitectureCoverage(): Promise<ArchitectureScanCoverage> {
    await this.ensureLoaded();
    return { ...this.architectureCoverage };
  }

  async getFileHashes(): Promise<Map<string, string>> {
    await this.ensureLoaded();
    const hashes = new Map<string, string>();
    for (const file of Object.values(this.data.files)) {
      if (file.hash) {
        hashes.set(file.file, file.hash);
      }
    }
    return hashes;
  }

  async getEntries(): Promise<DuplicationEntry[]> {
    await this.ensureLoaded();
    const entries: DuplicationEntry[] = [];
    for (const file of Object.values(this.data.files)) {
      entries.push(...file.entries);
    }
    return entries;
  }

  async getPairVerdict(key: string): Promise<PairVerdictRecord | undefined> {
    await this.ensureLoaded();
    return this.data.aiPairs?.[key];
  }

  async setPairVerdict(key: string, verdict: PairVerdictRecord): Promise<void> {
    await this.ensureLoaded();
    if (!this.data.aiPairs) {
      this.data.aiPairs = {};
    }
    this.data.aiPairs[key] = verdict;
    this.revision++;
    this.scheduleSave();
  }

  async removeFile(uri: string): Promise<void> {
    await this.ensureLoaded();
    if (this.data.files[uri]) {
      delete this.data.files[uri];
      this.revision++;
      this.scheduleSave();
    }
  }

  async findDuplicates(
    uri: string,
    text: string,
    languageId: string,
    options: DuplicationOptions,
    tree?: Tree,
  ): Promise<DuplicationMatch[]> {
    const profile = profileFor(languageId);
    if (!profile) {
      return [];
    }
    await this.ensureLoaded();
    const parsed = tree ?? (await this.options.parse(text, languageId));
    if (!parsed) {
      return [];
    }
    const current = this.entriesFor(uri, parsed, text, profile, options.minStatements);
    if (current.length === 0) {
      return [];
    }
    const others: DuplicationEntry[] = [];
    for (const file of Object.values(this.data.files)) {
      for (const entry of file.entries) {
        if (entry.file !== uri) {
          others.push(entry);
        }
      }
    }
    if (others.length === 0) {
      return [];
    }

    const byShingle = this.shingleLookup();
    const setCache = new Map<DuplicationEntry, Set<string>>();
    const shingleSetOf = (entry: DuplicationEntry): Set<string> => {
      let set = setCache.get(entry);
      if (!set) {
        set = new Set(entry.shingles);
        setCache.set(entry, set);
      }
      return set;
    };

    const max = Math.max(1, Math.floor(options.maxPerFunction));
    const matches: DuplicationMatch[] = [];
    for (const fn of current) {
      const found: DuplicationMatch[] = [];
      const seen = new Set<string>();
      for (const entry of others) {
        if (entry.fingerprint !== fn.fingerprint) {
          continue;
        }
        const key = `${entry.file}:${entry.startLine}`;
        if (!seen.has(key)) {
          seen.add(key);
          found.push(this.toMatch(entry, fn.startLine, 1));
        }
      }
      if (found.length < max) {
        const candidates = new Set<DuplicationEntry>();
        for (const shingle of fn.shingles) {
          for (const entry of byShingle.get(shingle) ?? []) {
            if (entry.file !== uri) {
              candidates.add(entry);
            }
          }
        }
        const own = new Set(fn.shingles);
        for (const entry of candidates) {
          if (found.length >= max) {
            break;
          }
          const key = `${entry.file}:${entry.startLine}`;
          if (seen.has(key)) {
            continue;
          }
          const similarity = jaccard(own, shingleSetOf(entry));
          if (similarity >= options.threshold) {
            seen.add(key);
            found.push(this.toMatch(entry, fn.startLine, similarity));
          }
        }
      }
      found.sort(
        (a, b) => b.similarity - a.similarity || a.file.localeCompare(b.file) || a.startLine - b.startLine,
      );
      matches.push(...found.slice(0, max));
    }
    return matches;
  }

  async ensureBuilt(token?: DuplicationCancellationToken): Promise<void> {
    if (this.built) {
      return;
    }
    if (!this.building) {
      this.building = (async () => {
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Dev-First: building duplication index…',
              cancellable: true,
            },
            (_progress, progressToken) => this.build(combineTokens(token, progressToken)),
          );
        } finally {
          this.building = undefined;
        }
      })();
    }
    return this.building;
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      void this.save();
    }
  }

  private shingleLookup(): Map<string, DuplicationEntry[]> {
    if (this.shingleIndex && this.shingleIndexRevision === this.revision) {
      return this.shingleIndex;
    }
    const lookup = new Map<string, DuplicationEntry[]>();
    for (const file of Object.values(this.data.files)) {
      for (const entry of file.entries) {
        for (const shingle of new Set(entry.shingles)) {
          const list = lookup.get(shingle);
          if (list) {
            list.push(entry);
          } else {
            lookup.set(shingle, [entry]);
          }
        }
      }
    }
    this.shingleIndex = lookup;
    this.shingleIndexRevision = this.revision;
    return lookup;
  }

  private toMatch(entry: DuplicationEntry, line: number, similarity: number): DuplicationMatch {
    return {
      file: entry.file,
      startLine: entry.startLine,
      endLine: entry.endLine,
      line,
      similarity,
    };
  }

  private entriesFor(
    uri: string,
    tree: Tree,
    text: string,
    profile: LanguageProfile,
    minStatements: number,
  ): DuplicationEntry[] {
    const entries: DuplicationEntry[] = [];
    for (const fn of functionsOf(tree, profile)) {
      const body = bodyOf(fn) ?? fn;
      if (statementsOf(body, profile).length < minStatements) {
        continue;
      }
      const tokens = normalizeFunctionTokens(body, profile, text).split(' ').filter(Boolean);
      if (tokens.length < MIN_TOKENS) {
        continue;
      }
      const name = functionName(fn);
      entries.push({
        file: uri,
        startLine: fn.startPosition.row,
        endLine: fn.endPosition.row,
        tokenCount: tokens.length,
        fingerprint: fingerprint(tokens),
        shingles: tokenShingles(tokens),
        name,
        exported: isExportedFunction(fn, name, profile),
        body: pairBody(body, profile),
      });
    }
    return entries;
  }

  private async build(token?: DuplicationCancellationToken): Promise<void> {
    await this.ensureLoaded();
    const root = this.options.root;
    if (!root) {
      this.built = true;
      return;
    }
    const ignore = this.options.getScanIgnore?.() ?? [];
    const maxBytes = (this.options.getMaxFileKb?.() ?? 1024) * 1024;
    const maxFiles = Math.max(1, this.options.getMaxFiles?.() ?? MAX_FILES);
    const gitignore = await readGitignore(root);
    const nestedIgnoreCache = new Map<string, string[]>();
    const files = await listWorkspaceFiles(root, { extensions: TEXT_EXTENSIONS, maxEntries: maxFiles });
    this.architectureCoverage = {
      unsupportedSourceFiles: 0,
      parseFailures: 0,
      oversizedSourceFiles: 0,
      scanLimitReached: files.length >= maxFiles,
    };
    const seenUris = new Set<string>();
    let changed = false;
    let indexed = 0;

    for (let index = 0; index < files.length; index++) {
      if (token?.isCancellationRequested) {
        return;
      }
      if (index > 0 && index % YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
      const relative = files[index];
      const absolute = path.join(root, relative);
      seenUris.add(pathToFileURL(absolute).toString());
      if (isIgnored(absolute, relative, ignore, gitignore)) {
        continue;
      }
      if (await matchesNestedGitignore(root, absolute, nestedIgnoreCache)) {
        continue;
      }
      const extension = path.extname(absolute).toLowerCase();
      if (UNSUPPORTED_SOURCE_EXTENSIONS.has(extension)) {
        this.architectureCoverage.unsupportedSourceFiles++;
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      if (stat.size > maxBytes) {
        if (LANGUAGE_BY_EXTENSION[extension]) {
          this.architectureCoverage.oversizedSourceFiles++;
        }
        continue;
      }
      const uri = pathToFileURL(absolute).toString();
      const existing = this.data.files[uri];
      if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
        continue;
      }
      const languageId = LANGUAGE_BY_EXTENSION[extension] ?? STRUCTURAL_LANGUAGE_BY_EXTENSION[extension];
      if (!languageId) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(absolute, 'utf-8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) {
        continue;
      }
      const structural = isStructuralLanguage(languageId);
      const tree = structural ? undefined : await this.options.parse(content, languageId);
      if (!structural && !tree) {
        this.architectureCoverage.parseFailures++;
        continue;
      }
      try {
        const profile = profileFor(languageId) ?? (structural ? scanProfileFor(languageId) : undefined);
        if (!profile) {
          continue;
        }
        const parsedTree = tree ?? emptyTree();
        this.data.files[uri] = {
          file: uri,
          mtime: stat.mtimeMs,
          size: stat.size,
          hash: createHash('sha1').update(content).digest('hex'),
          ...extractFileFacts(parsedTree, content, profile),
          entries: this.entriesFor(uri, parsedTree, content, profile, INDEX_MIN_STATEMENTS),
        };
        changed = true;
        indexed++;
        this.options.onProgress?.(`Duplicate index: ${indexed} files scanned…`);
      } finally {
        tree?.delete();
      }
    }

    if (token?.isCancellationRequested) {
      return;
    }
    const rootUri = pathToFileURL(root).toString();
    for (const uri of Object.keys(this.data.files)) {
      if (uri.startsWith(rootUri) && !seenUris.has(uri)) {
        delete this.data.files[uri];
        changed = true;
      }
    }
    if (changed) {
      this.revision++;
      this.scheduleSave();
    }
    this.built = true;
  }

  private async statsFor(uri: string, text: string): Promise<{ mtime: number; size: number }> {
    try {
      const stat = await fs.stat(fileURLToPath(uri));
      return { mtime: stat.mtimeMs, size: stat.size };
    } catch {
      return { mtime: 0, size: Buffer.byteLength(text, 'utf8') };
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (!this.options.storageFile) {
      return;
    }
    try {
      const raw = await fs.readFile(this.options.storageFile, 'utf-8');
      const parsed = JSON.parse(raw) as IndexData;
      if (parsed?.version === INDEX_VERSION && parsed.files) {
        this.data = parsed;
      }
    } catch {
      // no index yet
    }
  }

  private scheduleSave(): void {
    if (!this.options.storageFile) {
      return;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private async save(): Promise<void> {
    if (!this.options.storageFile) {
      return;
    }
    try {
      await fs.mkdir(path.dirname(this.options.storageFile), { recursive: true });
      await fs.writeFile(this.options.storageFile, JSON.stringify(this.data));
    } catch {
      // storage is best effort
    }
  }
}

function combineTokens(
  external: DuplicationCancellationToken | undefined,
  progress: vscode.CancellationToken | undefined,
): DuplicationCancellationToken {
  return {
    get isCancellationRequested(): boolean {
      return external?.isCancellationRequested === true || progress?.isCancellationRequested === true;
    },
  };
}

function isIgnored(absolute: string, relative: string, scanIgnore: string[], gitignore: string[]): boolean {
  if (scanIgnore.some((pattern) => matchGlob(absolute, pattern))) {
    return true;
  }
  return matchesGitignore(relative, gitignore);
}

async function readGitignore(root: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(root, '.gitignore'), 'utf-8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

async function gitignorePatterns(dir: string, cache: Map<string, string[]>): Promise<string[]> {
  const cached = cache.get(dir);
  if (cached) {
    return cached;
  }
  let patterns: string[] = [];
  try {
    const raw = await fs.readFile(path.join(dir, '.gitignore'), 'utf-8');
    patterns = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    patterns = [];
  }
  cache.set(dir, patterns);
  return patterns;
}

async function matchesNestedGitignore(
  root: string,
  absolute: string,
  cache: Map<string, string[]>,
): Promise<boolean> {
  let dir = path.dirname(absolute);
  while (dir.length > root.length && dir.startsWith(root)) {
    const patterns = await gitignorePatterns(dir, cache);
    if (patterns.length > 0) {
      const relative = path.relative(dir, absolute).split(path.sep).join('/');
      if (matchesGitignore(relative, patterns)) {
        return true;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return false;
}

function matchesGitignore(relative: string, patterns: string[]): boolean {
  let ignored = false;
  for (const raw of patterns) {
    let pattern = raw;
    let negated = false;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    }
    if (pattern.startsWith('/')) {
      pattern = pattern.slice(1);
    }
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) {
      pattern = pattern.slice(0, -1);
    }
    if (!pattern) {
      continue;
    }
    const segments = relative.split('/');
    const matched = pattern.includes('/')
      ? matchGlob(relative, pattern) || matchGlob(relative, `**/${pattern}`)
      : segments.some(
          (segment, index) => matchGlob(segment, pattern) && (!directoryOnly || index < segments.length - 1),
        );
    if (matched) {
      ignored = !negated;
    }
  }
  return ignored;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
