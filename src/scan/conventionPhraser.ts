import { createHash } from 'crypto';
import { repairJson } from '../agent/jsonRepair';
import type { LLMProvider } from '../llm/types';
import { extractBalanced, parseJsonLoose, tryParseJson } from '../util/json';
import type { AiPrompt } from './aiScanner';
import { collectCompletion } from './aiScanner';
import type { Convention } from './conventions';

export const CONVENTION_PHRASER_MAX_TOKENS = 800;

export const CONVENTION_PHRASER_SYSTEM = [
  'You rewrite raw codebase convention statistics as one plain factual sentence each.',
  'Keep every number and fact from the raw stat. No advice, no praise, no markdown, no preamble.',
  'Respond with strict JSON only. No code fences.',
  '{"sentences":["..."]}',
  'Rules: exactly one sentence per raw stat, in the same order; every sentence non-empty.',
].join('\n');

export function conventionsStatsHash(conventions: Convention[]): string {
  const stats = conventions.map((convention) => [
    convention.id,
    convention.statement,
    convention.confidence,
    convention.evidence,
  ]);
  return createHash('sha1').update(JSON.stringify(stats)).digest('hex');
}

export function buildConventionPhraserPrompt(conventions: Convention[]): AiPrompt {
  const stats = conventions
    .map(
      (convention, index) =>
        `${index + 1}. ${convention.statement} (confidence ${Math.round(
          convention.confidence * 100,
        )}%; evidence: ${convention.evidence.slice(0, 3).join('; ') || 'none'})`,
    )
    .join('\n');
  return {
    system: CONVENTION_PHRASER_SYSTEM,
    user: `Raw convention stats:\n${stats}`,
  };
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

export function parsePhrasedSentences(raw: string, count: number): string[] | undefined {
  const parsed = parseJsonLoose(raw) ?? repairAndParse(raw);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sentences?: unknown }).sentences)
      ? (parsed as { sentences: unknown[] }).sentences
      : undefined;
  if (!entries) {
    return undefined;
  }
  const sentences: string[] = [];
  for (let index = 0; index < count; index++) {
    const value = entries[index];
    if (typeof value !== 'string' || !value.trim()) {
      return undefined;
    }
    sentences.push(value.trim());
  }
  return sentences;
}

export function applyPhrasedStatements(
  conventions: Convention[],
  sentences: string[],
): Convention[] {
  return conventions.map((convention, index) =>
    sentences[index] ? { ...convention, statement: sentences[index] } : convention,
  );
}

export async function phraseConventionsWithProvider(
  conventions: Convention[],
  provider: LLMProvider | undefined,
  model: string,
  signal: AbortSignal,
  cache?: Map<string, string[]>,
): Promise<Convention[]> {
  if (conventions.length === 0 || !provider) {
    return conventions;
  }
  const hash = conventionsStatsHash(conventions);
  const cached = cache?.get(hash);
  if (cached) {
    return applyPhrasedStatements(conventions, cached);
  }
  try {
    const raw = await collectCompletion(
      provider,
      model,
      buildConventionPhraserPrompt(conventions),
      signal,
      CONVENTION_PHRASER_MAX_TOKENS,
    );
    const sentences = parsePhrasedSentences(raw, conventions.length);
    if (!sentences) {
      return conventions;
    }
    cache?.set(hash, sentences);
    return applyPhrasedStatements(conventions, sentences);
  } catch {
    return conventions;
  }
}

export interface ConventionPhraserDeps {
  getModel: () => string;
  buildProvider: () => Promise<LLMProvider | undefined>;
}

export class ConventionPhraser {
  private readonly cache = new Map<string, string[]>();

  constructor(private readonly deps: ConventionPhraserDeps) {}

  async phrase(conventions: Convention[], signal?: AbortSignal): Promise<Convention[]> {
    const provider = await this.deps.buildProvider();
    return phraseConventionsWithProvider(
      conventions,
      provider,
      this.deps.getModel(),
      signal ?? new AbortController().signal,
      this.cache,
    );
  }
}
