import { StreamEvent, UsageTotals } from './types';

export type UsageEvent = Extract<StreamEvent, { type: 'usage' }>;

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, reasoning: 0, cached: 0 };
}

export function mergeUsage(current: UsageTotals | undefined, event: UsageEvent): UsageTotals {
  const base = current ?? emptyUsage();
  return {
    input: event.inputTokens ?? base.input,
    output: event.outputTokens ?? base.output,
    reasoning: event.reasoningTokens ?? base.reasoning,
    cached: event.cachedTokens ?? base.cached,
  };
}

export function usageTotal(usage: UsageTotals): number {
  return usage.input + usage.output + usage.reasoning + usage.cached;
}
