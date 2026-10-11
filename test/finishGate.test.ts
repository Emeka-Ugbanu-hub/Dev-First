import { describe, expect, it } from 'vitest';
import { checkFinish } from '../src/agent/finishGate';
import type { FinishGateInput } from '../src/agent/finishGate';

function input(overrides: Partial<FinishGateInput> = {}): FinishGateInput {
  return {
    planSteps: ['Do the thing'],
    completedSteps: [0],
    skippedSteps: [],
    todos: [],
    expectedFiles: [],
    changedFiles: [],
    recentToolFailures: [],
    newDiagnosticErrors: 0,
    diagnosticsAvailable: true,
    verificationRan: [],
    ...overrides,
  };
}

function issuesOf(overrides: Partial<FinishGateInput> = {}): string[] {
  const result = checkFinish(input(overrides));
  return result.ok ? [] : result.issues;
}

function compactOf(overrides: Partial<FinishGateInput> = {}): string {
  const result = checkFinish(input(overrides));
  if (result.ok) {
    throw new Error('expected the gate to report issues');
  }
  return result.compact;
}

describe('checkFinish steps', () => {
  it('is ok only when there are no issues', () => {
    expect(checkFinish(input())).toEqual({ ok: true });
  });

  it('flags an unfinished plan step', () => {
    const issues = issuesOf({ planSteps: ['First', 'Second'], completedSteps: [0] });
    expect(issues).toEqual(['unfinished step: "Second"']);
  });

  it('does not flag skipped steps and surfaces a recorded reason in the summary', () => {
    expect(
      checkFinish(
        input({ planSteps: ['First', 'Second'], completedSteps: [0], skippedSteps: [1] }),
      ),
    ).toEqual({ ok: true });
    const compact = compactOf({
      planSteps: ['First', 'Second'],
      completedSteps: [0],
      skippedSteps: [1],
      skippedReasons: { 1: 'not needed' },
      expectedFiles: [{ path: 'a.ts', action: 'modify' }],
    });
    expect(compact).toContain('Skipped: "Second" (reason: not needed)');
  });

  it('flags an in-progress todo and names it in the compact', () => {
    const issues = issuesOf({
      todos: [{ text: 'Write the helper', status: 'in_progress' }],
    });
    expect(issues).toEqual(['step still in progress: "Write the helper"']);
    const compact = compactOf({
      todos: [{ text: 'Write the helper', status: 'in_progress' }],
    });
    expect(compact).toContain('Pending: none');
    expect(compact).toContain('Action required: finish step: "Write the helper"');
  });

  it('flags pending todos that match a plan step, deduped against the step issue', () => {
    const overrides = {
      planSteps: ['Do the thing'],
      completedSteps: [],
      todos: [{ text: 'Do the thing', status: 'pending' as const }],
    };
    const issues = issuesOf(overrides);
    expect(issues).toEqual(['unfinished step: "Do the thing"']);
    const compact = compactOf(overrides);
    expect(compact).toContain('Pending: Do the thing');
    expect(compact).toContain('Action required: finish step: "Do the thing"');
  });
});

describe('checkFinish expected files', () => {
  it('flags a missing expected file', () => {
    const issues = issuesOf({ expectedFiles: [{ path: 'src/a.ts', action: 'modify' }] });
    expect(issues).toEqual(['expected file not changed: src/a.ts']);
  });

  it('flags a reverted modification', () => {
    const issues = issuesOf({
      expectedFiles: [{ path: 'src/a.ts', action: 'modify' }],
      changedFiles: [{ path: 'src/a.ts', delivered: false }],
    });
    expect(issues).toEqual(['expected file not changed: src/a.ts (reverted)']);
    const compact = compactOf({
      expectedFiles: [{ path: 'src/a.ts', action: 'modify' }],
      changedFiles: [{ path: 'src/a.ts', delivered: false }],
    });
    expect(compact).toContain('Changed files: 0 (delivered)');
    expect(compact).toContain('Action required: complete expected file: src/a.ts');
  });

  it('accepts delivered modifications, deletes, and added files', () => {
    expect(
      checkFinish(
        input({
          expectedFiles: [
            { path: 'src/a.ts', action: 'modify' },
            { path: 'src/old.ts', action: 'delete' },
            { path: 'src/new.ts', action: 'add' },
          ],
          changedFiles: [
            { path: 'src/a.ts', delivered: true },
            { path: 'src/old.ts', delivered: true },
            { path: 'src/new.ts', delivered: false },
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('flags a reverted delete', () => {
    const issues = issuesOf({
      expectedFiles: [{ path: 'src/old.ts', action: 'delete' }],
      changedFiles: [{ path: 'src/old.ts', delivered: false }],
    });
    expect(issues).toEqual(['expected file not changed: src/old.ts (reverted)']);
  });
});

describe('checkFinish tool failures and diagnostics', () => {
  it('caps recent tool failures at two', () => {
    const issues = issuesOf({
      recentToolFailures: ['edit_file: stale content', 'read_file: missing', 'run_terminal_command: exit 1'],
    });
    expect(issues).toEqual([
      'recent tool failure: edit_file: stale content',
      'recent tool failure: read_file: missing',
    ]);
  });

  it('flags new diagnostic errors when diagnostics are available', () => {
    expect(issuesOf({ newDiagnosticErrors: 3 })).toEqual(['3 new diagnostic errors']);
    expect(issuesOf({ newDiagnosticErrors: 1 })).toEqual(['1 new diagnostic error']);
    const compact = compactOf({ newDiagnosticErrors: 3 });
    expect(compact).toContain('Diagnostics: 3 new errors');
    expect(compact).toContain('Action required: fix 3 new diagnostic errors');
  });

  it('skips the diagnostics issue when diagnostics are unavailable', () => {
    expect(checkFinish(input({ diagnosticsAvailable: false, newDiagnosticErrors: 5 }))).toEqual({ ok: true });
    const compact = compactOf({
      diagnosticsAvailable: false,
      newDiagnosticErrors: 5,
      recentToolFailures: ['edit_file: stale content'],
    });
    expect(compact).toContain('Diagnostics: unavailable (no provider)');
    expect(compact).not.toContain('new diagnostic');
  });
});

describe('checkFinish verification', () => {
  it('is only enforced when a plan-required check is set', () => {
    expect(checkFinish(input({ verificationRan: [] }))).toEqual({ ok: true });
    expect(issuesOf({ planRequiredCheck: 'test' })).toEqual(['required verification not run: test']);
  });

  it('accepts a ran check and names the requirement in the compact', () => {
    expect(
      checkFinish(input({ planRequiredCheck: 'test', verificationRan: ['test:npm run test'] })),
    ).toEqual({ ok: true });
    const compact = compactOf({ planRequiredCheck: 'test', verificationRan: ['diagnostics'] });
    expect(compact).toContain('Verification: diagnostics · required: test');
    expect(compact).toContain('Action required: run the required test check');
  });
});

describe('checkFinish compact', () => {
  it('follows the exact line format', () => {
    const compact = compactOf({
      planSteps: ['First', 'Second'],
      completedSteps: [0],
      expectedFiles: [{ path: 'a.ts', action: 'modify' }],
      changedFiles: [{ path: 'a.ts', delivered: true }],
      newDiagnosticErrors: 2,
      verificationRan: ['diagnostics', 'test:npm run test'],
      planRequiredCheck: 'test',
    });
    const lines = compact.split('\n');
    expect(lines[0]).toBe('Finish check:');
    expect(lines[1]).toBe('Plan steps: 2 · Completed: 1 · Pending: Second');
    expect(lines[2]).toBe('Changed files: 1 (delivered)');
    expect(lines[3]).toBe('Diagnostics: 2 new errors');
    expect(lines[4]).toBe('Verification: diagnostics, test:npm run test · required: test');
    expect(lines[5]).toContain('Action required: ');
  });

  it('stays within eight lines', () => {
    const compact = compactOf({
      planSteps: ['First', 'Second'],
      completedSteps: [],
      skippedSteps: [1],
      skippedReasons: { 1: 'not needed' },
      todos: [
        { text: 'Write it', status: 'in_progress' },
        { text: 'First', status: 'pending' },
      ],
      expectedFiles: [{ path: 'a.ts', action: 'modify' }],
      recentToolFailures: ['edit_file: stale', 'read_file: missing', 'run_terminal_command: exit 1'],
      newDiagnosticErrors: 2,
      verificationRan: ['diagnostics'],
      planRequiredCheck: 'test',
    });
    expect(compact.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('uses the baseline-unavailable wording when sent explicitly', () => {
    const compact = compactOf({
      expectedFiles: [{ path: 'a.ts', action: 'modify' }],
      baselinesAvailable: false,
    });
    expect(compact).toContain('Changed files: 0 changed (baseline unavailable)');
  });
});

describe('checkFinish action priority', () => {
  it('orders unfinished step over expected file over failure over diagnostics over verification', () => {
    const base: Partial<FinishGateInput> = {
      planSteps: ['First', 'Second'],
      completedSteps: [0],
      expectedFiles: [{ path: 'a.ts', action: 'modify' }],
      recentToolFailures: ['edit_file: stale'],
      newDiagnosticErrors: 2,
      planRequiredCheck: 'test',
    };
    expect(compactOf(base)).toContain('Action required: finish step: "Second"');
    expect(compactOf({ ...base, planSteps: ['First'], completedSteps: [0] })).toContain(
      'Action required: complete expected file: a.ts',
    );
    expect(
      compactOf({ ...base, planSteps: ['First'], completedSteps: [0], expectedFiles: [] }),
    ).toContain('Action required: resolve recent tool failure: edit_file: stale');
    expect(
      compactOf({
        ...base,
        planSteps: ['First'],
        completedSteps: [0],
        expectedFiles: [],
        recentToolFailures: [],
      }),
    ).toContain('Action required: fix 2 new diagnostic errors');
    expect(
      compactOf({
        ...base,
        planSteps: ['First'],
        completedSteps: [0],
        expectedFiles: [],
        recentToolFailures: [],
        newDiagnosticErrors: 0,
      }),
    ).toContain('Action required: run the required test check');
  });
});
