import { describe, expect, it } from 'vitest';
import { MistakeTracker } from '../src/agent/mistakes';

describe('MistakeTracker', () => {
  it('resets on success', () => {
    const tracker = new MistakeTracker();
    tracker.record('Error: nope');
    tracker.record('Error: nope');
    expect(tracker.record('ok').count).toBe(0);
  });

  it('asks for correction at the third consecutive failure', () => {
    const tracker = new MistakeTracker();
    tracker.record('Error: a');
    tracker.record('Error: b');
    expect(tracker.record('Error: c').action).toBe('correct');
  });

  it('stops at the sixth consecutive failure', () => {
    const tracker = new MistakeTracker();
    const actions = ['Error: a', 'Error: b', 'Error: c', 'Error: d', 'Error: e', 'Error: f'].map(
      (result) => tracker.record(result).action,
    );
    expect(actions).toEqual(['none', 'none', 'correct', 'none', 'none', 'stop']);
  });

  it('counts "Error in" results as failures', () => {
    const tracker = new MistakeTracker();
    tracker.record('Error in src/app.ts: hunk not found');
    tracker.record('Error in src/app.ts: hunk not found');
    expect(tracker.record('Error in src/app.ts: hunk not found').action).toBe('correct');
  });
});
