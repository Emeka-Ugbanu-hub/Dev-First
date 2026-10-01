import { describe, expect, it } from 'vitest';
import { MAX_SELECTION_CHARS, formatSelectionAttachment } from '../src/util/selection';

describe('formatSelectionAttachment', () => {
  it('includes the path, range and a fenced code block', () => {
    const text = formatSelectionAttachment({
      path: 'src/app.ts',
      startLine: 10,
      endLine: 12,
      text: 'const a = 1;',
    });
    expect(text).toContain('src/app.ts:10-12');
    expect(text).toContain('```');
    expect(text).toContain('const a = 1;');
  });

  it('truncates very long selections', () => {
    const text = formatSelectionAttachment({
      path: 'big.ts',
      startLine: 1,
      endLine: 9999,
      text: 'x'.repeat(MAX_SELECTION_CHARS + 500),
    });
    expect(text).toContain('[selection truncated]');
    expect(text.length).toBeLessThan(MAX_SELECTION_CHARS + 400);
  });
});
