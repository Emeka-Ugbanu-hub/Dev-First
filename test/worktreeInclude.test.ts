import { describe, expect, it } from 'vitest';
import {
  includeBaseDir,
  matchesWorktreeInclude,
  parseWorktreeInclude,
} from '../src/worktree/worktreeInclude';

describe('parseWorktreeInclude', () => {
  it('ignores blank lines and comments', () => {
    expect(parseWorktreeInclude('# secrets\n\n.env\n  \nconfig/local.json\n')).toEqual([
      '.env',
      'config/local.json',
    ]);
  });

  it('normalizes separators, leading ./ and trailing slashes', () => {
    expect(parseWorktreeInclude('.vscode\\settings.json\n./dist/\n/vendor')).toEqual([
      '.vscode/settings.json',
      'dist',
      'vendor',
    ]);
  });
});

describe('matchesWorktreeInclude', () => {
  it('matches exact paths only', () => {
    expect(matchesWorktreeInclude('.env', '.env')).toBe(true);
    expect(matchesWorktreeInclude('.env', 'src/.env')).toBe(false);
    expect(matchesWorktreeInclude('config/local.json', 'config/local.json')).toBe(true);
  });

  it('keeps * within a path segment', () => {
    expect(matchesWorktreeInclude('*.env', '.env')).toBe(true);
    expect(matchesWorktreeInclude('*.env', 'app.env')).toBe(true);
    expect(matchesWorktreeInclude('*.env', 'src/app.env')).toBe(false);
    expect(matchesWorktreeInclude('config/*.json', 'config/app.json')).toBe(true);
    expect(matchesWorktreeInclude('config/*.json', 'config/nested/app.json')).toBe(false);
  });

  it('lets ** cross directories and match zero directories', () => {
    expect(matchesWorktreeInclude('**/*.env', '.env')).toBe(true);
    expect(matchesWorktreeInclude('**/*.env', 'src/app.env')).toBe(true);
    expect(matchesWorktreeInclude('**/*.env', 'a/b/app.env')).toBe(true);
    expect(matchesWorktreeInclude('src/**', 'src/a/b.ts')).toBe(true);
  });

  it('supports ? as a single character', () => {
    expect(matchesWorktreeInclude('env.?', 'env.1')).toBe(true);
    expect(matchesWorktreeInclude('env.?', 'env.12')).toBe(false);
  });

  it('treats dots literally', () => {
    expect(matchesWorktreeInclude('.env', 'xenv')).toBe(false);
  });
});

describe('includeBaseDir', () => {
  it('returns the directory before the first wildcard', () => {
    expect(includeBaseDir('config/*.json')).toBe('config');
    expect(includeBaseDir('src/**/x.ts')).toBe('src');
    expect(includeBaseDir('**/*.env')).toBe('');
    expect(includeBaseDir('*.env')).toBe('');
    expect(includeBaseDir('.env')).toBe('');
  });
});
