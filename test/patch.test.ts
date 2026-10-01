import { describe, expect, it } from 'vitest';
import { applyHunks, parsePatch } from '../src/agent/patch';

describe('parsePatch', () => {
  it('parses add, update and delete sections', () => {
    const ops = parsePatch(`*** Begin Patch
*** Add File: src/new.ts
+export const x = 1;
+export const y = 2;
*** Update File: src/old.ts
@@
-const a = 1;
+const a = 2;
*** Delete File: src/gone.ts
*** End Patch`);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ type: 'add', path: 'src/new.ts', content: 'export const x = 1;\nexport const y = 2;' });
    expect(ops[1].type).toBe('update');
    expect(ops[1].hunks).toHaveLength(1);
    expect(ops[1].hunks?.[0].lines).toEqual(['-const a = 1;', '+const a = 2;']);
    expect(ops[2]).toMatchObject({ type: 'delete', path: 'src/gone.ts' });
  });

  it('tolerates missing begin/end markers', () => {
    const ops = parsePatch(`*** Update File: a.ts
@@
-old
+new`);
    expect(ops).toHaveLength(1);
    expect(ops[0].hunks?.[0].lines).toEqual(['-old', '+new']);
  });
});

describe('applyHunks', () => {
  it('applies an exact match', () => {
    const original = 'line1\nline2\nline3\n';
    const result = applyHunks(original, [{ lines: [' line1', '-line2', '+changed'] }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('line1\nchanged\nline3\n');
    }
  });

  it('applies multiple hunks', () => {
    const original = 'a\nb\nc\nd\ne\n';
    const result = applyHunks(original, [
      { lines: ['-a', '+A'] },
      { lines: ['-e', '+E'] },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('A\nb\nc\nd\nE\n');
    }
  });

  it('falls back to whitespace-insensitive matching', () => {
    const original = 'function x() {\n    return 1;\n}\n';
    const result = applyHunks(original, [{ lines: [' function x() {', '-  return 1;', '+  return 2;'] }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('return 2;');
    }
  });

  it('fails when the hunk is not found', () => {
    const result = applyHunks('hello\n', [{ lines: ['-missing'] }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Could not locate');
    }
  });

  it('preserves CRLF line endings', () => {
    const original = 'a\r\nb\r\n';
    const result = applyHunks(original, [{ lines: ['-a', '+A'] }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toBe('A\r\nb\r\n');
    }
  });
});
