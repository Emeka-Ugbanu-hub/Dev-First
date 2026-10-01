import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
}));

import { scanText } from '../src/scan/engine';
import { filterFindingsByCategory, matchGlob } from '../src/scan/scanner';
import { RULE_PACKS } from '../src/scan/rules';
import { isRegexRule } from '../src/scan/ruleTypes';
import type { RegexScanRule, RulePack, ScanRule } from '../src/scan/ruleTypes';

function makeRule(overrides: Partial<RegexScanRule> & { id: string }): ScanRule {
  return {
    category: 'bug',
    severity: 'warning',
    pattern: /x/,
    message: 'message',
    why: 'why',
    fix: 'fix',
    ...overrides,
  };
}

function makePack(id: string, rules: ScanRule[], languages?: string[]): RulePack {
  return { id, rules, languages };
}

const options = { includeHotspots: true };

describe('scanText', () => {
  it('filters packs and rules by language', () => {
    const packs = [
      makePack('python-only', [makeRule({ id: 'py', pattern: /foo/ })], ['python']),
      makePack('all', [makeRule({ id: 'all', pattern: /bar/ })]),
      makePack('limited', [makeRule({ id: 'ts', pattern: /baz/, languages: ['typescript'] })]),
    ];
    const findings = scanText('foo bar baz', 'python', packs, options);
    expect(findings.map((finding) => finding.rule.id).sort()).toEqual(['all', 'py']);
  });

  it('computes line and character ranges', () => {
    const text = 'const a = 1;\nfoo bar baz\n';
    const findings = scanText(text, 'plaintext', [makePack('p', [makeRule({ id: 'r', pattern: /bar/ })])], options);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 1, startChar: 4, endChar: 7 });
  });

  it('caps the range at the end of the starting line', () => {
    const text = 'foo\nbar';
    const findings = scanText(text, 'plaintext', [makePack('p', [makeRule({ id: 'r', pattern: /foo[\s\S]*bar/ })])], options);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 0, startChar: 0, endChar: 3 });
  });

  it('skips zero-length matches without hanging', () => {
    const findings = scanText('axb', 'plaintext', [makePack('p', [makeRule({ id: 'r', pattern: /x*/ })])], options);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 0, startChar: 1, endChar: 2 });
  });

  it('drops hotspots when includeHotspots is false', () => {
    const pack = makePack('p', [
      makeRule({ id: 'hot', category: 'hotspot', severity: 'info', pattern: /warn/ }),
      makeRule({ id: 'bug', pattern: /warn/ }),
    ]);
    expect(scanText('warn', 'plaintext', [pack], { includeHotspots: false }).map((f) => f.rule.id)).toEqual(['bug']);
    expect(scanText('warn', 'plaintext', [pack], { includeHotspots: true }).map((f) => f.rule.id)).toEqual([
      'hot',
      'bug',
    ]);
  });

  it('suppresses findings with a bare devfirst-ignore on the same line', () => {
    const findings = scanText(
      'bad // devfirst-ignore',
      'plaintext',
      [makePack('p', [makeRule({ id: 'r', pattern: /bad/ })])],
      options,
    );
    expect(findings).toHaveLength(0);
  });

  it('suppresses findings with a bare devfirst-ignore on the line above', () => {
    const findings = scanText(
      '// devfirst-ignore\nbad',
      'plaintext',
      [makePack('p', [makeRule({ id: 'r', pattern: /bad/ })])],
      options,
    );
    expect(findings).toHaveLength(0);
  });

  it('suppresses only the named rule', () => {
    const packs = [makePack('p', [makeRule({ id: 'one', pattern: /bad/ }), makeRule({ id: 'two', pattern: /bad/ })])];
    const named = scanText('// devfirst-ignore one\nbad', 'plaintext', packs, options);
    expect(named.map((finding) => finding.rule.id)).toEqual(['two']);
    const other = scanText('// devfirst-ignore two\nbad', 'plaintext', packs, options);
    expect(other.map((finding) => finding.rule.id)).toEqual(['one']);
  });

  it('reports absent fileLevel patterns at line 0', () => {
    const pack = makePack('p', [makeRule({ id: 'marker', pattern: /required-marker/, fileLevel: true })]);
    const missing = scanText('nothing here', 'plaintext', [pack], options);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ line: 0, startChar: 0, endChar: 0 });
    expect(scanText('has required-marker', 'plaintext', [pack], options)).toHaveLength(0);
  });

  it('dedupes identical rule id, line, and start char', () => {
    const rule = makeRule({ id: 'dup', pattern: /x/ });
    const findings = scanText('x', 'plaintext', [makePack('a', [rule]), makePack('b', [rule])], options);
    expect(findings).toHaveLength(1);
  });
});

describe('filterFindingsByCategory', () => {
  const findings = scanText(
    'warn bad',
    'plaintext',
    [
      makePack('p', [
        makeRule({ id: 'hot', category: 'hotspot', severity: 'info', pattern: /warn/ }),
        makeRule({ id: 'bug', pattern: /bad/ }),
      ]),
    ],
    options,
  );

  it('keeps everything when no category is disabled', () => {
    expect(filterFindingsByCategory(findings, []).map((finding) => finding.rule.id)).toEqual([
      'hot',
      'bug',
    ]);
  });

  it('removes findings in disabled categories', () => {
    expect(filterFindingsByCategory(findings, ['hotspot']).map((finding) => finding.rule.id)).toEqual([
      'bug',
    ]);
    expect(filterFindingsByCategory(findings, ['bug']).map((finding) => finding.rule.id)).toEqual([
      'hot',
    ]);
    expect(filterFindingsByCategory(findings, ['bug', 'hotspot'])).toEqual([]);
  });

  it('ignores unknown category names', () => {
    expect(filterFindingsByCategory(findings, ['nonsense'])).toHaveLength(2);
  });
});

describe('matchGlob', () => {
  it('matches directory globs with **', () => {
    expect(matchGlob('/repo/node_modules/pkg/index.js', '**/node_modules/**')).toBe(true);
    expect(matchGlob('node_modules/pkg/index.js', '**/node_modules/**')).toBe(true);
    expect(matchGlob('/repo/src/index.js', '**/node_modules/**')).toBe(false);
    expect(matchGlob('/repo/dist/app.js', '**/dist/**')).toBe(true);
    expect(matchGlob('dist/app.js', '**/dist/**')).toBe(true);
    expect(matchGlob('src/app.min.js', '**/*.min.*')).toBe(true);
  });

  it('matches lockfiles and single-star patterns', () => {
    expect(matchGlob('/repo/yarn.lock', '**/yarn.lock')).toBe(true);
    expect(matchGlob('/repo/nested/pnpm-lock.yaml', '**/pnpm-lock.yaml')).toBe(true);
    expect(matchGlob('foo.ts', '*.ts')).toBe(true);
    expect(matchGlob('src/foo.ts', '*.ts')).toBe(false);
    expect(matchGlob('src/foo.ts', '**/*.ts')).toBe(true);
  });

  it('treats regex metacharacters in patterns literally', () => {
    expect(matchGlob('src/a+b.ts', 'src/a+b.ts')).toBe(true);
    expect(matchGlob('src/axb.ts', 'src/a+b.ts')).toBe(false);
    expect(matchGlob('a/b.ts', 'a/b.ts')).toBe(true);
    expect(matchGlob('aXb.ts', 'a.b.ts')).toBe(false);
  });
});

describe('RULE_PACKS', () => {
  const categories = ['bug', 'vulnerability', 'smell', 'hotspot', 'secret'];
  const severities = ['error', 'warning', 'info', 'hint'];

  it('has the expected packs', () => {
    expect(RULE_PACKS.map((pack) => pack.id)).toEqual([
      'any',
      'javascript',
      'python',
      'java',
      'go',
      'php',
      'csharp',
      'iac',
      'web',
      'structural',
      'analyzers',
      'flow-analyzers',
      'null-flow',
      'java-specific',
      'security-specific',
      'conventions',
      'secrets-more',
      'structure',
    ]);
  });

  it('keeps rule ids unique and regexes valid', () => {
    const ids = new Set<string>();
    for (const pack of RULE_PACKS) {
      for (const rule of pack.rules) {
        expect(ids.has(rule.id), `duplicate rule id ${rule.id}`).toBe(false);
        ids.add(rule.id);
        if (isRegexRule(rule)) {
          expect(() => new RegExp(rule.pattern.source, 'gmu')).not.toThrow();
        }
        expect(categories).toContain(rule.category);
        expect(severities).toContain(rule.severity);
        expect(rule.message.length).toBeGreaterThan(0);
        expect(rule.why.length).toBeGreaterThan(0);
        expect(rule.fix.length).toBeGreaterThan(0);
      }
    }
    expect(ids.size).toBeGreaterThan(0);
  });

  it('flags a representative sample', () => {
    const findings = scanText(
      'const password = "hunter2hunter2";\nif (a == b) console.log("hi");\n',
      'javascript',
      RULE_PACKS,
      options,
    );
    const ids = findings.map((finding) => finding.rule.id);
    expect(ids).toContain('scan-any-generic-secret');
    expect(ids).toContain('scan-js-loose-equality');
    expect(ids).toContain('scan-js-console-log');
  });
});
