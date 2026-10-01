import { describe, expect, it } from 'vitest';
import type { LLMProvider, StreamEvent } from '../src/llm/types';
import type { Convention } from '../src/scan/conventions';
import {
  conventionsStatsHash,
  parsePhrasedSentences,
  phraseConventionsWithProvider,
} from '../src/scan/conventionPhraser';

function convention(statement: string, id = 'auth-placement'): Convention {
  return { id, statement, confidence: 0.8, evidence: ['a.ts:1'] };
}

function providerReturning(responses: string[]): {
  provider: LLMProvider;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      id: 'test',
      async *chat(): AsyncGenerator<StreamEvent> {
        const raw = responses[Math.min(calls, responses.length - 1)] ?? '';
        calls++;
        yield { type: 'text', text: raw };
        yield { type: 'done' };
      },
      listModels: async () => [],
      embed: async () => [],
    },
  };
}

function providerThrowing(): LLMProvider {
  return {
    id: 'test',
    async *chat(): AsyncGenerator<StreamEvent> {
      throw new Error('offline');
    },
    listModels: async () => [],
    embed: async () => [],
  };
}

describe('conventionsStatsHash', () => {
  it('is stable and changes with the stats', () => {
    const stats = [convention('Handlers enforce auth.')];
    expect(conventionsStatsHash(stats)).toBe(conventionsStatsHash([...stats]));
    expect(conventionsStatsHash(stats)).not.toBe(
      conventionsStatsHash([convention('Handlers do not enforce auth.')]),
    );
  });
});

describe('parsePhrasedSentences', () => {
  it('accepts an array or an object and enforces the count', () => {
    expect(parsePhrasedSentences('{"sentences":["One."]}', 1)).toEqual(['One.']);
    expect(parsePhrasedSentences('["One."]', 1)).toEqual(['One.']);
    expect(parsePhrasedSentences('{"sentences":["One."]}', 2)).toBeUndefined();
    expect(parsePhrasedSentences('{"sentences":[""]}', 1)).toBeUndefined();
    expect(parsePhrasedSentences('not json', 1)).toBeUndefined();
  });
});

describe('phraseConventionsWithProvider', () => {
  const stats = [convention('Authentication is enforced in the handler layer: 8 of 10 handlers call an auth check.')];

  it('phrases with one call and caches by stats hash', async () => {
    const { provider, calls } = providerReturning([
      '{"sentences":["Handlers enforce authentication in 8 of 10 cases."]}',
    ]);
    const cache = new Map<string, string[]>();
    const signal = new AbortController().signal;
    const first = await phraseConventionsWithProvider(stats, provider, 'model', signal, cache);
    expect(first[0].statement).toBe('Handlers enforce authentication in 8 of 10 cases.');
    expect(calls()).toBe(1);
    const second = await phraseConventionsWithProvider(stats, provider, 'model', signal, cache);
    expect(second[0].statement).toBe('Handlers enforce authentication in 8 of 10 cases.');
    expect(calls()).toBe(1);
  });

  it('falls back to the deterministic sentence on invalid output', async () => {
    const { provider, calls } = providerReturning(['not json at all']);
    const result = await phraseConventionsWithProvider(
      stats,
      provider,
      'model',
      new AbortController().signal,
    );
    expect(result[0].statement).toBe(stats[0].statement);
    expect(calls()).toBe(1);
  });

  it('falls back when the provider throws', async () => {
    const result = await phraseConventionsWithProvider(
      stats,
      providerThrowing(),
      'model',
      new AbortController().signal,
    );
    expect(result[0].statement).toBe(stats[0].statement);
  });

  it('returns the deterministic sentences without a provider', async () => {
    const result = await phraseConventionsWithProvider(
      stats,
      undefined,
      'model',
      new AbortController().signal,
    );
    expect(result[0].statement).toBe(stats[0].statement);
  });
});
