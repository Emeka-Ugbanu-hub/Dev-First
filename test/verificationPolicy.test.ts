import { describe, expect, it } from 'vitest';
import {
  DiagnosticsCache,
  RISK_FILE_PATTERNS,
  RISK_PATH_SEGMENTS,
  diagnosticsCacheKey,
  matchesRiskPath,
  planVerification,
} from '../src/agent/verificationPolicy';
import type { VerificationPolicyInput } from '../src/agent/verificationPolicy';

function input(overrides: Partial<VerificationPolicyInput> = {}): VerificationPolicyInput {
  return {
    changes: [],
    touchedSymbolsOrImports: false,
    diagnosticsErrors: 0,
    packageRootCount: 0,
    resolverConfident: true,
    ...overrides,
  };
}

function edit(path: string) {
  return { path, action: 'edit' as const };
}

describe('verification policy', () => {
  it('plans nothing when there are no changes', () => {
    const plan = planVerification(input());
    expect(plan).toEqual({ level: 0, reasons: [], checks: [] });
  });

  it('keeps a single clean file at level 1 with write, diagnostics, and diff', () => {
    const plan = planVerification(input({ changes: [edit('src/a.ts')] }));
    expect(plan.level).toBe(1);
    expect(plan.checks).toEqual(['write', 'diagnostics', 'diff']);
    expect(plan.reasons).toEqual([]);
    expect(plan.commandKind).toBeUndefined();
    expect(plan.needsInput).toBeUndefined();
  });

  it('omits diff for create-only change sets', () => {
    const plan = planVerification(input({ changes: [{ path: 'src/new.ts', action: 'create' }] }));
    expect(plan.level).toBe(1);
    expect(plan.checks).toEqual(['write', 'diagnostics']);
  });

  it('escalates two files to level 2 and adds references only when symbols or imports were touched', () => {
    const touched = planVerification(
      input({ changes: [edit('src/a.ts'), edit('src/b.ts')], touchedSymbolsOrImports: true }),
    );
    expect(touched.level).toBe(2);
    expect(touched.checks).toContain('related-diagnostics');
    expect(touched.checks).toContain('references');
    expect(touched.checks).toContain('closest-test');
    expect(touched.checks).toContain('package-typecheck');
    expect(touched.checks).not.toContain('project-command');
    expect(touched.reasons).toContain('touched symbols or imports');
    expect(touched.reasons).toContain('2 files changed');

    const untouched = planVerification(input({ changes: [edit('src/a.ts'), edit('src/b.ts')] }));
    expect(untouched.level).toBe(2);
    expect(untouched.checks).not.toContain('references');
  });

  it('escalates a single change inside one package root to level 2', () => {
    const plan = planVerification(input({ changes: [edit('src/a.ts')], packageRootCount: 1 }));
    expect(plan.level).toBe(2);
    expect(plan.reasons).toContain('all changes within one package root');
  });

  it('escalates five files to level 3 with the project command', () => {
    const changes = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(edit);
    const plan = planVerification(input({ changes }));
    expect(plan.level).toBe(3);
    expect(plan.checks).toContain('project-command');
    expect(plan.commandKind).toBe('test');
    expect(plan.reasons).toContain('5 files changed');
    expect(plan.needsInput).toBeUndefined();
  });

  it.each([
    'src/auth/session.ts',
    'src/db/migrations/001_init.sql',
    '.env',
    'config/.env.production',
    'package.json',
    'tsconfig.base.json',
    'vite.config.ts',
    'src/api/routes/users.ts',
  ])('treats %s as a risk path', (path) => {
    expect(matchesRiskPath(path)).toBe(true);
    const plan = planVerification(input({ changes: [edit(path)] }));
    expect(plan.level).toBe(3);
    expect(plan.reasons.some((reason) => reason.startsWith('risk path:'))).toBe(true);
  });

  it('does not flag ordinary paths as risky', () => {
    expect(matchesRiskPath('src/components/Button.tsx')).toBe(false);
    expect(matchesRiskPath('docs/readme.md')).toBe(false);
    expect(RISK_PATH_SEGMENTS.has('components')).toBe(false);
    expect(RISK_FILE_PATTERNS.some((pattern) => pattern.test('Button.tsx'))).toBe(false);
  });

  it('escalates cross-package changes to level 3', () => {
    const plan = planVerification(input({ changes: [edit('packages/a/src/a.ts')], packageRootCount: 2 }));
    expect(plan.level).toBe(3);
    expect(plan.reasons).toContain('2 package roots');
  });

  it('raises the level only when planRequiresCheck is explicit', () => {
    const explicit = planVerification(input({ changes: [edit('src/a.ts')], planRequiresCheck: 'test' }));
    expect(explicit.level).toBe(3);
    expect(explicit.commandKind).toBe('test');
    expect(explicit.reasons).toContain('plan requires test check');

    const generic = planVerification(input({ changes: [edit('src/a.ts')] }));
    expect(generic.level).toBe(1);
    expect(generic.reasons).toEqual([]);
  });

  it('asks for input when level 3 has no confident resolver', () => {
    const changes = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(edit);
    const plan = planVerification(input({ changes, resolverConfident: false }));
    expect(plan.level).toBe(3);
    expect(plan.needsInput).toBe(true);
    expect(plan.reasons).toContain('no confident project command');
  });

  it('escalates after a prior check failure', () => {
    const plan = planVerification(input({ changes: [edit('src/a.ts')], priorCheckFailed: true }));
    expect(plan.level).toBe(3);
    expect(plan.reasons).toContain('previous check failed');
  });
});

describe('diagnostics cache', () => {
  it('keys entries by uri and content hash', () => {
    expect(diagnosticsCacheKey('/tmp/a.ts', 'const a = 1;\n')).toMatch(/^\/tmp\/a\.ts\|[0-9a-f]+$/);
    expect(diagnosticsCacheKey('/tmp/a.ts', 'const a = 1;\n')).not.toBe(
      diagnosticsCacheKey('/tmp/a.ts', 'const a = 2;\n'),
    );
    expect(diagnosticsCacheKey('/tmp/a.ts', 'const a = 1;\n')).not.toBe(
      diagnosticsCacheKey('/tmp/b.ts', 'const a = 1;\n'),
    );
  });

  it('returns cached diagnostics only for unchanged content', () => {
    const cache = new DiagnosticsCache();
    const diagnostic = { path: 'a.ts', absolute: '/tmp/a.ts', line: 1, character: 1, severity: 'error' as const, message: 'x' };
    expect(cache.get('/tmp/a.ts', 'const a = 1;\n')).toBeUndefined();
    cache.set('/tmp/a.ts', 'const a = 1;\n', [diagnostic]);
    expect(cache.get('/tmp/a.ts', 'const a = 1;\n')).toEqual([diagnostic]);
    expect(cache.get('/tmp/a.ts', 'const a = 2;\n')).toBeUndefined();
    cache.clear();
    expect(cache.get('/tmp/a.ts', 'const a = 1;\n')).toBeUndefined();
  });
});
