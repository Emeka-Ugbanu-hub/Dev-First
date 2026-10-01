import { describe, expect, it } from 'vitest';
import { CATALOG, type CatalogReasoning } from '../src/llm/catalog.generated';
import {
  hasInterleavedReasoning,
  modelInfo,
  modelsForProvider,
  readLiveModels,
  reasoningFor,
  reasoningLevelsFor,
  reasoningLevelsFrom,
  resolveCatalogModels,
  snapReasoning,
  storeLiveModels,
} from '../src/llm/catalog';

function anyProvider(): string {
  const provider = Object.keys(CATALOG).find((id) => Object.keys(CATALOG[id]).length > 0);
  if (!provider) {
    throw new Error('catalog is empty');
  }
  return provider;
}

function findModel(kind: CatalogReasoning['kind']): { provider: string; modelId: string } {
  for (const [provider, models] of Object.entries(CATALOG)) {
    for (const [modelId, model] of Object.entries(models)) {
      if (model.reasoning?.kind === kind) {
        return { provider, modelId };
      }
    }
  }
  throw new Error(`no ${kind} reasoning model in catalog`);
}

describe('resolveCatalogModels', () => {
  it('merges live and catalog, deduping case-insensitively with live casing winning', () => {
    const provider = anyProvider();
    const sample = Object.keys(CATALOG[provider])[0];
    const merged = resolveCatalogModels(provider, [sample.toUpperCase(), 'my-local-model', 'MY-LOCAL-MODEL']);
    expect(merged[0]).toBe(sample.toUpperCase());
    expect(merged.filter((model) => model.toLowerCase() === sample.toLowerCase())).toHaveLength(1);
    expect(merged.filter((model) => model.toLowerCase() === 'my-local-model')).toHaveLength(1);
    expect(merged).not.toContain(sample.toLowerCase());
  });

  it('appends catalog-only models after live results', () => {
    const provider = anyProvider();
    const keys = Object.keys(CATALOG[provider]);
    const merged = resolveCatalogModels(provider, [keys[0]]);
    expect(merged[0]).toBe(keys[0]);
    expect(merged).toHaveLength(keys.length);
  });

  it('returns an empty list when neither source has models', () => {
    expect(resolveCatalogModels('not-a-provider', [])).toEqual([]);
    expect(modelsForProvider('not-a-provider', [])).toEqual([]);
  });
});

describe('modelsForProvider', () => {
  it('uses catalog models when live is empty', () => {
    const provider = anyProvider();
    expect(modelsForProvider(provider, [])).toEqual(Object.keys(CATALOG[provider]));
  });

  it('prefers live models when present', () => {
    const provider = anyProvider();
    const merged = modelsForProvider(provider, ['live-only']);
    expect(merged[0]).toBe('live-only');
  });
});

describe('modelInfo', () => {
  it('returns catalog metadata for known models', () => {
    const provider = anyProvider();
    const modelId = Object.keys(CATALOG[provider])[0];
    const info = modelInfo(provider, modelId);
    expect(info?.id).toBe(modelId);
    expect(info?.contextWindow).toBe(CATALOG[provider][modelId].contextWindow);
  });

  it('resolves prefixed live ids to catalog entries', () => {
    const provider = anyProvider();
    const modelId = Object.keys(CATALOG[provider])[0];
    expect(modelInfo(provider, `${provider}/${modelId}`)?.id).toBe(modelId);
  });

  it('returns undefined for unknown providers and models', () => {
    expect(modelInfo('not-a-provider', 'x')).toBeUndefined();
    expect(modelInfo(anyProvider(), 'definitely-not-a-model')).toBeUndefined();
  });
});

describe('reasoningFor', () => {
  it('returns the catalog reasoning spec per kind', () => {
    expect(reasoningFor(findModel('toggle').provider, findModel('toggle').modelId)?.kind).toBe('toggle');
    expect(reasoningFor(findModel('effort').provider, findModel('effort').modelId)?.kind).toBe('effort');
    expect(reasoningFor(findModel('budget').provider, findModel('budget').modelId)?.kind).toBe('budget');
  });

  it('returns undefined when the model does not reason', () => {
    const provider = anyProvider();
    const found = Object.entries(CATALOG[provider]).find(([, model]) => !model.reasoning);
    if (found) {
      expect(reasoningFor(provider, found[0])).toBeUndefined();
    }
    expect(reasoningFor(provider, 'missing-model')).toBeUndefined();
  });
});

describe('hasInterleavedReasoning', () => {
  it('reads the interleaved reasoning capability from the catalog', () => {
    const modelId = 'interleaved-test-model';
    (CATALOG.openai as Record<string, unknown>)[modelId] = {
      id: modelId,
      name: modelId,
      contextWindow: 1000,
      maxOutput: 1000,
      capabilities: ['tools', 'interleaved-reasoning'],
    };
    try {
      expect(hasInterleavedReasoning('openai', modelId)).toBe(true);
      expect(hasInterleavedReasoning('openai', 'gpt-4o')).toBe(false);
      expect(hasInterleavedReasoning('not-a-provider', modelId)).toBe(false);
    } finally {
      delete (CATALOG.openai as Record<string, unknown>)[modelId];
    }
  });
});

describe('reasoningLevelsFrom', () => {
  it('maps toggle to off/on', () => {
    expect(reasoningLevelsFrom({ kind: 'toggle' })).toEqual(['off', 'on']);
  });

  it('keeps only the effort values the provider advertises', () => {
    expect(reasoningLevelsFrom({ kind: 'effort', values: ['minimal', 'low', 'high'] })).toEqual([
      'minimal',
      'low',
      'high',
    ]);
  });

  it('keeps only explicitly advertised values', () => {
    expect(reasoningLevelsFrom({ kind: 'effort', values: ['none', 'default', 'low'] })).toEqual([
      'none',
      'default',
      'low',
    ]);
  });

  it('does not invent effort levels for budget reasoning', () => {
    expect(reasoningLevelsFrom({ kind: 'budget', min: 1024, max: 0 })).toEqual([]);
  });

  it('hides the control when reasoning is unknown', () => {
    expect(reasoningLevelsFrom(undefined)).toEqual([]);
  });
});

describe('reasoningLevelsFor', () => {
  it('derives levels from the catalog for each kind', () => {
    const toggle = findModel('toggle');
    expect(reasoningLevelsFor(toggle.provider, toggle.modelId)).toEqual(['off', 'on']);
    const budget = findModel('budget');
    expect(reasoningLevelsFor(budget.provider, budget.modelId)).toEqual([]);
  });

  it('returns [] for models without catalog reasoning', () => {
    expect(reasoningLevelsFor('openai', 'definitely-not-a-model')).toEqual([]);
  });
});

describe('snapReasoning', () => {
  it('keeps supported values', () => {
    expect(snapReasoning('high', ['off', 'low', 'medium', 'high'])).toBe('high');
  });

  it('snaps unknown values to the first supported level', () => {
    expect(snapReasoning('xhigh', ['off', 'on'])).toBe('off');
    expect(snapReasoning('default', ['off', 'low'])).toBe('off');
  });

  it('leaves the value untouched when no levels exist', () => {
    expect(snapReasoning('medium', [])).toBe('medium');
  });
});

describe('model list persistence', () => {
  it('round-trips the last live list per preset', async () => {
    const store = new Map<string, unknown>();
    const state = {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    };
    await storeLiveModels(state, 'groq', ['llama-3.3-70b', 'mixtral-8x7b']);
    expect(readLiveModels(state, 'groq')).toEqual(['llama-3.3-70b', 'mixtral-8x7b']);
    expect(readLiveModels(state, 'openai')).toEqual([]);
    await storeLiveModels(state, 'groq', []);
    expect(readLiveModels(state, 'groq')).toEqual([]);
  });

  it('ignores malformed persisted values', () => {
    const state = {
      get: <T>(key: string) =>
        (key.endsWith('groq') ? ['llama-3.3-70b', '', 42] : 'nope') as unknown as T | undefined,
    };
    expect(readLiveModels(state, 'groq')).toEqual(['llama-3.3-70b']);
    expect(readLiveModels(state, 'openai')).toEqual([]);
  });
});
