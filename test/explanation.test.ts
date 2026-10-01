import { describe, expect, it } from 'vitest';
import type { Plan } from '../src/shared/protocol';
import { explanationToMarkdown, isExplanationPlan } from '../src/planner/explanation';

describe('isExplanationPlan', () => {
  it('treats the explanation intent as an explanation', () => {
    expect(isExplanationPlan({ version: 1, status: 'draft', intent: 'explanation', what: 'x' })).toBe(true);
  });

  it('treats a plan without steps as an explanation', () => {
    expect(isExplanationPlan({ version: 1, status: 'draft', intent: 'plan', what: 'x' })).toBe(true);
    expect(isExplanationPlan({ version: 1, status: 'draft', what: 'x' })).toBe(true);
  });

  it('keeps plans with steps as plans', () => {
    expect(isExplanationPlan({ version: 1, status: 'draft', intent: 'plan', steps: ['do it'] })).toBe(false);
  });
});

describe('explanationToMarkdown', () => {
  const plan: Plan = {
    version: 1,
    status: 'draft',
    intent: 'explanation',
    what: 'Auth is JWT based.',
    how: 'The API signs a token; middleware verifies it.',
    flow: 'graph TD\n  A[Login] --> B[JWT]',
    why: 'Stateless tokens avoid a session store.',
    tradeoff: 'Revocation is harder; a denylist adds state.',
    context: [{ path: 'src/auth.ts', role: 'verifies credentials' }],
  };

  it('builds one markdown answer with section headings, the flow, and the files', () => {
    const markdown = explanationToMarkdown(plan);
    expect(markdown).toContain('## WHAT\n\nAuth is JWT based.');
    expect(markdown).toContain('## HOW\n\nThe API signs a token; middleware verifies it.');
    expect(markdown).toContain('## WHY\n\nStateless tokens avoid a session store.');
    expect(markdown).toContain('## TRADEOFF\n\nRevocation is harder; a denylist adds state.');
    expect(markdown).toContain('```mermaid\ngraph TD\n  A[Login] --> B[JWT]\n```');
    expect(markdown).toContain('- `src/auth.ts` — verifies credentials');
  });

  it('omits what is absent and stays empty for an empty plan', () => {
    const minimal = explanationToMarkdown({ version: 1, status: 'draft', what: 'Just the answer.' });
    expect(minimal).toBe('## WHAT\n\nJust the answer.');
    expect(explanationToMarkdown({ version: 1, status: 'draft', leaveAsIs: 'the parser' })).toBe('');
  });
});
