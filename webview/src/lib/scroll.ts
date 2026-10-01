export const FOLLOW_THRESHOLD = 80;

export function shouldFollow(distanceFromBottom: number): boolean {
  return distanceFromBottom <= FOLLOW_THRESHOLD;
}
