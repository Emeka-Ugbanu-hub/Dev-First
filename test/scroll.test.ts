import { describe, expect, it } from 'vitest';
import { FOLLOW_THRESHOLD, shouldFollow } from '../webview/src/lib/scroll';

describe('shouldFollow', () => {
  it('follows when the view is at or near the bottom', () => {
    expect(shouldFollow(0)).toBe(true);
    expect(shouldFollow(FOLLOW_THRESHOLD)).toBe(true);
  });

  it('pauses when the user scrolls up past the threshold', () => {
    expect(shouldFollow(FOLLOW_THRESHOLD + 1)).toBe(false);
    expect(shouldFollow(1000)).toBe(false);
  });
});
