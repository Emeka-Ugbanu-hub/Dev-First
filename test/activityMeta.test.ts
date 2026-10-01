import { describe, expect, it } from 'vitest';
import { activityMeta } from '../src/agent/tools';
import { ToolCall } from '../src/llm/types';

function call(name: string): ToolCall {
  return { id: 'id', name, arguments: '{}' };
}

describe('activityMeta', () => {
  it('marks terminal results and parses the exit code', () => {
    const meta = activityMeta(call('run_terminal_command'), 'Exit code: 0\nall tests passed');
    expect(meta.detailKind).toBe('terminal');
    expect(meta.exitCode).toBe(0);
    expect(meta.detail).toContain('all tests passed');
  });

  it('parses failing exit codes', () => {
    const meta = activityMeta(call('run_terminal_command'), 'Exit code: 2\nboom');
    expect(meta.exitCode).toBe(2);
  });

  it('marks other tools as text', () => {
    const meta = activityMeta(call('read_file'), '1 | const a = 1;');
    expect(meta.detailKind).toBe('text');
    expect(meta.exitCode).toBeUndefined();
  });

  it('truncates long output', () => {
    const meta = activityMeta(call('read_file'), 'x'.repeat(10_000));
    expect(meta.detail).toContain('[output truncated]');
    expect(meta.detail!.length).toBeLessThan(4100);
  });
});
