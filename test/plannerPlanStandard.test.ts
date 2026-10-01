import { describe, expect, it } from 'vitest';
import { buildPlannerSystemPrompt } from '../src/planner/prompts';

describe('planner approval-plan standard', () => {
  const prompt = buildPlannerSystemPrompt();

  it('frames an approval plan as an explanation of the affected subsystem', () => {
    expect(prompt).toContain('both an execution specification and an explanation for the developer');
    expect(prompt).toContain('explain how the proposal fits before the developer chooses GO ON');
  });

  it('requires HOW for cross-file changes and WHY for architectural decisions', () => {
    expect(prompt).toContain('do not omit HOW when the change crosses files, layers, or responsibilities');
    expect(prompt).toContain('Do not omit WHY when the plan makes an architectural decision');
  });

  it('treats ambiguous requests as a learning moment with one focused question', () => {
    expect(prompt).toContain('explain the current structure and the meaningful interpretations');
    expect(prompt).toContain('ask ONE focused question that determines the plan');
    expect(prompt).toContain('Do not create an approval plan from an unverified assumption');
  });

  it('gates FLOW on visual clarity rather than structure alone', () => {
    expect(prompt).toContain('only when a multi-component flow, boundary, or state transition is clearer visually');
  });
});
