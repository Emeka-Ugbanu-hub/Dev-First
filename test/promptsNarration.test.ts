import { describe, expect, it } from 'vitest';
import { buildExecutorSystemPrompt, buildPlannerSystemPrompt } from '../src/planner/prompts';

describe('executor narration prompt', () => {
  it('restricts interim chat text to real milestones', () => {
    const prompt = buildExecutorSystemPrompt();
    expect(prompt).toContain('ONLY at real milestones');
    expect(prompt).toContain('the start of plan execution (one line)');
    expect(prompt).toContain('a phase transition');
    expect(prompt).toContain('a blocker or when you need input');
    expect(prompt).toContain('longer than 30 seconds');
    expect(prompt).toContain('Never narrate individual tool calls');
  });

  it('lists every banned narration pattern', () => {
    const prompt = buildExecutorSystemPrompt();
    for (const banned of ["I'll start by", 'Now checking', 'Waiting on', 'Verifying', 'Polling', 'Let me']) {
      expect(prompt, `missing banned pattern: ${banned}`).toContain(banned);
    }
    expect(prompt).toContain('any recap that duplicates visible tool activity');
  });

  it('specifies paragraph, bullet, and concise-summary formatting', () => {
    const prompt = buildExecutorSystemPrompt();
    expect(prompt).toContain('one point = one short paragraph');
    expect(prompt).toContain('several distinct items = a bullet list');
    expect(prompt).toContain('No run-on play-by-play');
    expect(prompt).toContain('what changed, the verification result, at most 6 bullets total');
  });

  it('requires no interim prose for trivial direct runs', () => {
    const prompt = buildExecutorSystemPrompt();
    expect(prompt).toContain('trivial, single-step direct run');
    expect(prompt).toContain('write NO interim chat text at all');
    expect(prompt).toContain('final summary only');
  });

  it('bans any interim sentence that starts with I\u2019ll', () => {
    const prompt = buildExecutorSystemPrompt();
    expect(prompt).toContain('any interim sentence starting with "I\'ll"');
  });

  it('makes the finish walkthrough headings optional while keeping the summary field', () => {
    const prompt = buildExecutorSystemPrompt();
    expect(prompt).toContain('call finish');
    expect(prompt).toContain('the summary field');
    expect(prompt).toContain('only when useful — not always');
    expect(prompt).toContain('files field gives one plain-language line per changed file');
    expect(prompt).not.toContain('summary field uses these sections');
  });
});

describe('planner preamble prompt', () => {
  it('forbids the Let me preamble and avoids mandatory question sections', () => {
    const prompt = buildPlannerSystemPrompt();
    expect(prompt).toContain('Never open with a "Let me…" preamble');
    expect(prompt).toContain('the plan card carries the detail');
    expect(prompt).toContain('Plain prose, a few sentences. No headings, labeled sections, or lists.');
    expect(prompt).not.toContain('WHAT → HOW → WHY');
    expect(prompt).toContain('questions never call submit_plan');
  });
});
