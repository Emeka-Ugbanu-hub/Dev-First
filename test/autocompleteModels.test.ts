import { describe, expect, it } from 'vitest';
import {
  defaultAutocompleteModel,
  looksLikeCode,
  resolveAutocompleteModel,
} from '../src/autocomplete/modelDefaults';
import { buildCompletionMessages, cleanCompletion } from '../src/autocomplete/ChatFallback';

describe('resolveAutocompleteModel', () => {
  it('honors an explicitly configured model', () => {
    const result = resolveAutocompleteModel({ presetId: 'openai', configured: 'my-fim-model', chatModel: 'gpt-4o' });
    expect(result).toEqual({ model: 'my-fim-model', kind: 'fim' });
  });

  it('picks a preset default when the setting is empty', () => {
    expect(resolveAutocompleteModel({ presetId: 'openrouter', configured: '', chatModel: 'x' })).toEqual({
      model: 'mistralai/codestral-2501',
      kind: 'fim',
    });
    expect(resolveAutocompleteModel({ presetId: 'ollama', configured: '  ', chatModel: 'x' })).toEqual({
      model: 'qwen2.5-coder:7b',
      kind: 'fim',
    });
  });

  it('falls back to the connected chat model for presets without FIM', () => {
    expect(resolveAutocompleteModel({ presetId: 'openai', configured: '', chatModel: 'gpt-4o' })).toEqual({
      model: 'gpt-4o',
      kind: 'chat',
    });
    expect(resolveAutocompleteModel({ presetId: 'anthropic', configured: '', chatModel: 'claude-sonnet-4-5' })).toEqual({
      model: 'claude-sonnet-4-5',
      kind: 'chat',
    });
  });

  it('knows which presets have FIM defaults', () => {
    expect(defaultAutocompleteModel('openrouter')).toBeDefined();
    expect(defaultAutocompleteModel('ollama')).toBeDefined();
    expect(defaultAutocompleteModel('openai')).toBeUndefined();
    expect(defaultAutocompleteModel('custom')).toBeUndefined();
  });
});

describe('looksLikeCode', () => {
  it('accepts normal code lines', () => {
    expect(looksLikeCode('const total = items')).toBe(true);
    expect(looksLikeCode('function foo(a, b) {\n  return a')).toBe(true);
  });

  it('rejects comment lines', () => {
    expect(looksLikeCode('// this is a comment')).toBe(false);
    expect(looksLikeCode('# python comment')).toBe(false);
    expect(looksLikeCode(' * inside a block comment')).toBe(false);
  });

  it('rejects lines with unbalanced quotes', () => {
    expect(looksLikeCode('const s = "hello')).toBe(false);
    expect(looksLikeCode("const s = 'hello")).toBe(false);
    expect(looksLikeCode('const s = `hello')).toBe(false);
  });

  it('accepts balanced quotes', () => {
    expect(looksLikeCode('const s = "hello" +')).toBe(true);
  });
});

describe('chat fallback prompts', () => {
  it('builds a system + user message pair with the code fenced', () => {
    const messages = buildCompletionMessages('const a = 1;\n', 'return a;');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('const a = 1;');
    expect(messages[1].content).toContain('return a;');
  });

  it('caps the prefix and suffix sizes', () => {
    const messages = buildCompletionMessages('x'.repeat(5000), 'y'.repeat(5000));
    const content = messages[1].content as string;
    expect(content.length).toBeLessThan(2000);
  });

  it('cleans fences and limits to three lines', () => {
    expect(cleanCompletion('```ts\nreturn a;\n```')).toBe('return a;');
    expect(cleanCompletion('one\ntwo\nthree\nfour\nfive')).toBe('one\ntwo\nthree');
    expect(cleanCompletion('   ')).toBeUndefined();
  });
});
