import { describe, expect, it } from 'vitest';
import { filterModels } from '../webview/src/lib/models';

describe('filterModels', () => {
  const models = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-5', 'gemini-2.0-flash'];

  it('returns everything for an empty query', () => {
    expect(filterModels(models, '')).toEqual(models);
    expect(filterModels(models, '   ')).toEqual(models);
  });

  it('filters case-insensitively', () => {
    expect(filterModels(models, 'GPT')).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('matches substrings', () => {
    expect(filterModels(models, 'sonnet')).toEqual(['claude-sonnet-4-5']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterModels(models, 'zzz')).toEqual([]);
  });
});
