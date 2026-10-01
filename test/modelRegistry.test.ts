import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ModelRegistry, normalizeModelId } from '../src/llm/modelRegistry';

describe('normalizeModelId', () => {
  it('lowercases and strips provider prefixes', () => {
    expect(normalizeModelId('anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('  GPT-4O  ')).toBe('gpt-4o');
  });
});

describe('ModelRegistry fallback', () => {
  it('knows common models without any network access', () => {
    const registry = new ModelRegistry('/nonexistent/cache.json');
    const info = registry.lookup('openai', 'gpt-4o');
    expect(info?.contextWindow).toBe(128_000);
    expect(info?.supportsVision).toBe(true);
  });

  it('knows reasoning models', () => {
    const registry = new ModelRegistry('/nonexistent/cache.json');
    expect(registry.lookup('openai', 'o3')?.supportsReasoning).toBe(true);
    expect(registry.lookup('anthropic', 'claude-sonnet-4-5')?.supportsReasoning).toBe(true);
  });

  it('resolves prefixed ids', () => {
    const registry = new ModelRegistry('/nonexistent/cache.json');
    expect(registry.lookup('openai', 'anthropic/claude-sonnet-4-5')?.contextWindow).toBe(200_000);
  });

  it('falls back to the provided limit for unknown models', () => {
    const registry = new ModelRegistry('/nonexistent/cache.json');
    expect(registry.contextWindowFor('openai', 'totally-unknown', 42_000)).toBe(42_000);
  });
});

describe('ModelRegistry provider model lists', () => {
  async function cacheFileWith(payload: unknown): Promise<string> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'dev-first-registry-'));
    const file = path.join(dir, 'cache.json');
    await fs.writeFile(file, JSON.stringify(payload));
    return file;
  }

  it('restores per-provider model ids from a version 3 cache', async () => {
    const cache = await cacheFileWith({
      version: 3,
      fetchedAt: Date.now(),
      models: {
        'deepseek:deepseek-v4': {
          id: 'deepseek-v4',
          name: 'DeepSeek V4',
          contextWindow: 128_000,
          maxOutput: 8_192,
          supportsTools: true,
        },
      },
      byProvider: { deepseek: ['deepseek-chat', 'deepseek-v4'] },
    });
    const registry = new ModelRegistry(cache);
    await registry.load();
    expect(registry.providerModelIds('deepseek')).toEqual(['deepseek-chat', 'deepseek-v4']);
    expect(registry.providerModelIds('openai')).toEqual([]);
  });

  it('refetches when the cache is an older version', async () => {
    const cache = await cacheFileWith({
      version: 2,
      fetchedAt: Date.now(),
      models: { 'x': { id: 'x', name: 'X', contextWindow: 1, maxOutput: 1, supportsTools: true } },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ deepseek: { models: { 'deepseek-v4': { name: 'DeepSeek V4' } } } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const registry = new ModelRegistry(cache);
      await registry.load();
      expect(fetchMock).toHaveBeenCalled();
      expect(registry.providerModelIds('deepseek')).toEqual(['deepseek-v4']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
