import { describe, expect, it } from 'vitest';
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
