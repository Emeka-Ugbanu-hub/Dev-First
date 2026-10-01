import { describe, expect, it } from 'vitest';
import { parseFinishFiles } from '../src/agent/tools';

describe('parseFinishFiles', () => {
  it('parses file summaries', () => {
    const files = parseFinishFiles({
      files: [
        { path: 'auth/service.ts', summary: 'added middleware via Redis' },
        { path: 'login/page.tsx', summary: 'new login form' },
      ],
    });
    expect(files).toEqual([
      { path: 'auth/service.ts', summary: 'added middleware via Redis' },
      { path: 'login/page.tsx', summary: 'new login form' },
    ]);
  });

  it('drops entries without a path', () => {
    const files = parseFinishFiles({ files: [{ summary: 'no path' }, { path: 'a.ts', summary: 'ok' }] });
    expect(files).toEqual([{ path: 'a.ts', summary: 'ok' }]);
  });

  it('returns undefined for missing or empty input', () => {
    expect(parseFinishFiles({})).toBeUndefined();
    expect(parseFinishFiles({ files: [] })).toBeUndefined();
    expect(parseFinishFiles({ files: 'nope' })).toBeUndefined();
  });

  it('tolerates a missing summary', () => {
    const files = parseFinishFiles({ files: [{ path: 'a.ts' }] });
    expect(files).toEqual([{ path: 'a.ts', summary: '' }]);
  });
});
