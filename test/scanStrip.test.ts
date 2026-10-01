import { describe, expect, it } from 'vitest';
import { stripForAi } from '../src/scan/strip';

describe('stripForAi', () => {
  it('removes blank lines and full-line comments and maps lines back', () => {
    const source = [
      '// header',
      '',
      '  const a = 1;',
      '    // note',
      '  const b = 2;',
    ].join('\n');
    const stripped = stripForAi(source, 'typescript');
    expect(stripped.text.split('\n')).toEqual([' const a = 1;', ' const b = 2;']);
    expect(stripped.lineMap).toEqual([2, 4]);
  });

  it('removes multi-line block comments and keeps inline comments', () => {
    const source = [
      '/*',
      ' * block comment',
      ' */',
      'const a = 1; // inline',
      'const b = 2;',
    ].join('\n');
    const stripped = stripForAi(source, 'javascript');
    expect(stripped.text.split('\n')).toEqual(['const a = 1; // inline', 'const b = 2;']);
    expect(stripped.lineMap).toEqual([3, 4]);
  });

  it('preserves python leading indentation and removes hash comments', () => {
    const source = ['def run():', '    # comment', '    return 1', ''].join('\n');
    const stripped = stripForAi(source, 'python');
    expect(stripped.text).toBe('def run():\n    return 1');
    expect(stripped.lineMap).toEqual([0, 2]);
  });

  it('collapses runs of spaces including brace-language indentation', () => {
    const source = ['if (a) {', '    const  b   = 1;', '}'].join('\n');
    const stripped = stripForAi(source, 'typescript');
    expect(stripped.text).toBe('if (a) {\n const b = 1;\n}');
    expect(stripped.text).not.toMatch(/ {2,}/);
    expect(stripped.lineMap).toEqual([0, 1, 2]);
  });

  it('returns an empty map for comment-only text', () => {
    const stripped = stripForAi('// only\n\n', 'typescript');
    expect(stripped.text).toBe('');
    expect(stripped.lineMap).toEqual([]);
  });
});
