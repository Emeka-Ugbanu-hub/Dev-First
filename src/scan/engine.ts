import type { Query, Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import type { LanguageProfile } from './languages/profiles';
import { scanProfileFor } from './languages/profiles';
import type { RulePack, ScanFinding, ScanRule } from './ruleTypes';
import { isRegexRule } from './ruleTypes';
import { nodeRange } from './treeSitter';

export interface ScanOptions {
  includeHotspots: boolean;
}

const IGNORE_TOKEN = 'devfirst-ignore';
const IGNORE_ID = /[A-Za-z0-9_-]+/g;

interface ScanState {
  text: string;
  lines: string[];
  lineStarts: number[];
  findings: ScanFinding[];
  seen: Set<string>;
  knownIds: Set<string>;
}

export function scanText(
  text: string,
  languageId: string,
  packs: RulePack[],
  options: ScanOptions,
): ScanFinding[] {
  const state = createState(text, packs);
  runRegexRules(state, languageId, packs, options);
  return state.findings;
}

export async function scanTextWithAst(
  text: string,
  languageId: string,
  packs: RulePack[],
  options: ScanOptions,
  tree?: Tree,
): Promise<ScanFinding[]> {
  const state = createState(text, packs);
  runRegexRules(state, languageId, packs, options);
  runAstRules(state, languageId, packs, options, tree, scanProfileFor(languageId));
  return state.findings;
}

function createState(text: string, packs: RulePack[]): ScanState {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lineStarts.push(i + 1);
    }
  }
  const knownIds = new Set<string>();
  for (const pack of packs) {
    for (const rule of pack.rules) {
      knownIds.add(rule.id);
    }
  }
  return { text, lines: text.split('\n'), lineStarts, findings: [], seen: new Set(), knownIds };
}

function runRegexRules(
  state: ScanState,
  languageId: string,
  packs: RulePack[],
  options: ScanOptions,
): void {
  for (const pack of packs) {
    if (!packMatches(pack.languages, languageId)) {
      continue;
    }
    for (const rule of pack.rules) {
      if (!isRegexRule(rule)) {
        continue;
      }
      if (!ruleMatches(rule, languageId, options)) {
        continue;
      }
      if (rule.fileLevel) {
        if (!new RegExp(rule.pattern.source, flagsFor(rule.pattern)).test(state.text)) {
          if (!isSuppressed(state.lines, 0, rule.id, state.knownIds)) {
            push(state, rule, 0, 0, 0);
          }
        }
        continue;
      }
      const regex = new RegExp(rule.pattern.source, flagsFor(rule.pattern));
      let match: RegExpExecArray | null;
      while ((match = regex.exec(state.text)) !== null) {
        if (match[0].length === 0) {
          regex.lastIndex++;
          continue;
        }
        const index = match.index;
        const line = lineAt(state.lineStarts, index);
        const lineStart = state.lineStarts[line];
        const startChar = index - lineStart;
        if (isSuppressed(state.lines, line, rule.id, state.knownIds)) {
          continue;
        }
        push(state, rule, line, startChar, startChar + match[0].length);
      }
    }
  }
}

function runAstRules(
  state: ScanState,
  languageId: string,
  packs: RulePack[],
  options: ScanOptions,
  tree: Tree | undefined,
  profile: LanguageProfile,
): void {
  for (const pack of packs) {
    if (!packMatches(pack.languages, languageId)) {
      continue;
    }
    for (const rule of pack.rules) {
      if (isRegexRule(rule) || !ruleMatches(rule, languageId, options)) {
        continue;
      }
      if (!tree && rule.kind === 'ast') {
        continue;
      }
      try {
        const ranges =
          rule.kind === 'ast'
            ? runQueryRule(state, languageId, rule.id, rule.query(profile), rule.capture, tree as Tree)
            : rule.run(tree as Tree, profile, state.text);
        for (const range of ranges) {
          if (isSuppressed(state.lines, range.line, rule.id, state.knownIds)) {
            continue;
          }
          push(state, rule, range.line, range.startChar, range.endChar);
        }
      } catch {
        continue;
      }
    }
  }
}

const queryCache = new Map<string, Query>();

function createQuery(tree: Tree, source: string): Query {
  try {
    const runtime = require('@vscode/tree-sitter-wasm') as {
      Query: new (language: Tree['language'], source: string) => Query;
    };
    return new runtime.Query(tree.language, source);
  } catch {
    return tree.language.query(source);
  }
}

function runQueryRule(
  state: ScanState,
  languageId: string,
  ruleId: string,
  source: string,
  capture: string | undefined,
  tree: Tree,
): { line: number; startChar: number; endChar: number }[] {
  const key = `${ruleId}:${languageId}`;
  let query = queryCache.get(key);
  if (!query) {
    query = createQuery(tree, source);
    queryCache.set(key, query);
  }
  const ranges: { line: number; startChar: number; endChar: number }[] = [];
  for (const match of query.matches(tree.rootNode)) {
    const found =
      match.captures.find((entry) => entry.name === (capture ?? 'match')) ?? match.captures[0];
    if (found) {
      ranges.push(nodeRange(found.node));
    }
  }
  return ranges;
}

function packMatches(languages: string[] | undefined, languageId: string): boolean {
  return !languages || languages.includes(languageId);
}

function ruleMatches(rule: ScanRule, languageId: string, options: ScanOptions): boolean {
  if (rule.languages && !rule.languages.includes(languageId)) {
    return false;
  }
  if (!options.includeHotspots && rule.category === 'hotspot') {
    return false;
  }
  return true;
}

function push(state: ScanState, rule: ScanRule, line: number, startChar: number, endChar: number): void {
  if (line < 0 || line >= state.lines.length) {
    return;
  }
  const key = `${rule.id}:${line}:${startChar}`;
  if (state.seen.has(key)) {
    return;
  }
  const lineStart = state.lineStarts[line];
  const lineEnd = line + 1 < state.lineStarts.length ? state.lineStarts[line + 1] - 1 : state.text.length;
  state.seen.add(key);
  state.findings.push({
    rule,
    line,
    startChar,
    endChar: Math.max(startChar, Math.min(endChar, lineEnd - lineStart)),
  });
}

function flagsFor(pattern: RegExp): string {
  return pattern.flags.includes('u') ? 'gmu' : 'gm';
}

function lineAt(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (lineStarts[mid] <= index) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

export function isSuppressed(
  lines: string[],
  line: number,
  ruleId: string,
  knownIds: Set<string>,
): boolean {
  if (lineSuppresses(lines[line], ruleId, knownIds)) {
    return true;
  }
  return line > 0 && lineSuppresses(lines[line - 1], ruleId, knownIds);
}

function lineSuppresses(
  line: string | undefined,
  ruleId: string,
  knownIds: Set<string>,
): boolean {
  if (!line || !line.includes(IGNORE_TOKEN)) {
    return false;
  }
  const rest = line.slice(line.indexOf(IGNORE_TOKEN) + IGNORE_TOKEN.length);
  const named = (rest.match(IGNORE_ID) ?? []).filter((id) => knownIds.has(id));
  if (named.length === 0) {
    return true;
  }
  return named.includes(ruleId);
}
