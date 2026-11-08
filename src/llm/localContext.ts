export const LOCAL_CONTEXT_SAFETY_CAP = 0;

export function safeLocalContextCap(configured: number | undefined): number {
  return configured && configured > 0 ? configured : 0;
}
