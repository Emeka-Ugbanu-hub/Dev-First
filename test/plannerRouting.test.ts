import { describe, expect, it } from 'vitest';
import { buildPlannerContext, buildPlannerSystemPrompt } from '../src/planner/prompts';
import { dismissPlanTool, plannerToolSet } from '../src/agent/tools';
import type { Plan } from '../src/shared/protocol';

function draftPlan(): Plan {
  return {
    version: 1,
    status: 'draft',
    intent: 'plan',
    what: 'Add retry handling',
    steps: ['Add a retry helper', 'Drop the legacy poller', 'Wire retries into the client'],
    skippedSteps: [1],
  };
}

describe('planner routing decision table', () => {
  it('documents the response policy and one rule per route', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('Answer questions in chat');
    expect(prompt).toContain('## Response policy');
    expect(prompt).toContain(
      'Respond to the latest user message; use earlier messages only when they help answer it or it refers to earlier work.',
    );
    expect(prompt).toContain('Match investigation, tool use, and answer detail to the request.');
    expect(prompt).toContain('Answer simple questions directly.');
    expect(prompt).toContain('Read files or inspect related code when the answer depends on them.');
    expect(prompt).toContain('For requested code changes, make a plan for approval.');
    expect(prompt).toContain(
      'prefer the shortest answer that gives a complete understanding — never drop a section the developer needs just to keep it short.',
    );
    expect(prompt).toContain(
      'Never resume or combine an earlier task unless the latest user message refers to it or needs that context to answer accurately.',
    );
    expect(prompt).toContain('Keep the selected provider, model, and reasoning setting unchanged.');
    expect(prompt).toContain('do not invent work because the selected reasoning setting is high');
    expect(prompt).toContain('| Route | Trigger | Response |');
    expect(prompt).toContain('smalltalk');
    expect(prompt).toContain('question-simple');
    expect(prompt).toContain('question-deep');
    expect(prompt).toContain('plan-refine');
    expect(prompt).toContain('change-new');
    expect(prompt).toContain('Reply in one short, natural sentence');
    expect(prompt).toContain('Call submit_plan with the FULL updated plan');
    expect(prompt).toContain('preserving untouched steps, their order, and skipped/excluded state');
    expect(prompt).toMatch(/never call submit_plan/i);
    expect(prompt).toContain('Discussion stays discussion; questions never call submit_plan.');
    expect(prompt).toContain('When no draft is provided, the message is a question or new work');
    expect(prompt).toContain('If a greeting also includes a question or task, handle that request');
    expect(prompt).not.toContain('## Handle the latest request');
    expect(prompt).not.toContain('## Active turn and conversation context');
    expect(prompt).not.toContain('Do not make a separate hidden routing call');
    expect(prompt).not.toContain('Start reasoning about the request immediately');
  });

  it('keeps code explanations focused and uses tools only when the answer needs them', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('use a supplied snippet when it is sufficient');
    expect(prompt).toContain('inspect callers or related files only when the question depends on them');
    expect(prompt).toContain('a design question may need WHY alone');
    expect(prompt).toContain('never omit a needed part');
    expect(prompt).toContain('Do not add diagrams or key-file lists unless they materially help');
    expect(prompt).toContain('expand the previous answer with the missing parts');
    expect(prompt).not.toMatch(/Question-deep answers use WHAT \/ HOW \/ WHY/);
    expect(prompt).not.toMatch(/include a Mermaid flow/);
  });

  it('routes plan cancellation to dismiss_plan', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('plan-cancel');
    expect(prompt).toContain('cancel the plan');
    expect(prompt).toContain('forget the draft');
    expect(prompt).toContain('never mind the plan');
    expect(prompt).toMatch(/Call dismiss_plan with no arguments/);
    expect(prompt).toMatch(/Do NOT call submit_plan and do NOT answer about the plan/);
  });

  it('exposes dismiss_plan in the planner tool set', () => {
    const names = plannerToolSet([]).map((tool) => tool.name);
    expect(names).toContain('submit_plan');
    expect(names).toContain('dismiss_plan');
    expect(dismissPlanTool.parameters.type).toBe('object');
  });

  it('does not tell the planner to submit explanations', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).not.toContain('## Questions vs tasks');
    expect(prompt).not.toContain('If the developer asks a QUESTION');
    expect(prompt).not.toMatch(/submit_plan with intent ["'`]?explanation/i);
    expect(prompt).not.toMatch(/ask(?:s|ed)? a question[^.]*submit_plan/i);
    expect(prompt).not.toContain('intent "explanation"');
  });

  it('handles plan cancellation in the same response turn', () => {
    expect(buildPlannerSystemPrompt()).toContain('Use dismiss_plan only when an open draft exists');
  });
});

describe('planner read-only tool access and status messaging', () => {
  it('advertises list_processes and planner-safe terminal checks', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('list_processes');
    expect(prompt).toContain('run_terminal_command');
    expect(prompt).toContain('safe read-only checks only');
    expect(prompt).toContain('ps, lsof, lsappinfo, netstat');
  });

  it('forbids claiming a general inability to execute', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('NEVER claim a general inability to execute');
    expect(prompt).toContain('never say you can only read files');
    expect(prompt).toContain('lsof -nP -iTCP:<port>');
    expect(prompt).toContain('answer from list_processes');
  });
});

describe('draft context injection', () => {
  it('clearly scopes draft context to an explicit reference in the latest message', () => {
    const context = buildPlannerContext(draftPlan());
    expect(context).toContain("relevant ONLY if the developer's latest message explicitly refers to refining or extending this draft");
    expect(context).toContain('Do not continue an unfinished task just because a draft exists');
    expect(context).toMatch(/smalltalk, a question, or an unrelated new task/);
    expect(context).toMatch(/ignore this section completely and never mention it/);
  });

  it('includes the excluded steps under the same scoping', () => {
    const context = buildPlannerContext(draftPlan());
    expect(context).toContain('Steps the developer intentionally excluded');
    expect(context).toContain('Drop the legacy poller');
  });

  it('omits the draft when there is no draft', () => {
    expect(buildPlannerContext(null)).toBeUndefined();
  });

  it('does not pass an approved plan as an open draft', () => {
    expect(buildPlannerContext({ ...draftPlan(), status: 'approved' })).toBeUndefined();
  });
});
