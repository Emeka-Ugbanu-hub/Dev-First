import type { Plan } from '../shared/protocol';

export type PlanReadinessField =
  | 'scope'
  | 'steps'
  | 'expectedFiles'
  | 'dependencies'
  | 'assumptions'
  | 'verification'
  | 'risks';

export interface PlanReadiness {
  ready: boolean;
  missing: PlanReadinessField[];
}

const FIELD_LABELS: Record<PlanReadinessField, string> = {
  scope: 'what (one-line scope)',
  steps: 'steps (concrete actions)',
  expectedFiles: 'expectedFiles (use [] when no files change)',
  dependencies: 'dependencies (use "none" when there are none)',
  assumptions: 'assumptions (use "none" when there are none)',
  verification: 'verification (use ["none"] only when no check applies)',
  risks: 'risks (1-2 concrete failure modes)',
};

const FIELD_EXAMPLES: Record<PlanReadinessField, string> = {
  scope: '"what": "One-line outcome of the change"',
  steps: '"steps": ["Update src/example.ts to ..."]',
  expectedFiles: '"expectedFiles": [{"path": "src/example.ts", "action": "modify", "reason": "Why it changes"}]',
  dependencies: '"dependencies": "none"',
  assumptions: '"assumptions": "none"',
  verification: '"verification": ["Run the relevant tests"]',
  risks: '"risks": ["A concrete failure mode to guard against"]',
};

export function readinessFieldLabel(field: PlanReadinessField): string {
  return FIELD_LABELS[field];
}

/** One minimal JSON object that fills exactly the rejected fields. */
export function readinessCorrection(missing: PlanReadinessField[]): string {
  return `{${missing.map((field) => FIELD_EXAMPLES[field]).join(', ')}}`;
}

/**
 * Validate the minimum execution contract without another model call.
 * Lite plans are intentionally lighter; dependencies and assumptions are
 * normalized to "none" before this runs, so they are only enforced here as a
 * defensive check for direct callers.
 */
export function checkPlanReadiness(plan: Plan): PlanReadiness {
  // Explanations are answers, not execution contracts.
  if (plan.trivial || plan.planningMode === 'skip' || plan.intent === 'explanation') {
    return { ready: true, missing: [] };
  }
  const mode = plan.planningMode ?? 'spec';
  const missing: PlanReadinessField[] = [];
  if (!nonEmpty(plan.what)) missing.push('scope');
  if (!plan.steps?.some(nonEmpty)) missing.push('steps');
  if (plan.expectedFiles === undefined) missing.push('expectedFiles');
  if (mode !== 'lite') {
    if (!nonEmpty(plan.dependencies)) missing.push('dependencies');
    if (!nonEmpty(plan.assumptions)) missing.push('assumptions');
    if (!plan.verification?.some(nonEmpty)) missing.push('verification');
  }
  if (mode === 'full' && !plan.risks?.some(nonEmpty)) {
    missing.push('risks');
  }
  return { ready: missing.length === 0, missing };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
