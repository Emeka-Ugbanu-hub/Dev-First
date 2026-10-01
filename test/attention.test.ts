import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { INPUT_DEBOUNCE_MS, SOUND_FILES, shouldNotifyInput } from '../src/attention/AttentionService';

describe('SOUND_FILES', () => {
  it('maps each sound to a macOS system sound', () => {
    expect(SOUND_FILES.chime).toBe('/System/Library/Sounds/Glass.aiff');
    expect(SOUND_FILES.beep).toBe('/System/Library/Sounds/Ping.aiff');
  });

  it('has no entry for the off setting', () => {
    expect(Object.keys(SOUND_FILES).sort()).toEqual(['beep', 'chime']);
  });
});

describe('shouldNotifyInput', () => {
  it('allows the first notification', () => {
    expect(shouldNotifyInput(undefined, 'a plan is ready', 1000)).toBe(true);
  });

  it('suppresses an identical message inside the debounce window', () => {
    expect(shouldNotifyInput({ message: 'msg', at: 1000 }, 'msg', 1000 + INPUT_DEBOUNCE_MS - 1)).toBe(false);
  });

  it('allows an identical message after the debounce window', () => {
    expect(shouldNotifyInput({ message: 'msg', at: 1000 }, 'msg', 1000 + INPUT_DEBOUNCE_MS + 1)).toBe(true);
  });

  it('allows a different message immediately', () => {
    expect(shouldNotifyInput({ message: 'a', at: 1000 }, 'b', 1001)).toBe(true);
  });
});
