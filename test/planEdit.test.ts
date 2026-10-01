import { describe, expect, it } from 'vitest';
import { planFromText, planSlug, planToText } from '../src/planner/planParser';
import { buildExecutorSpec } from '../src/planner/prompts';

const fullPlan = {
  version: 1,
  status: 'draft' as const,
  intent: 'plan' as const,
  title: 'Rate limiting',
  what: 'Limit each IP.',
  how: 'Redis INCR middleware.',
  flow: 'graph TD\n  A --> B',
  why: 'Reuses existing infra.',
  tradeoff: 'In-memory is faster; Redis costs a dependency but is correct across pods.',
  context: [{ path: 'lib/redis.ts', role: 'existing client' }],
  steps: ['Add middleware', 'Register in app.ts'],
};

describe('planFromText round trip', () => {
  it('parses what planToText produced', () => {
    const parsed = planFromText(planToText(fullPlan), 2);
    expect(parsed).toBeDefined();
    expect(parsed?.version).toBe(2);
    expect(parsed?.intent).toBe('plan');
    expect(parsed?.what).toBe('Limit each IP.');
    expect(parsed?.flow).toBe('graph TD\n  A --> B');
    expect(parsed?.context).toEqual([{ path: 'lib/redis.ts', role: 'existing client' }]);
    expect(parsed?.steps).toEqual(['Add middleware', 'Register in app.ts']);
  });

  it('returns undefined for empty input', () => {
    expect(planFromText('nothing here', 1)).toBeUndefined();
  });

  it('detects explanation when there are no steps', () => {
    const parsed = planFromText('WHAT: it is JWT based\nHOW: middleware verifies', 1);
    expect(parsed?.intent).toBe('explanation');
    expect(parsed?.steps).toBeUndefined();
  });
});

describe('planSlug', () => {
  it('slugifies the title', () => {
    expect(planSlug(fullPlan, 'fallback')).toBe('rate-limiting');
  });

  it('falls back to what, then the request', () => {
    expect(planSlug({ ...fullPlan, title: undefined }, 'fallback')).toBe('limit-each-ip');
    expect(planSlug({ version: 1, status: 'draft' }, 'Add OAuth Login!')).toBe('add-oauth-login');
  });
});

describe('buildExecutorSpec', () => {
  it('excludes skipped steps and lists them', () => {
    const spec = buildExecutorSpec('add rate limiting', { ...fullPlan, skippedSteps: [1] }, '.dev-first/plans/p.md');
    expect(spec).toContain('1. Add middleware');
    expect(spec).not.toContain('1. Add middleware\n2.');
    expect(spec).toContain('do NOT do them');
    expect(spec).toContain('Register in app.ts');
    expect(spec).toContain('Plan file: .dev-first/plans/p.md');
  });

  it('includes all steps when nothing is skipped', () => {
    const spec = buildExecutorSpec('x', fullPlan);
    expect(spec).toContain('1. Add middleware');
    expect(spec).toContain('2. Register in app.ts');
    expect(spec).not.toContain('do NOT do them');
  });
});
