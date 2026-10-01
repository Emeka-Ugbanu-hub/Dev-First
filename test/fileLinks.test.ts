import { describe, expect, it } from 'vitest';
import { isKnownFile, parseFileToken, setKnownFiles } from '../webview/src/lib/fileLinks';

describe('parseFileToken', () => {
  it('parses paths with extensions', () => {
    expect(parseFileToken('src/auth/service.ts')).toEqual({ path: 'src/auth/service.ts', line: undefined });
    expect(parseFileToken('package.json')).toEqual({ path: 'package.json', line: undefined });
  });

  it('parses line suffixes', () => {
    expect(parseFileToken('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 });
  });

  it('strips leading ./', () => {
    expect(parseFileToken('./src/app.ts')).toEqual({ path: 'src/app.ts', line: undefined });
  });

  it('rejects non-path inline code', () => {
    expect(parseFileToken('npm test')).toBeUndefined();
    expect(parseFileToken('const x = 1')).toBeUndefined();
    expect(parseFileToken('x')).toBeUndefined();
  });
});

describe('isKnownFile', () => {
  it('matches files from the workspace list', () => {
    setKnownFiles(['src/app.ts', './lib/utils.ts']);
    expect(isKnownFile('src/app.ts')).toBe(true);
    expect(isKnownFile('lib/utils.ts')).toBe(true);
    expect(isKnownFile('missing.ts')).toBe(false);
  });
});
