import { describe, expect, it } from 'vitest';
import { checkPlanReadiness } from '../src/planner/planReadiness';
import type { Plan } from '../src/shared/protocol';

const complete: Plan = {
  version: 1,
  status: 'draft',
  intent: 'plan',
  what: 'Add a health endpoint',
  steps: ['Add the handler'],
  expectedFiles: [],
  dependencies: 'none',
  assumptions: 'none',
  verification: ['none'],
};

describe('checkPlanReadiness', () => {
  it('accepts a plan with the full execution contract', () => {
    expect(checkPlanReadiness(complete)).toEqual({ ready: true, missing: [] });
  });

  it('accepts an explicitly trivial plan without extra fields', () => {
    const plan: Plan = { version: 1, status: 'draft', intent: 'plan', trivial: true, steps: ['Do it'] };
    expect(checkPlanReadiness(plan).ready).toBe(true);
  });

  it('lists every missing field for an under-specified plan', () => {
    const plan: Plan = { version: 1, status: 'draft', intent: 'plan', steps: ['Do it'] };
    const result = checkPlanReadiness(plan);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      'scope (what)',
      'expected files (use [] when no files change)',
      'dependencies (use "none" when there are none)',
      'assumptions (use "none" when there are none)',
      'verification steps (use ["none"] when none apply)',
    ]);
  });

  it('treats blank strings and empty step lists as missing', () => {
    const plan: Plan = {
      ...complete,
      what: '   ',
      steps: ['  '],
      dependencies: '',
      verification: [''],
    };
    const result = checkPlanReadiness(plan);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual(['scope (what)', 'concrete steps', 'dependencies (use "none" when there are none)', 'verification steps (use ["none"] when none apply)']);
  });

  it('requires expectedFiles to be present even when empty', () => {
    const plan: Plan = { ...complete };
    delete plan.expectedFiles;
    expect(checkPlanReadiness(plan).missing).toContain('expected files (use [] when no files change)');
  });
});
