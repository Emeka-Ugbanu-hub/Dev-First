import { describe, expect, it } from 'vitest';
import { buildPlannerSystemPrompt, PLANNER_EXAMPLES } from '../src/planner/prompts';
import { checkPlanReadiness } from '../src/planner/planReadiness';
import { planFromObject } from '../src/planner/planParser';
import { estimateTokens } from '../src/agent/compaction';

function promptTokens(mode?: 'skip' | 'lite' | 'spec' | 'full'): number {
  return estimateTokens([{ role: 'system', content: buildPlannerSystemPrompt(undefined, 'default', mode) }]);
}

describe('planner prompt budget', () => {
  it('keeps the static prompt compact', () => {
    expect(promptTokens()).toBeLessThanOrEqual(2200);
  });

  it('keeps every mode fragment compact', () => {
    for (const mode of ['skip', 'lite', 'spec', 'full'] as const) {
      expect(promptTokens(mode), mode).toBeLessThanOrEqual(2200);
    }
  });

  it('renders every example as a valid readiness-ready plan', () => {
    for (const example of PLANNER_EXAMPLES) {
      const plan = planFromObject(example.plan, 1);
      expect(plan, example.request).toBeDefined();
      expect(checkPlanReadiness(plan!).ready, example.request).toBe(true);
    }
  });

  it('documents every mode in the fallback table', () => {
    const prompt = buildPlannerSystemPrompt();
    for (const mode of ['skip', 'lite', 'spec', 'full']) {
      expect(prompt).toContain(mode);
    }
  });
});
