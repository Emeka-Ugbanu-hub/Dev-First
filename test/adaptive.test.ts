import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_ADAPTIVE_MODEL_PATTERNS,
  adaptiveEffort,
  adaptiveKind,
  fetchOllamaCapability,
  resetOllamaCapabilityCache,
} from '../src/llm/adaptive';
import { CATALOG, type CatalogModel } from '../src/llm/catalog.generated';

function catalogModel(reasoning: CatalogModel['reasoning']): CatalogModel {
  return { id: 'test-model', name: 'Test Model', contextWindow: 1000, maxOutput: 1000, reasoning };
}

beforeEach(() => resetOllamaCapabilityCache());
afterEach(() => vi.unstubAllGlobals());

describe('adaptiveKind', () => {
  it('detects curated Anthropic adaptive models', () => {
    expect(ANTHROPIC_ADAPTIVE_MODEL_PATTERNS.length).toBeGreaterThan(0);
    expect(adaptiveKind('anthropic', 'claude-sonnet-4-6', undefined)).toBe('anthropic-adaptive');
    expect(adaptiveKind('anthropic', 'claude-opus-4.6', undefined)).toBe('anthropic-adaptive');
    expect(adaptiveKind('anthropic', 'claude-sonnet-5', undefined)).toBe('anthropic-adaptive');
  });

  it('stays conservative with older Anthropic models', () => {
    expect(adaptiveKind('anthropic', 'claude-sonnet-4-5', undefined)).toBeUndefined();
    expect(adaptiveKind('anthropic', 'claude-3-5-sonnet-latest', undefined)).toBeUndefined();
    expect(adaptiveKind('anthropic', 'claude-3-7-sonnet', undefined)).toBeUndefined();
    expect(adaptiveKind('openrouter', 'anthropic/claude-sonnet-4-6', undefined)).toBeUndefined();
  });

  it('detects dynamic Gemini budgets from the catalog', () => {
    const info = catalogModel({ kind: 'budget', min: -1, max: 32768 });
    expect(adaptiveKind('gemini', 'gemini-dynamic-test', info)).toBe('gemini-dynamic');
    expect(adaptiveKind('openai', 'gemini-dynamic-test', info)).toBeUndefined();
  });

  it('treats default and auto effort values as implicit adaptive signals', () => {
    const implicit = catalogModel({ kind: 'effort', values: ['none', 'default', 'high'] });
    expect(adaptiveKind('anthropic', 'claude-x', implicit)).toBe('anthropic-adaptive');
    expect(adaptiveKind('gemini', 'gemini-x', implicit)).toBe('gemini-dynamic');
    expect(adaptiveKind('openrouter', 'qwen-x', implicit)).toBe('toggle');
  });

  it('marks catalog toggle models', () => {
    const info = catalogModel({ kind: 'toggle' });
    expect(adaptiveKind('gemini', 'toggle-model', info)).toBe('toggle');
  });

  it('returns undefined for models without adaptive signals', () => {
    expect(adaptiveKind('openai', 'gpt-5', CATALOG.openai['gpt-5'])).toBeUndefined();
    expect(adaptiveKind('deepseek', 'deepseek-v4-pro', CATALOG.deepseek['deepseek-v4-pro'])).toBeUndefined();
    expect(adaptiveKind('anthropic', 'claude-sonnet-4-5', CATALOG.anthropic['claude-sonnet-4-5'])).toBeUndefined();
    expect(adaptiveKind('openai', 'gpt-4o', CATALOG.openai['gpt-4o'])).toBeUndefined();
  });
});

describe('adaptiveEffort', () => {
  it('only sends adaptive payloads at high and max effort', () => {
    expect(adaptiveEffort('high')).toBe(true);
    expect(adaptiveEffort('max')).toBe(true);
    expect(adaptiveEffort('low')).toBe(false);
    expect(adaptiveEffort('medium')).toBe(false);
    expect(adaptiveEffort(undefined)).toBe(false);
  });

  it('treats model-default efforts as adaptive', () => {
    expect(adaptiveEffort('default')).toBe(true);
    expect(adaptiveEffort('auto')).toBe(true);
  });
});

describe('fetchOllamaCapability', () => {
  it('parses thinking capabilities and caches per model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      capabilities: ['completion', 'thinking'],
      thinking: { values: ['low', 'high'], default: 'low' },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOllamaCapability('http://localhost:11434/v1', 'qwen3:8b')).resolves.toEqual({
      capabilities: ['completion', 'thinking'],
      thinking: true,
      reasoningLevels: ['low', 'high'],
      reasoningDefault: 'low',
    });
    await expect(fetchOllamaCapability('http://localhost:11434/v1', 'qwen3:8b')).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/show');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'qwen3:8b' });
  });

  it('falls back to off/on when only the thinking capability is advertised', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      capabilities: ['completion', 'thinking'],
    }), { status: 200 })));

    await expect(fetchOllamaCapability('http://localhost:11434', 'gemma3:4b')).resolves.toEqual({
      capabilities: ['completion', 'thinking'],
      thinking: true,
      reasoningLevels: ['off', 'on'],
    });
  });

  it('reports no thinking when the capability is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      capabilities: ['completion', 'vision'],
    }), { status: 200 })));

    await expect(fetchOllamaCapability('http://localhost:11434', 'llama3:8b')).resolves.toEqual({
      capabilities: ['completion', 'vision'],
      thinking: false,
    });
  });

  it('fails silently when /api/show is unreachable or errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    await expect(fetchOllamaCapability('http://localhost:11434', 'missing')).resolves.toBeUndefined();

    resetOllamaCapabilityCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(fetchOllamaCapability('http://localhost:11434', 'missing')).resolves.toBeUndefined();
  });
});
