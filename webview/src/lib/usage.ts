export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(Math.max(0, Math.round(tokens)));
}

export function contextPercent(tokens: number, limit: number): number {
  if (!limit || limit <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((tokens / limit) * 100)));
}
