export const PROMPT_JUMP_OFFSET = 12;
export const PROMPT_JUMP_DRIFT = 2;

export function promptJumpTop(
  messageTop: number,
  containerTop: number,
  scrollTop: number,
  containerHeight: number,
  messageHeight: number,
): number {
  const relative = messageTop - containerTop + scrollTop;
  if (messageHeight >= containerHeight) {
    return Math.max(0, relative - PROMPT_JUMP_OFFSET);
  }
  return Math.max(0, relative - (containerHeight - messageHeight) / 2);
}

export function nearestPromptIndex(
  containerTop: number,
  containerHeight: number,
  centers: number[],
): number {
  if (centers.length === 0) {
    return -1;
  }
  const target = containerTop + containerHeight / 2;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  centers.forEach((center, index) => {
    const distance = Math.abs(center - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

export function needsCorrection(
  current: number,
  desired: number,
  threshold = PROMPT_JUMP_DRIFT,
): boolean {
  return Math.abs(current - desired) > threshold;
}
