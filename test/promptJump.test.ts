import { describe, expect, it } from 'vitest';
import { nearestPromptIndex, needsCorrection, promptJumpTop } from '../webview/src/lib/promptJump';

describe('promptJumpTop', () => {
  it('centers the message in the viewport', () => {
    expect(promptJumpTop(500, 100, 0, 600, 200)).toBe(200);
    expect(promptJumpTop(500, 100, 50, 600, 200)).toBe(250);
  });

  it('top-aligns messages taller than the viewport', () => {
    expect(promptJumpTop(500, 100, 0, 600, 700)).toBe(388);
  });

  it('never scrolls above zero', () => {
    expect(promptJumpTop(100, 100, 0, 600, 200)).toBe(0);
  });
});

describe('nearestPromptIndex', () => {
  it('picks the prompt center nearest the viewport center', () => {
    expect(nearestPromptIndex(100, 600, [150, 450, 900])).toBe(1);
    expect(nearestPromptIndex(100, 600, [350, 500])).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(nearestPromptIndex(100, 600, [])).toBe(-1);
  });
});

describe('needsCorrection', () => {
  it('corrects only when drift exceeds the threshold', () => {
    expect(needsCorrection(100, 103)).toBe(true);
    expect(needsCorrection(100, 102)).toBe(false);
    expect(needsCorrection(100, 98)).toBe(false);
  });
});
