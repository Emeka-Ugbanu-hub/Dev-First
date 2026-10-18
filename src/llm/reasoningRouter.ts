import type { ReasoningOptions, ReasoningRouteContext } from './types';
import { PARALLEL_SAFE } from '../agent/parallelTools';

// Keep routing aligned with the actual planner/executor registry. A stale
// duplicate list silently disables adaptive effort for normal read turns.
const READ_TOOLS = PARALLEL_SAFE;
const HIGH_SIGNAL_TOOLS = new Set(['run_terminal_command', 'verify_change', 'apply_change_set']);
const RANK: Record<string, number> = { off: 0, none: 0, low: 1, medium: 2, high: 3, max: 4, on: 3 };

/** Choose bounded effort from structured phase/tool evidence without raising the user's ceiling. */
export function routeReasoning(
  base: ReasoningOptions | undefined,
  levels: readonly string[],
  context: ReasoningRouteContext,
): ReasoningOptions | undefined {
  if (!base || !base.enabled || !base.effort || base.effort === 'off' || base.effort === 'none') return base;
  const previous = context.previousToolNames ?? [];
  const highSignal = context.previousToolFailed === true || context.phase === 'verification' || previous.some((name) => HIGH_SIGNAL_TOOLS.has(name));
  const readOnly = previous.length > 0 && previous.every((name) => READ_TOOLS.has(name));
  const desired = highSignal ? 'high' : readOnly || context.phase === 'planning' ? 'low' : 'medium';
  const ceiling = RANK[base.effort] ?? RANK.medium;
  const desiredRank = Math.min(RANK[desired], ceiling);
  const exact = levels
    .filter((level) => RANK[level] !== undefined && RANK[level] <= desiredRank)
    .sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
  if (exact) return { ...base, effort: exact };
  // Toggle-only providers expose no intermediate effort. Keep low/medium
  // requests off for speed; high is the point at which thinking is needed.
  if (levels.includes('on')) return { ...base, effort: desiredRank >= RANK.medium ? 'on' : 'off' };
  return base;
}
