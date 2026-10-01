import { describe, expect, it } from 'vitest';
import { appendDelta } from '../src/shared/stream';

describe('appendDelta', () => {
  it('joins deltas without inserting or removing characters', () => {
    expect(appendDelta('file.', 'Checking now')).toBe('file.Checking now');
  });

  it('preserves newlines between deltas', () => {
    expect(appendDelta('done.\n', '\nNext step')).toBe('done.\n\nNext step');
    expect(appendDelta('line one\n', 'line two')).toBe('line one\nline two');
  });

  it('preserves leading and trailing spaces in each delta', () => {
    expect(appendDelta('', '  spaced  ')).toBe('  spaced  ');
    expect(appendDelta('a ', ' b')).toBe('a  b');
    expect(appendDelta('x\t', '\ty')).toBe('x\t\ty');
  });

  it('handles empty accumulations and empty deltas', () => {
    expect(appendDelta('', '')).toBe('');
    expect(appendDelta('kept', '')).toBe('kept');
    expect(appendDelta('', 'added')).toBe('added');
  });
});
