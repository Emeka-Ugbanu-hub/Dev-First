import { describe, expect, it } from 'vitest';
import { buildFimPrompt, parseFimResponse } from '../src/autocomplete/FimClient';

describe('buildFimPrompt', () => {
  it('keeps short input intact', () => {
    const result = buildFimPrompt('const a = 1;\n', 'return a;');
    expect(result.prompt).toBe('const a = 1;\n');
    expect(result.suffix).toBe('return a;');
  });

  it('trims long prefixes to a line boundary', () => {
    const prefix = `${'x'.repeat(3000)}\nconst visible = 1;\n`;
    const result = buildFimPrompt(prefix, '');
    expect(result.prompt.length).toBeLessThanOrEqual(2000);
    expect(result.prompt.startsWith('const visible')).toBe(true);
  });

  it('trims long suffixes to a line boundary', () => {
    const suffix = `\nconst tail = 2;\n${'y'.repeat(2000)}`;
    const result = buildFimPrompt('const a = 1;\n', suffix);
    expect(result.suffix.length).toBeLessThanOrEqual(800);
    expect(result.suffix.endsWith('const tail = 2;')).toBe(true);
  });
});

describe('parseFimResponse', () => {
  it('reads the completions text field', () => {
    expect(parseFimResponse({ choices: [{ text: 'return 42;' }] })).toBe('return 42;');
  });

  it('reads the chat-style content field', () => {
    expect(parseFimResponse({ choices: [{ message: { content: 'return 42;' } }] })).toBe('return 42;');
  });

  it('strips markdown fences', () => {
    expect(parseFimResponse({ choices: [{ text: '```ts\nreturn 42;\n```' }] })).toBe('return 42;');
  });

  it('returns undefined for empty or malformed responses', () => {
    expect(parseFimResponse({ choices: [{ text: '' }] })).toBeUndefined();
    expect(parseFimResponse({ choices: [] })).toBeUndefined();
    expect(parseFimResponse({})).toBeUndefined();
  });
});
