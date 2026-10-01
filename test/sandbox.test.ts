import { describe, expect, it } from 'vitest';
import { buildSeatbeltProfile, writableDirs } from '../src/agent/sandbox';

describe('writableDirs', () => {
  it('always includes the workspace and temp locations', () => {
    const dirs = writableDirs('/tmp/my-workspace');
    expect(dirs[0]).toBe('/tmp/my-workspace');
    expect(dirs).toContain('/tmp');
    expect(dirs).toContain('/private/tmp');
  });

  it('includes common package caches', () => {
    const dirs = writableDirs('/work');
    expect(dirs.some((dir) => dir.endsWith('.npm'))).toBe(true);
    expect(dirs.some((dir) => dir.endsWith('.cargo'))).toBe(true);
    expect(dirs.some((dir) => dir.endsWith('Library/Caches'))).toBe(true);
  });
});

describe('buildSeatbeltProfile', () => {
  it('denies writes by default and allows the listed directories', () => {
    const profile = buildSeatbeltProfile(['/work', '/tmp']);
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(allow file-write* (subpath "/work"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp"))');
  });

  it('allows the standard device files', () => {
    const profile = buildSeatbeltProfile(['/work']);
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain('(literal "/dev/stdout")');
    expect(profile).toContain('(literal "/dev/stderr")');
  });

  it('escapes quotes in paths', () => {
    const profile = buildSeatbeltProfile(['/weird"path']);
    expect(profile).toContain('\\"path');
  });
});
