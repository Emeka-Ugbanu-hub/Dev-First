import { describe, expect, it } from 'vitest';
import { filterMentions, mentionQuery } from '../webview/src/lib/mentions';

describe('mentionQuery', () => {
  it('matches at the start or after whitespace', () => {
    expect(mentionQuery('@src')).toBe('src');
    expect(mentionQuery('look at @src/ap')).toBe('src/ap');
  });

  it('returns null without an active mention', () => {
    expect(mentionQuery('hello')).toBeNull();
    expect(mentionQuery('@src done')).toBeNull();
    expect(mentionQuery('email@example.com')).toBeNull();
  });
});

describe('filterMentions', () => {
  const files = ['src/app.ts', 'src/lib/utils.ts', 'tests/app.test.ts', 'README.md'];

  it('returns matches for an empty query', () => {
    expect(filterMentions(files, '')).toHaveLength(4);
  });

  it('ranks basename matches first', () => {
    const result = filterMentions(files, 'app');
    expect(result[0]).toBe('src/app.ts');
    expect(result).toContain('tests/app.test.ts');
  });

  it('filters by substring', () => {
    expect(filterMentions(files, 'utils')).toEqual(['src/lib/utils.ts']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterMentions(files, 'zzz')).toEqual([]);
  });
});
