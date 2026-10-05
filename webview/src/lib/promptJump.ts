export const PROMPT_JUMP_OFFSET = 12;
export const PROMPT_JUMP_DRIFT = 2;

export function promptJumpTop(
  messageTop: number,
  containerTop: number,
  scrollTop: number,
  offset = PROMPT_JUMP_OFFSET,
): number {
  return Math.max(0, messageTop - containerTop + scrollTop - offset);
}

export function needsCorrection(
  current: number,
  desired: number,
  threshold = PROMPT_JUMP_DRIFT,
): boolean {
  return Math.abs(current - desired) > threshold;
}
