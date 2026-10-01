import { describe, expect, it } from 'vitest';
import { contextPercent, formatTokens } from '../webview/src/lib/usage';

describe('formatTokens', () => {
  it('formats small numbers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands', () => {
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(128_000)).toBe('128.0k');
  });

  it('formats millions', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});

describe('contextPercent', () => {
  it('computes a rounded percentage', () => {
    expect(contextPercent(64_000, 128_000)).toBe(50);
  });

  it('clamps to 0-100', () => {
    expect(contextPercent(0, 128_000)).toBe(0);
    expect(contextPercent(999_999, 128_000)).toBe(100);
  });

  it('handles a missing limit', () => {
    expect(contextPercent(1000, 0)).toBe(0);
  });
});
