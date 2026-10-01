import { describe, expect, it } from 'vitest';
import { buildSearchPattern, collectSearchTexts } from '../webview/src/lib/search';

describe('buildSearchPattern', () => {
  function test(pattern: RegExp | undefined, text: string): boolean {
    if (!pattern) {
      return false;
    }
    pattern.lastIndex = 0;
    return pattern.test(text);
  }

  it('builds a case-insensitive literal pattern by default', () => {
    const pattern = buildSearchPattern('Hello', false, false);
    expect(test(pattern, 'say hello there')).toBe(true);
    expect(test(pattern, 'HELLO')).toBe(true);
  });

  it('respects case sensitivity', () => {
    const pattern = buildSearchPattern('Hello', true, false);
    expect(test(pattern, 'hello')).toBe(false);
    expect(test(pattern, 'Hello')).toBe(true);
  });

  it('escapes literal special characters', () => {
    const pattern = buildSearchPattern('a.b', false, false);
    expect(test(pattern, 'a.b')).toBe(true);
    expect(test(pattern, 'axb')).toBe(false);
  });

  it('supports regular expressions', () => {
    expect(test(buildSearchPattern('h.*o', false, true), 'hello')).toBe(true);
  });

  it('returns undefined for empty or invalid input', () => {
    expect(buildSearchPattern('', false, false)).toBeUndefined();
    expect(buildSearchPattern('(', false, true)).toBeUndefined();
  });
});

describe('collectSearchTexts', () => {
  it('combines message text, reasoning, and activity labels', () => {
    const targets = collectSearchTexts([
      { id: 'm1', text: 'hello world' },
      { id: 'm2', text: 'done', reasoning: 'thought about tokens', activities: [{ label: 'Read src/app.ts' }] },
      { id: 'm3' },
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[1].text).toContain('thought about tokens');
    expect(targets[1].text).toContain('Read src/app.ts');
  });
});
