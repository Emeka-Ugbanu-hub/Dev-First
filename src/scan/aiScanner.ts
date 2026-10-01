import { createHash } from 'crypto';
import type { Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import { repairJson } from '../agent/jsonRepair';
import { chatWithRetry } from '../llm/retry';
import type { ChatMessage, LLMProvider } from '../llm/types';
import { extractBalanced, parseJsonLoose, tryParseJson } from '../util/json';
import type { Chunk, ChunkOptions } from './chunker';
import { chunkFile, signaturesOf } from './chunker';
import { profileFor } from './languages/profiles';
import type { ScanFinding, ScanRule } from './ruleTypes';
import type { StrippedText } from './strip';
import { stripForAi } from './strip';

export type AiCategory = 'bug' | 'vulnerability' | 'smell' | 'hotspot' | 'architecture';
export type AiSeverity = 'error' | 'warning' | 'info';

export interface AiFinding {
  line: number;
  category: AiCategory;
  severity: AiSeverity;
  message: string;
  why: string;
  fix: string;
  concept?: string;
}

export interface AiPrompt {
  system: string;
  user: string;
}

export interface AiScanTarget {
  uri: string;
  languageId: string;
  text: string;
  lineCount: number;
}

export interface AiScannerConfig {
  scanAi: boolean;
  scanAiModel: string;
  model: string;
}

export interface AiScannerDeps {
  getConfig: () => AiScannerConfig;
  buildProvider: () => Promise<LLMProvider | undefined>;
}

export interface AiScanOptions {
  force?: boolean;
  visibleLine?: number;
  chunkOptions?: ChunkOptions;
  onProgress?: (done: number, total: number) => void;
  onPartial?: (findings: ScanFinding[]) => void;
}

export interface ChunkPromptContext {
  languageId: string;
  chunk: Chunk;
  signatures: string[];
  reported: ScanFinding[];
  stripped: StrippedText;
}

export interface FileMetrics {
  lineCount: number;
  blankLines: number;
  commentLines: number;
  maxDepth: number;
  branches: number;
}

export const AI_CATEGORIES: AiCategory[] = [
  'bug',
  'vulnerability',
  'smell',
  'hotspot',
  'architecture',
];
export const AI_SEVERITIES: AiSeverity[] = ['error', 'warning', 'info'];
export const AI_MAX_FINDINGS = 5;

const CATEGORY_SET = new Set<string>(AI_CATEGORIES);
const SEVERITY_SET = new Set<string>(AI_SEVERITIES);
const BRANCH_PATTERN = /\b(?:if|else\s+if|for|while|case|catch|switch)\b|&&|\|\|/g;
const COMMENT_LINE = /^\s*(?:\/\/|#|\/\*|\*)/;

export const CHUNK_SYSTEM_PROMPT = [
  'You are a senior code reviewer analyzing one chunk of a file.',
  'Report ONLY high-confidence findings a deterministic linter cannot catch. Never invent code that is not shown. Skip style nitpicks, formatting, and linter-class noise. Maximum 5 findings.',
  'Walk this checklist and report only what applies:',
  '- bug: null safety, logic errors, error handling, async races and unawaited work.',
  '- vulnerability: injection, secrets/crypto misuse, web/session issues, unsafe config.',
  '- smell: complexity, naming, dead weight, redundancy, exception handling.',
  '- architecture: responsibilities that should be split, layering violations, tangled dependencies, missing abstraction, duplicated logic across layers.',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"findings":[{"line":1,"category":"bug|vulnerability|smell|hotspot|architecture","severity":"error|warning|info","message":"","why":"","fix":"","concept":""}]}',
  'Rules: line is 1-based and relative to the first code line shown; message, why, and fix are non-empty and specific; concept is one short line naming the engineering concept behind a smell, architecture, or bug finding (e.g. "TOCTOU race", "single responsibility"), or empty when none; empty result is {"findings":[]}.',
].join('\n');

export const ARCHITECTURE_SYSTEM_PROMPT = [
  'You are a software architect reviewing one file.',
  'Make architecture judgments ONLY. Do not report bugs, style, performance, or security issues.',
  'Recommend splitting the file ONLY when responsibilities are clearly separable, and name each responsibility.',
  'When the right call is to leave the structure as-is, say so in "fix" (e.g. "leave as-is: splitting would add indirection without a clear win") instead of inventing a change.',
  'Never flag a file merely for being long: length alone is not a finding.',
  'Anchor every finding at line 1. The category must be "architecture".',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"findings":[{"line":1,"category":"architecture","severity":"info","message":"","why":"","fix":"","concept":""}]}',
  'Rules: message, why, and fix are non-empty and specific; concept is one short line naming the engineering concept behind the finding (e.g. "single responsibility", "dependency inversion"), or empty when none; empty result is {"findings":[]}.',
].join('\n');

export function buildChunkPrompt(context: ChunkPromptContext): AiPrompt {
  const signatures = context.signatures.length > 0 ? context.signatures.join('\n') : '(none)';
  const reported =
    context.reported.length > 0
      ? context.reported
          .map(
            (finding) =>
              `- line ${finding.line + 1} [${finding.rule.id}]: ${finding.rule.message}`,
          )
          .join('\n')
      : '(none)';
  return {
    system: CHUNK_SYSTEM_PROMPT,
    user: [
      `File: ${context.languageId}`,
      `Chunk covers file lines ${context.chunk.startLine + 1}-${context.chunk.endLine + 1}.`,
      'File signatures (context only; do not report on code that is not shown):',
      signatures,
      'Already reported by deterministic checks in this chunk (do not repeat these):',
      reported,
      'Code for review (line numbers are 1-based and relative to this chunk; line 1 is the first code line shown below; blank lines and comments were removed):',
      '```',
      context.stripped.text,
      '```',
    ].join('\n'),
  };
}

export function buildArchitecturePrompt(
  languageId: string,
  signatures: string[],
  metrics: FileMetrics,
): AiPrompt {
  return {
    system: ARCHITECTURE_SYSTEM_PROMPT,
    user: [
      `File: ${languageId}`,
      `Lines: ${metrics.lineCount} total, ${metrics.blankLines} blank, ${metrics.commentLines} comment`,
      `Max nesting depth: ${metrics.maxDepth}`,
      `Branch points: ${metrics.branches}`,
      'Signatures:',
      signatures.length > 0 ? signatures.join('\n') : '(none)',
    ].join('\n'),
  };
}

export function fileMetrics(text: string): FileMetrics {
  const lines = text.split('\n');
  let blankLines = 0;
  let commentLines = 0;
  let depth = 0;
  let maxDepth = 0;
  let branches = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankLines += 1;
    }
    if (COMMENT_LINE.test(line)) {
      commentLines += 1;
    }
    branches += line.match(BRANCH_PATTERN)?.length ?? 0;
    for (const char of line) {
      if (char === '{') {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
      } else if (char === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return { lineCount: lines.length, blankLines, commentLines, maxDepth, branches };
}

export function orderChunks(chunks: Chunk[], visibleLine: number | undefined): Chunk[] {
  if (visibleLine === undefined || chunks.length <= 1) {
    return chunks;
  }
  const index = chunks.findIndex(
    (chunk) => visibleLine >= chunk.startLine && visibleLine <= chunk.endLine,
  );
  if (index <= 0) {
    return chunks;
  }
  return [chunks[index], ...chunks.slice(0, index), ...chunks.slice(index + 1)];
}

export function parseAiFindings(raw: string, lineCount = Number.MAX_SAFE_INTEGER): AiFinding[] {
  return parseAiFindingsResult(raw, lineCount) ?? [];
}

function parseAiFindingsResult(raw: string, lineCount: number): AiFinding[] | undefined {
  const parsed = parseJsonLoose(raw) ?? repairAndParse(raw);
  if (parsed === undefined) {
    return undefined;
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : undefined;
  if (!entries) {
    return undefined;
  }
  const findings: AiFinding[] = [];
  for (const entry of entries.slice(0, AI_MAX_FINDINGS)) {
    const finding = parseAiFinding(entry, lineCount);
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
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

function parseAiFinding(entry: unknown, lineCount: number): AiFinding | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const category = typeof record.category === 'string' ? record.category : '';
  const severity = typeof record.severity === 'string' ? record.severity : '';
  if (!CATEGORY_SET.has(category) || !SEVERITY_SET.has(severity)) {
    return undefined;
  }
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  if (!message) {
    return undefined;
  }
  const rawLine =
    typeof record.line === 'number' && Number.isFinite(record.line) ? Math.trunc(record.line) : 1;
  const limit = Math.max(1, lineCount);
  const line = Math.max(0, Math.min(rawLine - 1, limit - 1));
  const concept = typeof record.concept === 'string' ? record.concept.trim() : '';
  return {
    line,
    category: category as AiCategory,
    severity: severity as AiSeverity,
    message,
    why: typeof record.why === 'string' ? record.why.trim() : '',
    fix: typeof record.fix === 'string' ? record.fix.trim() : '',
    ...(concept ? { concept } : {}),
  };
}

export function aiCacheKey(uri: string, text: string): string {
  return `${uri}\u0000${createHash('sha1').update(text).digest('hex')}`;
}

export function chunkCacheKey(languageId: string, text: string): string {
  return createHash('sha1').update(`${languageId}\u0000${text}`).digest('hex');
}

export function dedupeAiFindings(ai: ScanFinding[], deterministic: ScanFinding[]): ScanFinding[] {
  return ai.filter(
    (candidate) =>
      !deterministic.some(
        (known) =>
          known.rule.category === candidate.rule.category &&
          known.line === candidate.line &&
          known.startChar <= candidate.endChar &&
          candidate.startChar <= known.endChar,
      ),
  );
}

function dedupeWithin(findings: ScanFinding[]): ScanFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule.category}:${finding.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function aiRule(finding: AiFinding): ScanRule {
  return {
    kind: 'analyzer',
    run: () => [],
    id: `ai-${finding.category}`,
    category: finding.category,
    severity: finding.severity,
    message: finding.message,
    why: finding.why,
    fix: finding.fix,
    concept: finding.concept,
  };
}

export class AiScanner {
  private readonly chunkCache = new Map<string, AiFinding[]>();
  private readonly chunkHashes = new Map<string, Set<string>>();
  private readonly archCache = new Map<string, { key: string; findings: AiFinding[] }>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: AiScannerDeps) {}

  async scan(
    target: AiScanTarget,
    deterministic: ScanFinding[],
    tree?: Tree,
    options: AiScanOptions = {},
  ): Promise<ScanFinding[] | undefined> {
    const config = this.deps.getConfig();
    if (!config.scanAi && !options.force) {
      this.cancel(target.uri);
      return [];
    }
    const provider = await this.deps.buildProvider();
    if (!provider) {
      return [];
    }
    this.cancel(target.uri);
    const controller = new AbortController();
    this.controllers.set(target.uri, controller);
    const model = config.scanAiModel.trim() || config.model;
    const profile = profileFor(target.languageId);
    const signatures = signaturesOf(target.text, profile);
    const logicChunks = chunkFile(target.text, tree, profile, options.chunkOptions).filter(
      (chunk) => !chunk.structural,
    );
    const ordered = orderChunks(logicChunks, options.visibleLine);
    const collected: AiFinding[] = [];
    let done = 0;
    try {
      const first = ordered[0];
      if (first) {
        const findings = await this.scanChunk(
          target,
          first,
          provider,
          model,
          signatures,
          deterministic,
          controller,
        );
        if (!this.isCurrent(target.uri, controller)) {
          return undefined;
        }
        collected.push(...findings);
        done += 1;
        options.onProgress?.(done, ordered.length);
        this.emit(collected, target, deterministic, options);
      }
      const architecture = await this.runArchitecturePass(
        target,
        provider,
        model,
        signatures,
        controller,
      );
      if (!this.isCurrent(target.uri, controller)) {
        return undefined;
      }
      collected.push(...architecture);
      this.emit(collected, target, deterministic, options);
      for (const chunk of ordered.slice(1)) {
        const findings = await this.scanChunk(
          target,
          chunk,
          provider,
          model,
          signatures,
          deterministic,
          controller,
        );
        if (!this.isCurrent(target.uri, controller)) {
          return undefined;
        }
        collected.push(...findings);
        done += 1;
        options.onProgress?.(done, ordered.length);
        this.emit(collected, target, deterministic, options);
      }
      return this.materialize(collected, target, deterministic);
    } catch {
      return controller.signal.aborted ? undefined : [];
    } finally {
      if (this.controllers.get(target.uri) === controller) {
        this.controllers.delete(target.uri);
      }
    }
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

  clear(uri: string): void {
    this.cancel(uri);
    this.archCache.delete(uri);
    const hashes = this.chunkHashes.get(uri);
    if (hashes) {
      for (const hash of hashes) {
        this.chunkCache.delete(hash);
      }
      this.chunkHashes.delete(uri);
    }
  }

  dispose(): void {
    this.cancelAll();
    this.chunkCache.clear();
    this.chunkHashes.clear();
    this.archCache.clear();
  }

  private isCurrent(uri: string, controller: AbortController): boolean {
    return !controller.signal.aborted && this.controllers.get(uri) === controller;
  }

  private emit(
    findings: AiFinding[],
    target: AiScanTarget,
    deterministic: ScanFinding[],
    options: AiScanOptions,
  ): void {
    options.onPartial?.(this.materialize(findings, target, deterministic));
  }

  private async scanChunk(
    target: AiScanTarget,
    chunk: Chunk,
    provider: LLMProvider,
    model: string,
    signatures: string[],
    deterministic: ScanFinding[],
    controller: AbortController,
  ): Promise<AiFinding[]> {
    const hash = chunkCacheKey(target.languageId, chunk.text);
    const cached = this.chunkCache.get(hash);
    if (cached) {
      return cached.map((finding) => ({ ...finding, line: finding.line + chunk.startLine }));
    }
    const stripped = stripForAi(chunk.text, target.languageId);
    const reported = deterministic.filter(
      (finding) => finding.line >= chunk.startLine && finding.line <= chunk.endLine,
    );
    const prompt = buildChunkPrompt({
      languageId: target.languageId,
      chunk,
      signatures,
      reported,
      stripped,
    });
    const raw = await collectCompletion(provider, model, prompt, controller.signal);
    if (controller.signal.aborted) {
      return [];
    }
    const parsed = parseAiFindingsResult(raw, Math.max(1, stripped.lineMap.length)) ?? [];
    const mapped = parsed.map((finding) => ({
      ...finding,
      line: stripped.lineMap[Math.min(finding.line, stripped.lineMap.length - 1)] ?? 0,
    }));
    this.remember(target.uri, hash);
    this.chunkCache.set(hash, mapped);
    return mapped.map((finding) => ({ ...finding, line: finding.line + chunk.startLine }));
  }

  private async runArchitecturePass(
    target: AiScanTarget,
    provider: LLMProvider,
    model: string,
    signatures: string[],
    controller: AbortController,
  ): Promise<AiFinding[]> {
    const key = aiCacheKey(target.uri, `${target.languageId}\u0000${target.text}`);
    const cached = this.archCache.get(target.uri);
    if (cached && cached.key === key) {
      return cached.findings;
    }
    const prompt = buildArchitecturePrompt(target.languageId, signatures, fileMetrics(target.text));
    const raw = await collectCompletion(provider, model, prompt, controller.signal);
    if (controller.signal.aborted) {
      return [];
    }
    const parsed = parseAiFindingsResult(raw, target.lineCount) ?? [];
    const findings = parsed.map((finding) => ({
      ...finding,
      line: 0,
      category: 'architecture' as const,
    }));
    this.archCache.set(target.uri, { key, findings });
    return findings;
  }

  private remember(uri: string, hash: string): void {
    let hashes = this.chunkHashes.get(uri);
    if (!hashes) {
      hashes = new Set();
      this.chunkHashes.set(uri, hashes);
    }
    hashes.add(hash);
  }

  private materialize(
    ai: AiFinding[],
    target: AiScanTarget,
    deterministic: ScanFinding[],
  ): ScanFinding[] {
    const lines = target.text.split('\n');
    const limit = Math.max(0, Math.min(target.lineCount - 1, lines.length - 1));
    const findings = ai.map((finding) => {
      const line = Math.max(0, Math.min(finding.line, limit));
      return {
        rule: aiRule(finding),
        line,
        startChar: 0,
        endChar: (lines[line] ?? '').length,
      };
    });
    return dedupeAiFindings(dedupeWithin(findings), deterministic);
  }
}

export async function collectCompletion(
  provider: LLMProvider,
  model: string,
  prompt: AiPrompt,
  signal: AbortSignal,
  maxTokens = 1200,
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  let text = '';
  for await (const event of chatWithRetry(
    provider,
    messages,
    { model, temperature: 0.1, maxTokens, signal },
    { retryOnEmpty: true },
  )) {
    if (event.type === 'text') {
      text += event.text;
    }
  }
  return text;
}
