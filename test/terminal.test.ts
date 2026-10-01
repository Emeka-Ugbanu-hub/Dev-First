import { describe, expect, it } from 'vitest';
import { runTerminalCommand, stripAnsi } from '../src/agent/terminal';

describe('stripAnsi', () => {
  it('strips CSI color codes', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m')).toBe('red');
  });

  it('strips OSC hyperlinks', () => {
    expect(stripAnsi('\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007')).toBe('link');
  });

  it('strips cursor movement and line clears', () => {
    expect(stripAnsi('a\u001B[2Kb\u001B[1;2Hc')).toBe('abc');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('runTerminalCommand timeouts', () => {
  it('returns a running note after the inactivity timeout', async () => {
    const result = await runTerminalCommand('sleep 0.4', process.cwd(), 30, undefined, 'off', {
      inactivityTimeoutMs: 100,
      background: { adopt: () => 'bg_test' },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.note).toContain('no output for');
    expect(result.note).toContain('bg_test');
  });

  it('stops the command at the absolute cap', async () => {
    const result = await runTerminalCommand(
      'node -e "setInterval(() => {}, 1000)"',
      process.cwd(),
      30,
      undefined,
      'off',
      { absoluteCapMs: 300, inactivityTimeoutMs: 0 },
    );
    expect(result.timedOut).toBe(true);
  });
});
