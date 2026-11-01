import { describe, expect, it } from 'vitest';
import {
  checkPlanReadiness,
  readinessCorrection,
  readinessFieldLabel,
} from '../src/planner/planReadiness';
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

  it('treats explanations as answers, not execution contracts', () => {
    const plan: Plan = { version: 1, status: 'draft', intent: 'explanation', what: 'Sessions are JWT-based.' };
    expect(checkPlanReadiness(plan)).toEqual({ ready: true, missing: [] });
  });

  it('lists every missing field for an under-specified spec plan', () => {
    const plan: Plan = { version: 1, status: 'draft', intent: 'plan', steps: ['Do it'] };
    const result = checkPlanReadiness(plan);
    expect(result.ready).toBe(false);
    expect(result.missing).toEqual([
      'scope',
      'expectedFiles',
      'dependencies',
      'assumptions',
      'verification',
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
    expect(result.missing).toEqual(['scope', 'steps', 'dependencies', 'verification']);
  });

  it('requires expectedFiles to be present even when empty', () => {
    const plan: Plan = { ...complete };
    delete plan.expectedFiles;
    expect(checkPlanReadiness(plan).missing).toContain('expectedFiles');
  });

  it('requires only scope, steps, and expectedFiles for lite plans', () => {
    const plan: Plan = {
      version: 1,
      status: 'draft',
      intent: 'plan',
      planningMode: 'lite',
      what: 'Rename the flag',
      steps: ['Rename the flag in src/a.ts'],
      expectedFiles: [{ path: 'src/a.ts', action: 'modify', reason: 'Rename it' }],
    };
    expect(checkPlanReadiness(plan)).toEqual({ ready: true, missing: [] });

    const withoutFiles: Plan = { ...plan };
    delete withoutFiles.expectedFiles;
    expect(checkPlanReadiness(withoutFiles)).toEqual({ ready: false, missing: ['expectedFiles'] });
  });

  it('applies the spec contract to full plans and to plans without a mode', () => {
    const full: Plan = { ...complete, planningMode: 'full', risks: ['A concrete failure mode'] };
    delete full.verification;
    expect(checkPlanReadiness(full)).toEqual({ ready: false, missing: ['verification'] });

    const noMode: Plan = { ...complete };
    delete noMode.planningMode;
    delete noMode.dependencies;
    expect(checkPlanReadiness(noMode)).toEqual({ ready: false, missing: ['dependencies'] });
  });

  it('requires at least one risk for full plans, but not for spec', () => {
    const full: Plan = { ...complete, planningMode: 'full' };
    expect(checkPlanReadiness(full)).toEqual({ ready: false, missing: ['risks'] });
    const withRisks: Plan = { ...complete, planningMode: 'full', risks: ['A stale cache after an external edit'] };
    expect(checkPlanReadiness(withRisks)).toEqual({ ready: true, missing: [] });
    expect(checkPlanReadiness({ ...complete, planningMode: 'spec' })).toEqual({ ready: true, missing: [] });
  });

  it('builds a correction example containing only the missing fields', () => {
    expect(readinessCorrection(['verification'])).toBe('{"verification": ["Run the relevant tests"]}');
    expect(readinessCorrection(['expectedFiles', 'verification'])).toContain('"expectedFiles"');
    expect(readinessFieldLabel('expectedFiles')).toContain('expectedFiles');
  });
});
