import { describe, expect, it } from 'vitest';
import { needsCorrection, promptJumpTop } from '../webview/src/lib/promptJump';

describe('promptJumpTop', () => {
  it('anchors the message near the top with the offset', () => {
    expect(promptJumpTop(500, 100, 0)).toBe(388);
    expect(promptJumpTop(500, 100, 50)).toBe(438);
  });

  it('never scrolls above zero', () => {
    expect(promptJumpTop(100, 100, 0)).toBe(0);
  });
});

describe('needsCorrection', () => {
  it('corrects only when drift exceeds the threshold', () => {
    expect(needsCorrection(100, 103)).toBe(true);
    expect(needsCorrection(100, 102)).toBe(false);
    expect(needsCorrection(100, 98)).toBe(false);
  });
});
