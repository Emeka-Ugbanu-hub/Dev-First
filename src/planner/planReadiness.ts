import type { Plan } from '../shared/protocol';

export interface PlanReadiness {
  ready: boolean;
  missing: string[];
}

/** Validate the minimum execution contract without another model call. */
export function checkPlanReadiness(plan: Plan): PlanReadiness {
  if (plan.trivial) return { ready: true, missing: [] };
  const missing: string[] = [];
  if (!nonEmpty(plan.what)) missing.push('scope (what)');
  if (!plan.steps?.some(nonEmpty)) missing.push('concrete steps');
  if (plan.expectedFiles === undefined) missing.push('expected files (use [] when no files change)');
  if (!nonEmpty(plan.dependencies)) missing.push('dependencies (use "none" when there are none)');
  if (!nonEmpty(plan.assumptions)) missing.push('assumptions (use "none" when there are none)');
  if (!plan.verification?.some(nonEmpty)) missing.push('verification steps (use ["none"] when none apply)');
  return { ready: missing.length === 0, missing };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
