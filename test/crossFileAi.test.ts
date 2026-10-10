import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
}));

import {
  buildPairCandidates,
  buildPairPrompt,
  CrossFileAi,
  pairCacheKey,
  parsePairVerdict,
} from '../src/scan/crossFileAi';
import type { CrossFileAiConfig, PairCandidate, PairVerdict } from '../src/scan/crossFileAi';
import type { DuplicationEntry, FileFacts } from '../src/scan/duplication';
import type { ChatMessage, LLMProvider, StreamEvent } from '../src/llm/types';

function entry(
  overrides: Partial<DuplicationEntry> & { file: string; startLine: number; name: string },
): DuplicationEntry {
  return {
    endLine: overrides.startLine + 6,
    tokenCount: 40,
    fingerprint: `fp-${overrides.file}-${overrides.startLine}`,
    shingles: [],
    exported: true,
    body: `body of ${overrides.name}`,
    ...overrides,
  };
}

function facts(file: string, overrides: Partial<FileFacts> = {}): FileFacts {
  return {
    file,
    imports: [],
    exports: [],
    handlers: [],
    constants: [],
    moduleCaches: [],
    listeners: [],
    storageKeys: [],
    functions: [],
    types: [],
    httpClients: [],
    httpCalls: [],
    scopedHttpClients: [],
    mutableState: [],
    stateWrites: [],
    sql: [],
    secrets: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<PairCandidate> = {}): PairCandidate {
  return {
    key: 'pair-1',
    left: { file: 'file:///a.ts', line: 2, name: 'getUser', body: 'BODY_LEFT' },
    right: { file: 'file:///b.ts', line: 8, name: 'getUser', body: 'BODY_RIGHT' },
    involvesHandler: false,
    involvesEvent: false,
    ...overrides,
  };
}

interface StubProvider extends LLMProvider {
  calls: number;
  prompts: string[];
}

function stubProvider(responses: string[]): StubProvider {
  const provider: StubProvider = {
    id: 'stub',
    calls: 0,
    prompts: [],
    async *chat(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
      const index = Math.min(provider.calls, responses.length - 1);
      provider.calls += 1;
      const user = messages.find((message) => message.role === 'user');
      provider.prompts.push(user?.content ?? '');
      const text = responses[index] ?? '';
      if (text) {
        yield { type: 'text' as const, text };
      }
    },
    async listModels(): Promise<string[]> {
      return [];
    },
    async embed(): Promise<number[][]> {
      return [];
    },
  };
  return provider;
}

function failingProvider(): LLMProvider {
  return {
    id: 'broken',
    async *chat(): AsyncGenerator<StreamEvent> {
      throw new Error('boom');
    },
    async listModels(): Promise<string[]> {
      return [];
    },
    async embed(): Promise<number[][]> {
      return [];
    },
  };
}

function memoryCache(): {
  get(key: string): Promise<PairVerdict | undefined>;
  set(key: string, verdict: PairVerdict): Promise<void>;
  map: Map<string, PairVerdict>;
} {
  const map = new Map<string, PairVerdict>();
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, verdict) => {
      map.set(key, verdict);
    },
  };
}

function aiWith(provider: LLMProvider, overrides: Partial<CrossFileAiConfig> = {}): CrossFileAi {
  return new CrossFileAi({
    getConfig: () => ({
      scanAi: true,
      scanAiCrossFile: true,
      scanAiCrossFileMaxPairs: 3,
      scanAiModel: '',
      model: 'stub-model',
      ...overrides,
    }),
    buildProvider: async () => provider,
    cache: memoryCache(),
  });
}

const DRIFTED = JSON.stringify({
  verdict: 'drifted',
  reason: 'different retry policy',
  recommendation: 'share one helper',
});
const SAME = JSON.stringify({
  verdict: 'same',
  reason: 'same behavior',
  recommendation: 'delete the copy',
});
const UNRELATED = JSON.stringify({ verdict: 'unrelated', reason: 'different intent', recommendation: '' });

describe('buildPairPrompt', () => {
  it('includes both bodies and the strict JSON contract', () => {
    const prompt = buildPairPrompt(candidate());
    expect(prompt.system).toContain('{"verdict":"same|drifted|unrelated","reason":"","recommendation":""}');
    expect(prompt.user).toContain('BODY_LEFT');
    expect(prompt.user).toContain('BODY_RIGHT');
    expect(prompt.user).toContain('getUser');
    expect(prompt.user).not.toContain('API contract drift');
    expect(prompt.user).not.toContain('emit payload');
  });

  it('adds the boundary check lines only when a handler or event is involved', () => {
    const handler = buildPairPrompt(candidate({ involvesHandler: true }));
    expect(handler.user).toContain('API contract drift');
    expect(handler.user).not.toContain('emit payload');
    const event = buildPairPrompt(candidate({ involvesEvent: true }));
    expect(event.user).toContain('emit payload');
    expect(event.user).not.toContain('API contract drift');
    const both = buildPairPrompt(candidate({ involvesHandler: true, involvesEvent: true }));
    expect(both.user).toContain('API contract drift');
    expect(both.user).toContain('emit payload');
  });
});

describe('parsePairVerdict', () => {
  it('parses strict and fenced JSON verdicts', () => {
    expect(parsePairVerdict(DRIFTED)).toEqual({
      verdict: 'drifted',
      reason: 'different retry policy',
      recommendation: 'share one helper',
    });
    expect(parsePairVerdict('```json\n{"verdict":"SAME","reason":"r","recommendation":"c"}\n```')).toEqual({
      verdict: 'same',
      reason: 'r',
      recommendation: 'c',
    });
  });

  it('rejects unknown verdicts and malformed output', () => {
    expect(parsePairVerdict('{"verdict":"maybe","reason":"r"}')).toBeUndefined();
    expect(parsePairVerdict('not json')).toBeUndefined();
    expect(parsePairVerdict('{"reason":"missing verdict"}')).toBeUndefined();
  });
});

describe('pairCacheKey', () => {
  it('is stable across side order and changes with either body', () => {
    expect(pairCacheKey('a', 'b')).toBe(pairCacheKey('b', 'a'));
    expect(pairCacheKey('a', 'b')).not.toBe(pairCacheKey('a', 'c'));
  });
});

describe('buildPairCandidates', () => {
  it('pairs same-name and same-concept exported functions with different fingerprints', () => {
    const entries = [
      entry({ file: 'file:///a.ts', startLine: 0, name: 'getUser', fingerprint: 'one' }),
      entry({ file: 'file:///b.ts', startLine: 10, name: 'getUser', fingerprint: 'two' }),
      entry({ file: 'file:///c.ts', startLine: 20, name: 'fetchUser', fingerprint: 'three' }),
      entry({ file: 'file:///d.ts', startLine: 30, name: 'saveOrder', fingerprint: 'four' }),
      entry({ file: 'file:///e.ts', startLine: 40, name: 'getUser', fingerprint: 'one' }),
      entry({ file: 'file:///f.ts', startLine: 50, name: 'loadUser', fingerprint: 'five', exported: false }),
    ];
    const candidates = buildPairCandidates({ openedFile: 'file:///a.ts', entries, facts: [] });
    expect(candidates.map((pair) => `${pair.left.name}->${pair.right.name}`)).toEqual([
      'getUser->getUser',
      'getUser->fetchUser',
    ]);
    expect(candidates[0].right.file).toBe('file:///b.ts');
    expect(candidates[1].right.file).toBe('file:///c.ts');
  });

  it('flags handler and event involvement from facts', () => {
    const entries = [
      entry({ file: 'file:///a.ts', startLine: 0, name: 'handleGetUser', fingerprint: 'one' }),
      entry({ file: 'file:///b.ts', startLine: 10, name: 'handleGetUser', fingerprint: 'two' }),
    ];
    const candidates = buildPairCandidates({
      openedFile: 'file:///a.ts',
      entries,
      facts: [
        facts('file:///b.ts', {
          listeners: [{ event: 'data', line: 1, kind: 'add', literal: true }],
        }),
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].involvesHandler).toBe(true);
    expect(candidates[0].involvesEvent).toBe(true);
  });
});

describe('CrossFileAi.judge', () => {
  it('turns same and drifted verdicts into findings and drops unrelated', async () => {
    const provider = stubProvider([DRIFTED, SAME, UNRELATED]);
    const ai = aiWith(provider);
    const result = await ai.judge('file:///a.ts', [
      candidate({ key: 'p1' }),
      candidate({ key: 'p2', right: { file: 'file:///c.ts', line: 4, name: 'getUser', body: 'BODY_C' } }),
      candidate({ key: 'p3', right: { file: 'file:///d.ts', line: 6, name: 'getUser', body: 'BODY_D' } }),
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].message).toContain('drifted');
    expect(result.findings[0].message).toContain('share one helper');
    expect(result.findings[0].category).toBe('smell');
    expect(result.findings[0].severity).toBe('info');
    expect(result.findings[0].file).toBe('file:///a.ts');
    expect(result.findings[0].related[0].file).toBe('file:///b.ts');
    expect(result.findings[1].message).toContain('same');
    expect(result.notice).toBeUndefined();
  });

  it('uses the cache so a repeated pair makes no second call', async () => {
    const provider = stubProvider([DRIFTED]);
    const ai = aiWith(provider);
    await ai.judge('file:///a.ts', [candidate()]);
    await ai.judge('file:///a.ts', [candidate()]);
    expect(provider.calls).toBe(1);
  });

  it('caps pairs at the configured budget and reports the skipped count', async () => {
    const provider = stubProvider([DRIFTED, SAME, DRIFTED, SAME]);
    const ai = aiWith(provider, { scanAiCrossFileMaxPairs: 2 });
    const result = await ai.judge('file:///a.ts', [
      candidate({ key: 'p1' }),
      candidate({ key: 'p2', right: { file: 'file:///b.ts', line: 9, name: 'getUser', body: 'B2' } }),
      candidate({ key: 'p3', right: { file: 'file:///b.ts', line: 10, name: 'getUser', body: 'B3' } }),
      candidate({ key: 'p4', right: { file: 'file:///b.ts', line: 11, name: 'getUser', body: 'B4' } }),
    ]);
    expect(provider.calls).toBe(2);
    expect(result.findings).toHaveLength(2);
    expect(result.notice?.ruleId).toBe('xf-pair-cap');
    expect(result.notice?.severity).toBe('info');
    expect(result.notice?.message).toContain('2 more related-file candidates were not reviewed');
  });

  it('returns only the notice when the budget is zero', async () => {
    const provider = stubProvider([DRIFTED]);
    const ai = aiWith(provider, { scanAiCrossFileMaxPairs: 0 });
    const result = await ai.judge('file:///a.ts', [candidate()]);
    expect(provider.calls).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.notice?.message).toContain('1 more related-file candidates were not reviewed');
  });

  it('swallows provider failures and malformed output', async () => {
    const broken = aiWith(failingProvider());
    const failed = await broken.judge('file:///a.ts', [candidate()]);
    expect(failed.findings).toEqual([]);
    const garbage = stubProvider(['not json at all']);
    const malformed = await aiWith(garbage).judge('file:///a.ts', [candidate()]);
    expect(malformed.findings).toEqual([]);
  });

  it('respects scanAi, scanAiCrossFile, and force', async () => {
    const provider = stubProvider([DRIFTED]);
    const disabled = aiWith(provider, { scanAi: false });
    await disabled.judge('file:///a.ts', [candidate()]);
    expect(provider.calls).toBe(0);
    await disabled.judge('file:///a.ts', [candidate()], { force: true });
    expect(provider.calls).toBe(1);

    const provider2 = stubProvider([DRIFTED]);
    const crossOff = aiWith(provider2, { scanAiCrossFile: false });
    await crossOff.judge('file:///a.ts', [candidate()], { force: true });
    expect(provider2.calls).toBe(0);
  });

  it('judges every candidate when maxPairs is raised to the candidate count', async () => {
    const provider = stubProvider([SAME]);
    const ai = aiWith(provider, { scanAiCrossFileMaxPairs: 0 });
    const result = await ai.judge(
      'file:///a.ts',
      [
        candidate({ key: 'p1' }),
        candidate({
          key: 'p2',
          right: { file: 'file:///b.ts', line: 9, name: 'getUser', body: 'OTHER_BODY' },
        }),
      ],
      { maxPairs: 2 },
    );
    expect(provider.calls).toBe(2);
    expect(result.notice).toBeUndefined();
    expect(result.findings).toHaveLength(2);
  });
});
