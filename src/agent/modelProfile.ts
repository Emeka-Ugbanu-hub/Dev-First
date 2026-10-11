export type ContextProfileTier = 'compact' | 'standard' | 'large';

export interface ContextProfile {
  tier: ContextProfileTier;
  triggerRatio: number;
  pruneRatio: number;
  preserveTokens: number;
  reserveRatio: number;
}

export interface ContextProfileInput {
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  override?: 'auto' | ContextProfileTier;
}

export const MIN_RECENT_MESSAGES = 6;

const TIER_PROFILES: Record<ContextProfileTier, Omit<ContextProfile, 'tier'>> = {
  compact: { triggerRatio: 0.45, pruneRatio: 0.35, preserveTokens: 8_000, reserveRatio: 0.2 },
  standard: { triggerRatio: 0.6, pruneRatio: 0.5, preserveTokens: 20_000, reserveRatio: 0.15 },
  large: { triggerRatio: 0.62, pruneRatio: 0.5, preserveTokens: 24_000, reserveRatio: 0.12 },
};

const REASONING_EXTRA_MAX = 0.05;
const RESERVE_RATIO_MAX = 0.3;

export function tierForWindow(contextWindow: number): ContextProfileTier {
  if (contextWindow <= 32_000) {
    return 'compact';
  }
  if (contextWindow <= 200_000) {
    return 'standard';
  }
  return 'large';
}

export function contextProfileFor(input: ContextProfileInput): ContextProfile {
  const tier = input.override && input.override !== 'auto' ? input.override : tierForWindow(input.contextWindow);
  return { tier, ...TIER_PROFILES[tier] };
}

export function reserveRatioTotal(profile: ContextProfile, contextWindow: number, reasoning: boolean): number {
  const extra = reasoning && contextWindow > 0 ? Math.min(REASONING_EXTRA_MAX, 8_000 / contextWindow) : 0;
  return Math.min(profile.reserveRatio + extra, RESERVE_RATIO_MAX);
}

export function effectiveThresholdTokens(
  profile: ContextProfile,
  contextWindow: number,
  reasoning: boolean,
  recentToolBytes: number,
): number {
  if (contextWindow <= 0) {
    return 0;
  }
  const reserve = reserveRatioTotal(profile, contextWindow, reasoning);
  let threshold = Math.min(profile.triggerRatio * contextWindow, contextWindow - reserve * contextWindow);
  if (recentToolBytes > contextWindow * 0.2 * 4) {
    threshold *= 0.9;
  }
  return Math.max(0, threshold);
}

export function preserveBudgetTokens(profile: ContextProfile, contextWindow: number, reasoning: boolean): number {
  const threshold = effectiveThresholdTokens(profile, contextWindow, reasoning, 0);
  const reserve = reserveRatioTotal(profile, contextWindow, reasoning) * contextWindow;
  const budget = Math.max(4_000, threshold - reserve - 2_000);
  return Math.max(0, Math.min(profile.preserveTokens, budget, threshold));
}
