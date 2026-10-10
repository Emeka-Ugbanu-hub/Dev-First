import { createHash } from 'crypto';
import { repairJson } from '../agent/jsonRepair';
import type { LLMProvider } from '../llm/types';
import { extractBalanced, parseJsonLoose, tryParseJson } from '../util/json';
import type { AiPrompt } from './aiScanner';
import { collectCompletion } from './aiScanner';
import type { CrossFileFinding } from './crossFile';
import { conceptKey } from './crossFile';
import type { DuplicationEntry, FileFacts } from './duplication';

export type PairVerdictName = 'same' | 'drifted' | 'unrelated';

export interface PairVerdict {
  verdict: PairVerdictName;
  reason: string;
  recommendation: string;
}

export interface PairSide {
  file: string;
  line: number;
  name: string;
  body: string;
}

export interface PairCandidate {
  key: string;
  left: PairSide;
  right: PairSide;
  involvesHandler: boolean;
  involvesEvent: boolean;
}

export interface PairJudgmentCache {
  get(key: string): PairVerdict | undefined | Promise<PairVerdict | undefined>;
  set(key: string, verdict: PairVerdict): void | Promise<void>;
}

export interface CrossFileAiConfig {
  scanAi: boolean;
  scanAiCrossFile: boolean;
  scanAiCrossFileMaxPairs: number;
  scanAiModel: string;
  model: string;
}

export interface CrossFileAiDeps {
  getConfig: () => CrossFileAiConfig;
  buildProvider: () => Promise<LLMProvider | undefined>;
  cache: PairJudgmentCache;
}

export interface CrossFileAiResult {
  findings: CrossFileFinding[];
  notice?: CrossFileFinding;
}

export const PAIR_VERDICTS = new Set<string>(['same', 'drifted', 'unrelated']);
export const PAIR_MAX_TOKENS = 500;

export const PAIR_SYSTEM_PROMPT = [
  'You compare two implementations of the same concept from one codebase.',
  'Judge whether they are the same behavior, drifted from each other, or unrelated despite the name.',
  'same = behavior is equivalent; drifted = same intent but behavior or contract diverges; unrelated = different intent.',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"verdict":"same|drifted|unrelated","reason":"","recommendation":""}',
  'Rules: reason is one sentence; recommendation is one concrete action and empty only for unrelated.',
].join('\n');

const HANDLER_NAME = /^(handle|on[A-Z_])|(handler|route|controller|endpoint|middleware)$/i;
const EVENT_NAME = /^(emit|publish|dispatch|listen|subscribe|on[A-Z])/;

function shortPath(file: string): string {
  const clean = file.replace(/^file:\/\//, '');
  const parts = clean.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

function pairInvolvesHandler(
  left: DuplicationEntry,
  right: DuplicationEntry,
  factsByFile: Map<string, FileFacts>,
): boolean {
  for (const entry of [left, right]) {
    if (HANDLER_NAME.test(entry.name)) {
      return true;
    }
    const facts = factsByFile.get(entry.file);
    if (
      facts?.handlers?.some(
        (handler) => handler.name === entry.name && handler.line === entry.startLine,
      )
    ) {
      return true;
    }
  }
  return false;
}

function pairInvolvesEvent(
  left: DuplicationEntry,
  right: DuplicationEntry,
  factsByFile: Map<string, FileFacts>,
): boolean {
  for (const entry of [left, right]) {
    if (EVENT_NAME.test(entry.name)) {
      return true;
    }
    const facts = factsByFile.get(entry.file);
    if (facts?.listeners?.some((listener) => listener.kind === 'add' && listener.literal)) {
      return true;
    }
  }
  return false;
}

export function buildPairCandidates(input: {
  openedFile: string;
  entries: DuplicationEntry[];
  facts: FileFacts[];
}): PairCandidate[] {
  const factsByFile = new Map(input.facts.map((file) => [file.file, file]));
  const opened = input.entries.filter((entry) => entry.file === input.openedFile);
  const others = input.entries.filter((entry) => entry.file !== input.openedFile);
  const byName = new Map<string, DuplicationEntry[]>();
  for (const entry of others) {
    if (!entry.name) {
      continue;
    }
    const list = byName.get(entry.name);
    if (list) {
      list.push(entry);
    } else {
      byName.set(entry.name, [entry]);
    }
  }
  const pairs = new Map<string, PairCandidate>();
  const add = (left: DuplicationEntry, right: DuplicationEntry): void => {
    const key = `${left.file}:${left.startLine}|${right.file}:${right.startLine}`;
    if (pairs.has(key)) {
      return;
    }
    pairs.set(key, {
      key,
      left: { file: left.file, line: left.startLine, name: left.name, body: left.body },
      right: { file: right.file, line: right.startLine, name: right.name, body: right.body },
      involvesHandler: pairInvolvesHandler(left, right, factsByFile),
      involvesEvent: pairInvolvesEvent(left, right, factsByFile),
    });
  };
  for (const entry of opened) {
    if (!entry.exported || !entry.name) {
      continue;
    }
    for (const twin of byName.get(entry.name) ?? []) {
      if (twin.fingerprint === entry.fingerprint) {
        continue;
      }
      add(entry, twin);
    }
    const concept = conceptKey(entry.name);
    if (!concept) {
      continue;
    }
    for (const twin of others) {
      if (!twin.exported || !twin.name || twin.name === entry.name) {
        continue;
      }
      if (twin.fingerprint === entry.fingerprint || conceptKey(twin.name) !== concept) {
        continue;
      }
      add(entry, twin);
    }
  }
  return [...pairs.values()].sort(
    (a, b) =>
      a.left.name.localeCompare(b.left.name) ||
      a.right.file.localeCompare(b.right.file) ||
      a.right.line - b.right.line,
  );
}

export function buildPairPrompt(candidate: PairCandidate): AiPrompt {
  const lines = [
    `Concept: ${candidate.left.name} vs ${candidate.right.name}`,
    `A: ${candidate.left.name} (${shortPath(candidate.left.file)}:${candidate.left.line + 1})`,
    `B: ${candidate.right.name} (${shortPath(candidate.right.file)}:${candidate.right.line + 1})`,
  ];
  if (candidate.involvesHandler) {
    lines.push(
      'Boundary check: a route handler is involved — also judge API contract drift between the frontend call shape and the backend handler shape.',
    );
  }
  if (candidate.involvesEvent) {
    lines.push(
      'Boundary check: an event producer or consumer is involved — also judge whether the emit payload and the listen handler payload match.',
    );
  }
  lines.push(
    'Implementation A (comments stripped):',
    '```',
    candidate.left.body,
    '```',
    'Implementation B (comments stripped):',
    '```',
    candidate.right.body,
    '```',
    'Compare only the two implementations shown.',
  );
  return { system: PAIR_SYSTEM_PROMPT, user: lines.join('\n') };
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

export function parsePairVerdict(raw: string): PairVerdict | undefined {
  const parsed = parseJsonLoose(raw) ?? repairAndParse(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const verdict = typeof record.verdict === 'string' ? record.verdict.trim().toLowerCase() : '';
  if (!PAIR_VERDICTS.has(verdict)) {
    return undefined;
  }
  return {
    verdict: verdict as PairVerdictName,
    reason: typeof record.reason === 'string' ? record.reason.trim() : '',
    recommendation: typeof record.recommendation === 'string' ? record.recommendation.trim() : '',
  };
}

export function pairCacheKey(leftBody: string, rightBody: string): string {
  const [first, second] = [leftBody, rightBody].sort();
  return createHash('sha1').update(`${first}\u0000${second}`).digest('hex');
}

export function pairFinding(candidate: PairCandidate, verdict: PairVerdict): CrossFileFinding {
  const advice = verdict.recommendation || verdict.reason || 'review both implementations';
  return {
    ruleId: 'xf-ai-pair',
    category: 'smell',
    severity: 'info',
    message: `AI pair review: "${candidate.left.name}" and "${candidate.right.name}" are ${verdict.verdict} — ${advice}`,
    file: candidate.left.file,
    line: candidate.left.line,
    related: [
      {
        file: candidate.right.file,
        line: candidate.right.line,
        message: `AI twin "${candidate.right.name}"`,
      },
    ],
    confidence: 'high',
    evidence: [
      { path: candidate.left.file, line: candidate.left.line + 1 },
      { path: candidate.right.file, line: candidate.right.line + 1 },
    ],
  };
}

function capNotice(file: string, skipped: number): CrossFileFinding {
  return {
    ruleId: 'xf-pair-cap',
    category: 'smell',
    severity: 'info',
    message: `${skipped} more related-file candidates were not reviewed in this pass.`,
    file,
    line: 0,
    related: [],
  };
}

export class CrossFileAi {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: CrossFileAiDeps) {}

  async judge(
    uri: string,
    candidates: PairCandidate[],
    options: { force?: boolean; maxPairs?: number } = {},
  ): Promise<CrossFileAiResult> {
    const config = this.deps.getConfig();
    if (!config.scanAiCrossFile) {
      return { findings: [] };
    }
    if (!config.scanAi && !options.force) {
      return { findings: [] };
    }
    if (candidates.length === 0) {
      return { findings: [] };
    }
    const maxPairs = Math.max(0, Math.floor(options.maxPairs ?? config.scanAiCrossFileMaxPairs));
    const selected = candidates.slice(0, maxPairs);
    const notice = candidates.length > maxPairs ? capNotice(uri, candidates.length - maxPairs) : undefined;
    if (selected.length === 0) {
      return { findings: [], notice };
    }
    const provider = await this.deps.buildProvider();
    if (!provider) {
      return { findings: [] };
    }
    this.cancel(uri);
    const controller = new AbortController();
    this.controllers.set(uri, controller);
    const model = config.scanAiModel.trim() || config.model;
    const findings: CrossFileFinding[] = [];
    try {
      for (const candidate of selected) {
        if (controller.signal.aborted) {
          break;
        }
        const cacheKey = pairCacheKey(candidate.left.body, candidate.right.body);
        let verdict = await this.deps.cache.get(cacheKey);
        if (verdict && !PAIR_VERDICTS.has(verdict.verdict)) {
          verdict = undefined;
        }
        if (!verdict) {
          try {
            const raw = await collectCompletion(
              provider,
              model,
              buildPairPrompt(candidate),
              controller.signal,
              PAIR_MAX_TOKENS,
            );
            if (controller.signal.aborted) {
              break;
            }
            verdict = parsePairVerdict(raw);
            if (verdict) {
              await this.deps.cache.set(cacheKey, verdict);
            }
          } catch {
            verdict = undefined;
          }
        }
        if (verdict && verdict.verdict !== 'unrelated') {
          findings.push(pairFinding(candidate, verdict));
        }
      }
    } finally {
      if (this.controllers.get(uri) === controller) {
        this.controllers.delete(uri);
      }
    }
    return { findings, notice };
  }

  cancel(uri: string): void {
    const controller = this.controllers.get(uri);
    if (controller) {
      controller.abort();
      this.controllers.delete(uri);
    }
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }

  dispose(): void {
    this.cancelAll();
  }
}
