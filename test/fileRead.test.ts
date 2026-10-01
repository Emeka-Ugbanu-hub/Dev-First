import { describe, expect, it } from 'vitest';
import { headTailTruncate, truncateLine } from '../src/agent/fileRead';

describe('truncateLine', () => {
  it('leaves short lines unchanged', () => {
    expect(truncateLine('short', 10)).toBe('short');
  });

  it('truncates long lines with a marker', () => {
    expect(truncateLine('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)} … [truncated]`);
  });
});

describe('headTailTruncate', () => {
  it('returns text unchanged when within the cap', () => {
    expect(headTailTruncate('hello', 10)).toBe('hello');
  });

  it('keeps the head and tail with an omitted-lines marker', () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
    const result = headTailTruncate(text, 200);
    expect(result).toContain('line 0');
    expect(result).toContain('line 99');
    expect(result).toMatch(/\[\d+ lines omitted\]/);
    expect(result.length).toBeLessThan(text.length);
  });
});
