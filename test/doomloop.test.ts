import { describe, expect, it } from 'vitest';
import { DoomLoopDetector } from '../src/agent/doomloop';
import { ToolCall } from '../src/llm/types';

function call(name: string, args: string): ToolCall {
  return { id: `id-${Math.random()}`, name, arguments: args };
}

describe('DoomLoopDetector', () => {
  it('stays quiet for distinct calls', () => {
    const detector = new DoomLoopDetector();
    expect(detector.record(call('read_file', '{"path":"a"}')).action).toBe('none');
    expect(detector.record(call('read_file', '{"path":"b"}')).action).toBe('none');
    expect(detector.record(call('edit_file', '{"path":"a"}')).action).toBe('none');
  });

  it('warns at the third identical call', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('read_file', '{"path":"a"}');
    expect(detector.record(same()).action).toBe('none');
    expect(detector.record(same()).action).toBe('none');
    const third = detector.record(same());
    expect(third.action).toBe('warn');
    expect(third.count).toBe(3);
  });

  it('warns only once per key', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('read_file', '{"path":"a"}');
    detector.record(same());
    detector.record(same());
    expect(detector.record(same()).action).toBe('warn');
    expect(detector.record(same()).action).toBe('none');
  });

  it('stops at the fifth identical call', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('search_text', '{"query":"x"}');
    for (let i = 0; i < 4; i++) {
      detector.record(same());
    }
    const result = detector.record(same());
    expect(result.action).toBe('stop');
    expect(result.count).toBe(5);
  });

  it('forgets old calls outside the window', () => {
    const detector = new DoomLoopDetector(3, 3, 5);
    const same = () => call('read_file', '{"path":"a"}');
    detector.record(same());
    detector.record(call('other', '{}'));
    detector.record(call('other2', '{}'));
    detector.record(same());
    const result = detector.record(same());
    expect(result.action).toBe('none');
  });

  it('resets', () => {
    const detector = new DoomLoopDetector();
    const same = () => call('read_file', '{"path":"a"}');
    detector.record(same());
    detector.record(same());
    detector.reset();
    expect(detector.record(same()).action).toBe('none');
  });
});
