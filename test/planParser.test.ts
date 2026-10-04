import { describe, expect, it } from 'vitest';
import {
  parsePlanFromText,
  planFromObject,
  planFromText,
  planFromToolCall,
  planToText,
} from '../src/planner/planParser';
import { buildPlannerSystemPrompt } from '../src/planner/prompts';

describe('planFromObject', () => {
  it('parses a full plan', () => {
    const plan = planFromObject(
      {
        what: 'Add a login page',
        how: 'Page calls AuthService',
        flow: 'graph TD\n  A[Login] --> B[Auth]',
        why: 'Keeps UI separate',
        tradeoff: 'More layers',
        steps: ['Create page', 'Wire auth'],
      },
      1,
    );
    expect(plan).toBeDefined();
    expect(plan?.version).toBe(1);
    expect(plan?.status).toBe('draft');
    expect(plan?.what).toBe('Add a login page');
    expect(plan?.flow).toBe('graph TD\n  A[Login] --> B[Auth]');
    expect(plan?.steps).toEqual(['Create page', 'Wire auth']);
  });

  it('parses a minimal plan with only steps', () => {
    const plan = planFromObject({ steps: ['Rename userName to username in UserService.ts'] }, 2);
    expect(plan).toBeDefined();
    expect(plan?.steps).toEqual(['Rename userName to username in UserService.ts']);
    expect(plan?.what).toBeUndefined();
    expect(plan?.why).toBeUndefined();
    expect(plan?.title).toBe('Rename userName to username in UserService.ts');
  });

  it('accepts alternate key names and case', () => {
    const plan = planFromObject({ What: 'Do X', PLAN: ['one', 'two'], Flow: 'A -> B' }, 1);
    expect(plan?.what).toBe('Do X');
    expect(plan?.steps).toEqual(['one', 'two']);
    expect(plan?.flow).toBe('A -> B');
  });

  it('accepts legacy diagram keys', () => {
    const plan = planFromObject({ howDiagram: 'graph TD' }, 1);
    expect(plan?.flow).toBe('graph TD');
  });

  it('splits steps given as a string', () => {
    const plan = planFromObject({ steps: '- first\n- second\n3. third' }, 1);
    expect(plan?.steps).toEqual(['first', 'second', 'third']);
  });

  it('accepts step objects', () => {
    const plan = planFromObject({ steps: [{ step: 'one' }, { text: 'two' }] }, 1);
    expect(plan?.steps).toEqual(['one', 'two']);
  });

  it('returns undefined for empty payloads', () => {
    expect(planFromObject({}, 1)).toBeUndefined();
    expect(planFromObject(null, 1)).toBeUndefined();
    expect(planFromObject('nope', 1)).toBeUndefined();
  });

  it('parses an explanation intent with context and no steps', () => {
    const plan = planFromObject(
      {
        intent: 'explanation',
        what: 'Sessions are JWT-based.',
        how: 'Login signs a token; middleware verifies it.',
        context: [
          { path: 'auth/service.ts', role: 'credential check and token signing' },
          { path: 'middleware/requireAuth.ts', role: 'verification' },
        ],
      },
      1,
    );
    expect(plan?.intent).toBe('explanation');
    expect(plan?.steps).toBeUndefined();
    expect(plan?.context).toHaveLength(2);
    expect(plan?.context?.[0].role).toContain('credential check');
  });

  it('parses a plan intent with context entries as strings', () => {
    const plan = planFromObject(
      {
        intent: 'plan',
        steps: ['Add middleware'],
        context: ['lib/redis.ts — existing client'],
      },
      1,
    );
    expect(plan?.intent).toBe('plan');
    expect(plan?.context?.[0]).toEqual({ path: 'lib/redis.ts', role: 'existing client' });
  });

  it('parses source ranges from structured plan context', () => {
    const plan = planFromObject(
      {
        steps: ['Add the endpoint'],
        context: [{ path: 'src/routes/health.ts', role: 'registers the route', startLine: 12, endLine: 24 }],
      },
      1,
    );
    expect(plan?.context?.[0]).toEqual({
      path: 'src/routes/health.ts',
      role: 'registers the route',
      startLine: 12,
      endLine: 24,
    });
  });

  it('infers explanation when there are no steps', () => {
    const plan = planFromObject({ what: 'just an answer' }, 1);
    expect(plan?.intent).toBe('explanation');
  });

  it('parses learning fields and caps risks at two', () => {
    const plan = planFromObject(
      {
        what: 'Add a queue',
        concept: 'separation of concerns — the producer only enqueues',
        risks: ['a lost job on crash', 'a duplicated job on retry', 'a slow consumer'],
        'why not': 'inlining the work couples the request path to the job',
      },
      1,
    );
    expect(plan?.concept).toBe('separation of concerns — the producer only enqueues');
    expect(plan?.risks).toEqual(['a lost job on crash', 'a duplicated job on retry']);
    expect(plan?.whyNot).toBe('inlining the work couples the request path to the job');
  });

  it('accepts risks as a bulleted string', () => {
    const plan = planFromObject({ what: 'W', risks: '- one\n- two\n- three' }, 1);
    expect(plan?.risks).toEqual(['one', 'two']);
  });

  it('omits learning fields when absent', () => {
    const plan = planFromObject({ steps: ['one'] }, 1);
    expect(plan?.concept).toBeUndefined();
    expect(plan?.risks).toBeUndefined();
    expect(plan?.whyNot).toBeUndefined();
  });

  it('parses why, tradeoff, and leaveAsIs', () => {
    const plan = planFromObject(
      {
        intent: 'explanation',
        what: 'Sessions are JWT-based.',
        how: 'Login signs a token; middleware verifies it.',
        why: 'Stateless tokens avoid a session store across pods.',
        tradeoff: 'Revocation is harder; a denylist adds state.',
        leaveAsIs: 'the duplicated header parsing — extracting it now adds indirection for two call sites',
      },
      1,
    );
    expect(plan?.why).toBe('Stateless tokens avoid a session store across pods.');
    expect(plan?.tradeoff).toBe('Revocation is harder; a denylist adds state.');
    expect(plan?.leaveAsIs).toBe(
      'the duplicated header parsing — extracting it now adds indirection for two call sites',
    );
  });

  it('omits why, tradeoff, and leaveAsIs when absent', () => {
    const plan = planFromObject({ steps: ['one'] }, 1);
    expect(plan?.why).toBeUndefined();
    expect(plan?.tradeoff).toBeUndefined();
    expect(plan?.leaveAsIs).toBeUndefined();
  });

  it('keeps a plan that only carries leaveAsIs', () => {
    const plan = planFromObject({ leaveAsIs: 'the helper — fine as is' }, 1);
    expect(plan?.leaveAsIs).toBe('the helper — fine as is');
  });
});

describe('parsePlanFromText', () => {
  it('parses fenced json from model text', () => {
    const plan = parsePlanFromText('```json\n{"what":"X","steps":["a"]}\n```', 3);
    expect(plan?.version).toBe(3);
    expect(plan?.what).toBe('X');
  });

  it('returns undefined for prose', () => {
    expect(parsePlanFromText('Should I use OAuth or email login?', 1)).toBeUndefined();
  });
});

describe('planFromToolCall', () => {
  it('parses tool arguments', () => {
    const plan = planFromToolCall(JSON.stringify({ steps: ['a'], what: 'w' }), 5);
    expect(plan?.version).toBe(5);
    expect(plan?.steps).toEqual(['a']);
  });

  it('returns undefined for invalid json', () => {
    expect(planFromToolCall('{broken', 1)).toBeUndefined();
  });
});

describe('planToText', () => {
  it('renders only present sections', () => {
    const text = planToText({ version: 1, status: 'draft', steps: ['one'] });
    expect(text).toBe('PLAN:\n1. one');
  });

  it('renders all sections in order', () => {
    const text = planToText({
      version: 1,
      status: 'draft',
      what: 'W',
      how: 'H',
      flow: 'A -> B',
      why: 'Y',
      tradeoff: 'T',
      steps: ['s1'],
    });
    expect(text).toBe('WHAT: W\nHOW: H\nFLOW: A -> B\nWHY: Y\nTRADEOFF: T\nPLAN:\n1. s1');
  });

  it('renders the context section', () => {
    const text = planToText({
      version: 1,
      status: 'draft',
      what: 'W',
      context: [{ path: 'a.ts', role: 'does a thing' }],
      steps: ['s1'],
    });
    expect(text).toContain('CONTEXT:\n- a.ts — does a thing');
  });

  it('round-trips context source ranges', () => {
    const parsed = planFromText(
      planToText({
        version: 1,
        status: 'draft',
        context: [{ path: 'src/routes/health.ts', role: 'registers the route', startLine: 12, endLine: 24 }],
      }),
      1,
    );
    expect(parsed?.context?.[0]).toEqual({
      path: 'src/routes/health.ts',
      role: 'registers the route',
      startLine: 12,
      endLine: 24,
    });
  });

  it('renders the learning sections', () => {
    const text = planToText({
      version: 1,
      status: 'draft',
      concept: 'C',
      risks: ['r1', 'r2'],
      whyNot: 'N',
      steps: ['s1'],
    });
    expect(text).toBe('CONCEPT: C\nRISKS:\n- r1\n- r2\nWHY NOT: N\nPLAN:\n1. s1');
  });

  it('round-trips concept, risks, and whyNot', () => {
    const parsed = planFromText(
      planToText({
        version: 1,
        status: 'draft',
        what: 'W',
        concept: 'separation of concerns',
        risks: ['a race on reconnect', 'a stale cache entry'],
        whyNot: 'inlining is simpler but couples the layers',
        steps: ['s1'],
      }),
      4,
    );
    expect(parsed?.concept).toBe('separation of concerns');
    expect(parsed?.risks).toEqual(['a race on reconnect', 'a stale cache entry']);
    expect(parsed?.whyNot).toBe('inlining is simpler but couples the layers');
    expect(parsed?.steps).toEqual(['s1']);
  });

  it('round-trips plans without learning fields', () => {
    const parsed = planFromText(
      planToText({ version: 1, status: 'draft', what: 'W', steps: ['s1'] }),
      1,
    );
    expect(parsed?.concept).toBeUndefined();
    expect(parsed?.risks).toBeUndefined();
    expect(parsed?.whyNot).toBeUndefined();
  });

  it('round-trips why, tradeoff, and leaveAsIs', () => {
    const parsed = planFromText(
      planToText({
        version: 1,
        status: 'draft',
        what: 'W',
        how: 'H',
        why: 'Y',
        tradeoff: 'T',
        leaveAsIs: 'L',
        steps: ['s1'],
      }),
      4,
    );
    expect(parsed?.why).toBe('Y');
    expect(parsed?.tradeoff).toBe('T');
    expect(parsed?.leaveAsIs).toBe('L');
    expect(parsed?.steps).toEqual(['s1']);
  });

  it('round-trips plans without why, tradeoff, or leaveAsIs', () => {
    const parsed = planFromText(
      planToText({ version: 1, status: 'draft', what: 'W', how: 'H', steps: ['s1'] }),
      1,
    );
    expect(parsed?.why).toBeUndefined();
    expect(parsed?.tradeoff).toBeUndefined();
    expect(parsed?.leaveAsIs).toBeUndefined();
  });

  it('round-trips the convention note', () => {
    const parsed = planFromText(
      planToText({
        version: 1,
        status: 'draft',
        what: 'W',
        convention: 'follows the handler-layer auth convention',
        steps: ['s1'],
      }),
      4,
    );
    expect(parsed?.convention).toBe('follows the handler-layer auth convention');
  });
});

describe('planner prompt learning fields', () => {
  it('asks for concept, risks, and whyNot on meaningful decisions', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('concept');
    expect(prompt).toContain('risks');
    expect(prompt).toContain('whyNot');
    expect(prompt).toContain('omit all three when the task is trivial');
  });

  it('keeps explanations structured only when useful and tradeoffs unforced', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('Investigate as far as the answer needs');
    expect(prompt).toContain('only where they genuinely make it clearer');
    expect(prompt).not.toContain('WHAT → HOW → WHY');
    expect(prompt).not.toContain('with WHAT, HOW, and WHY headings');
  });

  it('asks for restraint via leaveAsIs', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('leaveAsIs');
    expect(prompt).toContain('NOT worth doing now');
  });

  it('asks for code-backed explanations and context for approval plans', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('A draft plan is both an execution specification and an explanation for the developer');
    expect(prompt).toContain('do not omit HOW when the change crosses files, layers, or responsibilities');
    expect(prompt).toContain('Context is evidence for the explanation');
    expect(prompt).toContain('Do not create an approval plan from an unverified assumption');
  });

  it('points the planner at stored conventions and project-wide explanations', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('## Conventions');
    expect(prompt).toContain('convention field on submit_plan');
    expect(prompt).toContain('semantic_search and the cross-file index');
  });
});
