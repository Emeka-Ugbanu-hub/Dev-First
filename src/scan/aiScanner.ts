import { createHash } from 'crypto';
import type { Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import { repairJson } from '../agent/jsonRepair';
import { chatWithRetry } from '../llm/retry';
import type { ChatMessage, ChatOptions, LLMProvider } from '../llm/types';
import type { ToolCall, ToolDef } from '../llm/types';
import { normalizeToolArguments } from '../util/toolArgs';
import { extractBalanced, parseJsonLoose, tryParseJson } from '../util/json';
import type { Chunk, ChunkOptions } from './chunker';
import { chunkFile, signaturesOf } from './chunker';
import { profileFor } from './languages/profiles';
import type { ScanFinding, ScanRule } from './ruleTypes';
import type { StrippedText } from './strip';
import { stripForAi } from './strip';

export type AiCategory =
  | 'bug'
  | 'vulnerability'
  | 'smell'
  | 'secret'
  | 'architecture'
  | 'maintainability'
  | 'scalability';
export type AiSeverity = 'error' | 'warning' | 'info';
export type AiConfidence = 'high' | 'medium' | 'low';

export interface AiEvidence {
  path: string;
  line: number;
}

export interface AiFinding {
  line: number;
  category: AiCategory;
  severity: AiSeverity;
  message: string;
  why: string;
  fix: string;
  confidence?: AiConfidence;
  evidence?: AiEvidence[];
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
  reasoning?: ChatOptions['reasoning'];
}

export interface AiScannerDeps {
  getConfig: () => AiScannerConfig;
  buildProvider: () => Promise<LLMProvider | undefined>;
  getTools?: () => Promise<ToolDef[]>;
  executeTool?: (call: ToolCall) => Promise<string>;
}

export interface AiScanOptions {
  force?: boolean;
  visibleLine?: number;
  chunkOptions?: ChunkOptions;
  onProgress?: (done: number, total: number) => void;
  onPartial?: (findings: ScanFinding[]) => void;
  onCoverage?: (reviewed: number, total: number, mode: 'targeted' | 'full') => void;
  onStage?: (stage: string) => void;
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
  'secret',
  'architecture',
  'maintainability',
  'scalability',
];
export const AI_SEVERITIES: AiSeverity[] = ['error', 'warning', 'info'];
export const AI_MAX_FINDINGS = 5;
const TARGETED_CHUNK_LIMIT = 8;

const CATEGORY_SET = new Set<string>(AI_CATEGORIES);
const SEVERITY_SET = new Set<string>(AI_SEVERITIES);
const BRANCH_PATTERN = /\b(?:if|else\s+if|for|while|case|catch|switch)\b|&&|\|\|/g;
const COMMENT_LINE = /^\s*(?:\/\/|#|\/\*|\*)/;

export const CHUNK_SYSTEM_PROMPT = [
  'You are a senior code reviewer analyzing one chunk of a file.',
  'Report only evidence-backed findings. Never invent code that is not shown. Skip formatting and trivial style preferences. Maximum 5 findings.',
  'Deterministic signals are candidate evidence, not the final answer and not a whitelist. Independently review the shown code for every category, keep a candidate only when it is valid, and add new findings when the code supports them even if no signal was supplied.',
  'Walk this checklist and report only what applies:',
  '- bug: null safety, logic errors, error handling, async races and unawaited work.',
  '- vulnerability: injection, secrets/crypto misuse, web/session issues, unsafe config.',
  '- secret: committed credentials, tokens, private keys, or sensitive values.',
  '- smell: naming, duplication, unnecessary complexity, and style problems that affect the code.',
  '- architecture: incorrect layering, misplaced responsibilities, or tangled dependencies.',
  '- maintainability: code that is difficult to change, test, or understand.',
  '- scalability: behavior that degrades as data, traffic, files, or users grow.',
  'When duplication, an unused export, dead code, or a cross-file contract is suspected, use the provided read-only search, symbol, reference, or file tools before reporting it. Do not infer that code is dead from its name or from one file alone.',
  'For a duplicate candidate, inspect the related implementation and compare behavior, inputs, outputs, errors, and side effects. Report a finding only when the evidence supports same behavior or meaningful drift.',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"findings":[{"line":1,"category":"bug|vulnerability|smell|secret|architecture|maintainability|scalability","severity":"error|warning|info","confidence":"high|medium|low","message":"","why":"","fix":"","evidence":[{"path":"file","line":1}],"concept":""}]}',
  'Rules: line is 1-based and relative to the first code line shown; message, why, fix, confidence, and evidence are required; evidence lines must be in reviewed code or a related file actually inspected; use low confidence only when more context is needed; low confidence is informational and triggers expansion; concept is optional; empty result is {"findings":[]}.',
].join('\n');

// Kept as a reusable prompt primitive for architecture consumers; file review
// itself now uses the same bounded, evidence-backed chunk review as every category.
export const ARCHITECTURE_SYSTEM_PROMPT = [
  'You are a software architect reviewing one file.',
  'Make architecture judgments ONLY. Do not report bugs, style, performance, or security issues.',
  'Recommend splitting the file ONLY when responsibilities are clearly separable, and name each responsibility.',
  'Never flag a file merely for being long: length alone is not a finding.',
  'Anchor every finding at line 1. The category must be "architecture".',
  'Respond with strict JSON only. No markdown, no prose, no code fences.',
  '{"findings":[{"line":1,"category":"architecture","severity":"info","confidence":"high|medium|low","message":"","why":"","fix":"","evidence":[{"path":"file","line":1}],"concept":""}]}',
].join('\n');

export function buildChunkPrompt(context: ChunkPromptContext): AiPrompt {
  const signatures = context.signatures.length > 0 ? context.signatures.join('\n') : '(none)';
  const reported =
    context.reported.length > 0
      ? context.reported
          .slice(0, 24)
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
      'Local index signals in this chunk (verify them before reporting; do not repeat confirmed findings):',
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
  return parseAiFindingsResult(raw, lineCount, false) ?? [];
}

function parseAiFindingsResult(raw: string, lineCount: number, requireEvidence: boolean): AiFinding[] | undefined {
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
    const finding = parseAiFinding(entry, lineCount, requireEvidence);
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

function parseAiFinding(entry: unknown, lineCount: number, requireEvidence: boolean): AiFinding | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const category = typeof record.category === 'string' ? record.category : '';
  const requestedSeverity = typeof record.severity === 'string' ? record.severity : '';
  const confidence = record.confidence === 'high' || record.confidence === 'medium' || record.confidence === 'low'
    ? record.confidence
    : undefined;
  if (!CATEGORY_SET.has(category) || !SEVERITY_SET.has(requestedSeverity) || (requireEvidence && !confidence)) {
    return undefined;
  }
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const why = typeof record.why === 'string' ? record.why.trim() : '';
  const fix = typeof record.fix === 'string' ? record.fix.trim() : '';
  if (!message || !why || !fix) {
    return undefined;
  }
  const evidence = Array.isArray(record.evidence)
    ? record.evidence
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((item) => ({
          path: typeof item.path === 'string' ? item.path.trim() : '',
          line: typeof item.line === 'number' && Number.isFinite(item.line) ? Math.trunc(item.line) : 0,
        }))
        .filter((item) => item.path && item.line > 0)
        .slice(0, 4)
    : [];
  if (requireEvidence && evidence.length === 0) {
    return undefined;
  }
  const rawLine =
    typeof record.line === 'number' && Number.isFinite(record.line) ? Math.trunc(record.line) : 1;
  const limit = Math.max(1, lineCount);
  const line = Math.max(0, Math.min(rawLine - 1, limit - 1));
  const concept = typeof record.concept === 'string' ? record.concept.trim() : '';
  const severity: AiSeverity = confidence === 'low'
    ? 'info'
    : confidence === 'medium' && requestedSeverity === 'error'
      ? 'warning'
      : requestedSeverity as AiSeverity;
  return {
    line,
    category: category as AiCategory,
    severity,
    message,
    why,
    fix,
    ...(confidence ? { confidence } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
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
    confidence: finding.confidence,
    evidence: finding.evidence,
  };
}

export class AiScanner {
  private readonly chunkCache = new Map<string, AiFinding[]>();
  private readonly chunkHashes = new Map<string, Set<string>>();
  private readonly selectionCache = new Map<string, { key: string; indexes: number[]; full: boolean }>();
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
    const tools = this.deps.getTools ? await this.deps.getTools() : [];
    options.onStage?.('Building file structure');
    const profile = profileFor(target.languageId);
    const signatures = signaturesOf(target.text, profile);
    const logicChunks = chunkFile(target.text, tree, profile, options.chunkOptions).filter(
      (chunk) => !chunk.structural,
    );
    const ordered = orderChunks(logicChunks, options.visibleLine);
    options.onStage?.('Selecting review regions');
    const selected = ordered.length > TARGETED_CHUNK_LIMIT
      ? await this.selectChunks(target, ordered, provider, model, signatures, controller, tools, config.reasoning)
      : ordered;
    const collected: AiFinding[] = [];
    let done = 0;
    try {
      for (const chunk of selected) {
        options.onStage?.(`Reviewing region ${done + 1}/${selected.length}`);
        const findings = await this.scanChunk(
          target,
          chunk,
          provider,
          model,
          signatures,
          deterministic,
          controller,
          tools,
          config.reasoning,
        );
        if (!this.isCurrent(target.uri, controller)) {
          return undefined;
        }
        collected.push(...findings);
        done += 1;
        options.onProgress?.(done, selected.length);
        options.onCoverage?.(done, ordered.length, selected.length >= ordered.length ? 'full' : 'targeted');
        this.emit(collected, target, deterministic, options);
      }
      if (selected.length < ordered.length && collected.some((finding) => finding.confidence === 'low')) {
        const reviewed = new Set(selected);
        const expansion = ordered.filter((chunk) => !reviewed.has(chunk)).slice(0, TARGETED_CHUNK_LIMIT);
        for (const chunk of expansion) {
          const findings = await this.scanChunk(
            target,
            chunk,
            provider,
            model,
            signatures,
            deterministic,
            controller,
            tools,
          );
          if (!this.isCurrent(target.uri, controller)) {
            return undefined;
          }
          collected.push(...findings);
          done += 1;
          options.onProgress?.(done, selected.length + expansion.length);
          options.onCoverage?.(done, ordered.length, done >= ordered.length ? 'full' : 'targeted');
          this.emit(collected, target, deterministic, options);
        }
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
    this.selectionCache.delete(uri);
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
    this.selectionCache.clear();
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
    tools: ToolDef[],
    reasoning?: ChatOptions['reasoning'],
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
    const raw = await collectCompletion(provider, model, prompt, controller.signal, 1200, tools, this.deps.executeTool, reasoning);
    if (controller.signal.aborted) {
      return [];
    }
    const parsed = parseAiFindingsResult(raw, Math.max(1, stripped.lineMap.length), true) ?? [];
    const mapped = parsed.map((finding) => ({
      ...finding,
      line: stripped.lineMap[Math.min(finding.line, stripped.lineMap.length - 1)] ?? 0,
    }));
    this.remember(target.uri, hash);
    this.chunkCache.set(hash, mapped);
    return mapped.map((finding) => ({ ...finding, line: finding.line + chunk.startLine }));
  }

  private async selectChunks(
    target: AiScanTarget,
    chunks: Chunk[],
    provider: LLMProvider,
    model: string,
    signatures: string[],
    controller: AbortController,
    tools: ToolDef[],
    reasoning?: ChatOptions['reasoning'],
  ): Promise<Chunk[]> {
    if (chunks.length <= 1) {
      return chunks;
    }
    const selectionKey = aiCacheKey(target.uri, `${target.languageId}\u0000${target.text}`);
    const cached = this.selectionCache.get(target.uri);
    if (cached?.key === selectionKey) {
      return cached.full ? chunks : cached.indexes.map((index) => chunks[index]).filter(Boolean);
    }
    const summary = [
      `File: ${target.uri}`,
      `Language: ${target.languageId}`,
      `Lines: ${target.lineCount}`,
      `Metrics: ${JSON.stringify(fileMetrics(target.text))}`,
      'Signatures:',
      signatures.slice(0, 120).join('\n') || '(none)',
      'Regions:',
      chunks.map((chunk, index) => `${index}: lines ${chunk.startLine + 1}-${chunk.endLine + 1}`).join('\n'),
    ].join('\n');
    const prompt: AiPrompt = {
      system: 'Select code regions for an accurate review. Return JSON only: {"regions":[{"index":0,"reason":"..."}],"full":false}. Select regions with risky control flow, boundaries, state, I/O, security, duplication, architecture, maintainability, or scalability concerns. Select all regions only when needed for confidence. Never invent indexes.',
      user: summary,
    };
    try {
      const raw = await collectCompletion(provider, model, prompt, controller.signal, 700, tools, this.deps.executeTool, reasoning);
      const parsed = parseJsonLoose(raw) as { regions?: unknown; full?: unknown } | undefined;
      const indexes = Array.isArray(parsed?.regions)
        ? parsed.regions
            .map((region) => (region && typeof region === 'object' && typeof (region as { index?: unknown }).index === 'number' ? Math.trunc((region as { index: number }).index) : -1))
            .filter((index) => index >= 0 && index < chunks.length)
        : [];
      if (parsed?.full === true) {
        this.selectionCache.set(target.uri, { key: selectionKey, indexes: [], full: true });
        return chunks;
      }
      const unique = [...new Set(indexes)].slice(0, TARGETED_CHUNK_LIMIT);
      if (unique.length > 0) {
        this.selectionCache.set(target.uri, { key: selectionKey, indexes: unique, full: false });
        return unique.map((index) => chunks[index]);
      }
    } catch {
      // Fall back to a bounded targeted review when selection fails.
    }
    const fallback = chunks.slice(0, Math.min(TARGETED_CHUNK_LIMIT, chunks.length <= 4 ? chunks.length : 1));
    this.selectionCache.set(target.uri, {
      key: selectionKey,
      indexes: fallback.map((chunk) => chunks.indexOf(chunk)),
      full: false,
    });
    return fallback;
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
    // Deterministic results are candidates for the model to validate. They
    // must not suppress an AI finding: the model may confirm the candidate,
    // reject it, or report a better finding on the same line.
    void deterministic;
    return dedupeWithin(findings);
  }
}

export async function collectCompletion(
  provider: LLMProvider,
  model: string,
  prompt: AiPrompt,
  signal: AbortSignal,
  maxTokens = 1200,
  tools: ToolDef[] = [],
  executeTool?: (call: ToolCall) => Promise<string>,
  reasoning?: ChatOptions['reasoning'],
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
  for (let round = 0; round < 4; round++) {
    let text = '';
    const toolCalls: ToolCall[] = [];
    for await (const event of chatWithRetry(
      provider,
      messages,
      { model, temperature: 0.1, maxTokens, signal, tools: tools.length > 0 ? tools : undefined, reasoning },
      { retryOnEmpty: true },
    )) {
      if (event.type === 'text') {
        text += event.text;
      } else if (event.type === 'toolCall') {
        toolCalls.push(event.toolCall);
      }
    }
    if (toolCalls.length === 0 || !executeTool || tools.length === 0) {
      return text;
    }
    messages.push({ role: 'assistant', content: text, toolCalls });
    for (const call of toolCalls.slice(0, 4)) {
      const definition = tools.find((tool) => tool.name === call.name);
      if (!definition) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: 'Error: this tool is not available during file scanning.',
        });
        continue;
      }
      const normalized = { ...call, arguments: normalizeToolArguments(call.arguments, definition.parameters) };
      let result: string;
      try {
        result = await executeTool(normalized);
      } catch (error) {
        result = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({
        role: 'tool',
        toolCallId: normalized.id,
        toolName: normalized.name,
        content: result,
      });
    }
  }
  return '';
}
