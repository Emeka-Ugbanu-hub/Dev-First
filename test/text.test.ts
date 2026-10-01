import { describe, expect, it } from 'vitest';
import { replaceInContent, sanitizeSurrogates, truncateMiddle } from '../src/util/text';

describe('replaceInContent', () => {
  it('replaces a unique occurrence', () => {
    const result = replaceInContent('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 3;', false);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('const a = 3;\nconst b = 2;\n');
    expect(result.count).toBe(1);
  });

  it('refuses ambiguous replacements', () => {
    const result = replaceInContent('x\ny\nx\n', 'x', 'z', false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('multiple locations');
  });

  it('replaces all occurrences with replace_all', () => {
    const result = replaceInContent('x\ny\nx\n', 'x', 'z', true);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('z\ny\nz\n');
    expect(result.count).toBe(2);
  });

  it('handles CRLF content and preserves it', () => {
    const result = replaceInContent('a\r\nb\r\n', 'b', 'c', false);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('a\r\nc\r\n');
  });

  it('errors when old text is missing', () => {
    const result = replaceInContent('hello\n', 'nope', 'x', false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('errors on empty old text', () => {
    expect(replaceInContent('hello', '', 'x', false).ok).toBe(false);
  });
});

describe('sanitizeSurrogates', () => {
  it('replaces lone surrogates with U+FFFD', () => {
    expect(sanitizeSurrogates('a\uD800b')).toBe('a\uFFFDb');
    expect(sanitizeSurrogates('\uDC00')).toBe('\uFFFD');
    expect(sanitizeSurrogates('\uD83D')).toBe('\uFFFD');
    expect(sanitizeSurrogates('\uD83Dx\uDE00')).toBe('\uFFFDx\uFFFD');
    expect(sanitizeSurrogates('')).toBe('');
  });

  it('keeps valid surrogate pairs intact', () => {
    const emoji = '\u{1F600}';
    expect(sanitizeSurrogates(`ok ${emoji}!`)).toBe(`ok ${emoji}!`);
    expect(sanitizeSurrogates('\uD83D\uDE00')).toHaveLength(2);
  });
});

describe('truncateMiddle', () => {
  it('leaves short text alone', () => {
    expect(truncateMiddle('short', 100)).toBe('short');
  });

  it('truncates the middle of long text', () => {
    const result = truncateMiddle('a'.repeat(200), 100);
    expect(result).toContain('[truncated]');
    expect(result.length).toBeLessThan(200);
  });
});
