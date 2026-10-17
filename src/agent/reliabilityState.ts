import type { Plan, RunReliabilityState } from '../shared/protocol';

/** Build the compact, durable state used to keep planning and recovery grounded. */
export function reliabilityStateForPlan(plan: Plan, checkpointId?: string): RunReliabilityState {
  const files = new Set<string>();
  const symbols = new Set<string>();
  for (const entry of plan.expectedFiles ?? []) files.add(entry.path);
  for (const entry of plan.context ?? []) {
    files.add(entry.path);
    const match = entry.role.match(/(?:symbol|function|class|method)[: ]+([\w$.-]+)/i);
    if (match?.[1]) symbols.add(match[1]);
  }
  const required = plan.steps?.filter((step) => /\b(test|build|typecheck|lint|verify|check)\b/i.test(step)).length
    ? ['diagnostics']
    : [];
  return {
    scope: { files: [...files].sort(), symbols: [...symbols].sort() },
    evidence: (plan.context ?? []).slice(0, 24).map((entry) => ({
      kind: 'plan-context',
      summary: entry.role,
      file: entry.path,
    })),
    verification: { required, ran: [], status: 'pending' },
    recovery: { ...(checkpointId ? { checkpointId } : {}), resumable: true },
    updatedAt: Date.now(),
  };
}

export function reliabilityVerification(
  state: RunReliabilityState | undefined,
  ran: string[],
  failed = false,
): RunReliabilityState | undefined {
  if (!state) return undefined;
  const checks = [...new Set([...state.verification.ran, ...ran])];
  return {
    ...state,
    verification: {
      required: state.verification.required,
      ran: checks,
      status: failed ? 'failed' : state.verification.required.every((check) => checks.some((item) => item === check || item.startsWith(`${check}:`))) ? 'passed' : 'pending',
    },
    updatedAt: Date.now(),
  };
}
