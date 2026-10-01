import type { Phase, Plan } from '../../../src/shared/protocol';

export function shouldDockPlan(phase: Phase, plan: Plan | null): boolean {
  if (!plan) {
    return false;
  }
  if (plan.status === 'completed') {
    return false;
  }
  return plan.status === 'draft' || phase === 'executing';
}
