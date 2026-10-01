import { describe, expect, it } from 'vitest';
import { applyHunks, findBlockByAnchor, findBlockWithDrift, locateHunk } from '../src/agent/patch';

describe('patch fallback ladder', () => {
  it('applies an exact match', () => {
    const original = 'a\nb\nc\n';
    const result = applyHunks(original, [{ lines: [' b', '-c', '+C'] }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('a\nb\nC\n');
    }
    expect(locateHunk(original.split('\n'), ['b', 'c'])?.strategy).toBe('exact');
  });

  it('applies when context whitespace differs', () => {
    const original = 'function x() {\n\treturn 1;\n}\n';
    const result = applyHunks(original, [
      { lines: [' function x() {', '-    return 1;', '+    return 2;'] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('function x() {\n    return 2;\n}\n');
    }
    expect(locateHunk(original.split('\n'), ['function x() {', '    return 1;'])?.strategy).toBe('fuzzy');
  });

  it('applies with up to two lines of drift inside the hunk', () => {
    const original = 'start\nconst a = 1;\n// user edit\nreturn a;\nend\n';
    const result = applyHunks(original, [
      { lines: [' start', ' const a = 1;', '-return a;', '+return 2;', ' end'] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('start\nconst a = 1;\nreturn 2;\nend\n');
    }
    expect(
      locateHunk(original.split('\n'), ['start', 'const a = 1;', 'return a;', 'end'])?.strategy,
    ).toBe('drift');
  });

  it('fails with a clear error only after every strategy fails', () => {
    const result = applyHunks('hello\nworld\n', [{ lines: ['-missing', '-lines'] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Could not locate');
      expect(result.error).toContain('exact');
      expect(result.error).toContain('anchor');
    }
  });
});

describe('findBlockWithDrift', () => {
  it('consumes up to two extra lines inside the matched region', () => {
    expect(findBlockWithDrift(['a', 'b', 'x1', 'x2', 'c', 'd'], ['a', 'b', 'c', 'd'])).toEqual({
      index: 0,
      length: 6,
    });
  });

  it('rejects more than two extra lines', () => {
    expect(
      findBlockWithDrift(['a', 'b', 'x1', 'x2', 'x3', 'c', 'd'], ['a', 'b', 'c', 'd']),
    ).toBeUndefined();
  });
});

describe('findBlockByAnchor', () => {
  it('locates a block by its longest line with normalized whitespace', () => {
    const file = ['start', 'const target = computeSomethingLong();', 'next', 'end'];
    const block = ['start', '   const target = computeSomethingLong();', 'next'];
    expect(findBlockByAnchor(file, block)).toBe(0);
  });
});
