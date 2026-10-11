import { describe, expect, it } from 'vitest';
import {
  assertFresh,
  fileCacheKey,
  isGeneratedPath,
  occurrenceLines,
  replaceExactAll,
  replaceExactAt,
  validateWorkspacePath,
} from '../src/agent/compoundPrimitives';
import { sha1Of } from '../src/util/atomicWrite';
import {
  INSTRUCTION_ASK,
  findQuotedAssignments,
  parseInstruction,
  setQuotedString,
} from '../src/agent/instructionParser';

describe('instruction parser', () => {
  it('parses rename, replace, remove, and set-string forms', () => {
    expect(parseInstruction('rename getPriority to priorityForScore')).toEqual({
      kind: 'rename',
      oldName: 'getPriority',
      newName: 'priorityForScore',
    });
    expect(parseInstruction('replace "old text" with "new text"')).toEqual({
      kind: 'replace',
      oldText: 'old text',
      newText: 'new text',
    });
    expect(parseInstruction("remove 'dead code'")).toEqual({
      kind: 'remove',
      oldText: 'dead code',
    });
    expect(parseInstruction('set the string theme to "dark"')).toEqual({
      kind: 'set_string',
      name: 'theme',
      value: 'dark',
    });
  });

  it('never guesses for unknown instructions', () => {
    const parsed = parseInstruction('make it better somehow');
    expect(parsed.kind).toBe('unknown');
    if (parsed.kind === 'unknown') {
      expect(parsed.ask).toBe(INSTRUCTION_ASK);
    }
    expect(parseInstruction('   ').kind).toBe('unknown');
  });
});

describe('quoted string edits', () => {
  it('rejects missing and ambiguous assignments', () => {
    expect(setQuotedString('const a = 1;', 'theme', 'dark')).toMatchObject({ ok: false });
    const twice = setQuotedString(
      'const a = { "theme": "light" };\nconst b = { "theme": "light" };',
      'theme',
      'dark',
    );
    expect(twice).toMatchObject({ ok: false });
    if (!twice.ok) {
      expect(twice.lines).toEqual([1, 2]);
    }
  });

  it('replaces a single assignment and locates it', () => {
    const outcome = setQuotedString('const s = { "theme": "light" };', 'theme', 'dark');
    expect(outcome).toEqual({
      ok: true,
      content: 'const s = { "theme": "dark" };',
      count: 1,
    });
    expect(findQuotedAssignments('const s = { "theme": "light" };', 'theme')).toHaveLength(1);
  });
});

describe('workspace path validation', () => {
  it('accepts relative paths and refuses escapes', () => {
    expect(validateWorkspacePath('/w', 'src/a.ts').ok).toBe(true);
    expect(validateWorkspacePath('/w', '../secret').ok).toBe(false);
    expect(validateWorkspacePath('/w', '/etc/passwd').ok).toBe(false);
    expect(validateWorkspacePath('/w', '').ok).toBe(false);
    expect(validateWorkspacePath('/w', 42).ok).toBe(false);
  });
});

describe('generated and cache guards', () => {
  it('flags generated files, lockfiles, and generated directories', () => {
    for (const value of [
      'package-lock.json',
      'dist/app.js',
      'out/x.js',
      'build/x.js',
      'app.min.js',
      'types.generated.ts',
      'generated/x.ts',
      'src/__generated__/x.ts',
    ]) {
      expect(isGeneratedPath(value), value).toBe(true);
    }
    expect(isGeneratedPath('src/app.ts')).toBe(false);
  });

  it('keys the read cache by uri, hash, language, and version', () => {
    const base = fileCacheKey('file://w/a.ts', 'h1', 'typescript', 1);
    expect(fileCacheKey('file://w/a.ts', 'h1', 'typescript', 1)).toBe(base);
    expect(fileCacheKey('file://w/b.ts', 'h1', 'typescript', 1)).not.toBe(base);
    expect(fileCacheKey('file://w/a.ts', 'h2', 'typescript', 1)).not.toBe(base);
    expect(fileCacheKey('file://w/a.ts', 'h1', 'javascript', 1)).not.toBe(base);
    expect(fileCacheKey('file://w/a.ts', 'h1', 'typescript', 2)).not.toBe(base);
  });

  it('detects stale content against a recorded hash', () => {
    expect(() => assertFresh(sha1Of('same'), 'same', 'src/a.ts')).not.toThrow();
    expect(() => assertFresh(sha1Of('old'), 'new', 'src/a.ts')).toThrow(/src\/a\.ts/);
  });
});

describe('exact replacements', () => {
  it('counts occurrences with line numbers', () => {
    expect(occurrenceLines('foo\nbar\nfoo', 'foo')).toEqual([1, 3]);
    expect(occurrenceLines('nothing', 'foo')).toEqual([]);
    expect(occurrenceLines('anything', '')).toEqual([]);
  });

  it('replaces a specific occurrence and everything', () => {
    const content = 'foo\nbar\nfoo';
    expect(replaceExactAt(content, 'foo', 'baz', 2)).toBe('foo\nbar\nbaz');
    expect(replaceExactAt(content, 'missing', 'baz', 1)).toBeUndefined();
    expect(replaceExactAll(content, 'foo', 'baz')).toBe('baz\nbar\nbaz');
  });
});
