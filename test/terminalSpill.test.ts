import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';
import { runTerminalCommand } from '../src/agent/terminal';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-term-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const bigCommand = `node -e "process.stdout.write('x'.repeat(250000))"`;

describe('terminal output spill', () => {
  it('streams excess output to a spill file and returns the path', async () => {
    const result = await runTerminalCommand(bigCommand, root, 30, undefined, 'off', { inactivityTimeoutMs: 0 });
    expect(result.spillPath).toMatch(/^\.dev-first\/tool-output\/terminal-/);
    expect(result.output).toContain('earlier output truncated');
    expect(result.output.length).toBeLessThan(250_000);
    const stored = await fs.readFile(path.join(root, result.spillPath!), 'utf-8');
    expect(stored).toBe('x'.repeat(250000));
  });

  it('does not spill small output', async () => {
    const result = await runTerminalCommand('echo small', root, 30, undefined, 'off', { inactivityTimeoutMs: 0 });
    expect(result.spillPath).toBeUndefined();
    expect(result.output).toContain('small');
  });

  it('surfaces the spill path through run_terminal_command without double spilling', async () => {
    const box = new ToolBox({
      root,
      diffManager: {} as any,
      terminalTimeoutSeconds: 30,
      autoApproveTerminal: true,
      autoApproveEdits: true,
      safeCommandsOnly: false,
      yolo: false,
      autoApproveMcp: true,
      checkDiagnostics: false,
      sandbox: 'off',
    });
    const result = await box.execute(
      'run_terminal_command',
      JSON.stringify({ command: bigCommand }),
      { requestTerminalApproval: async () => 'allow' as const },
    );
    expect(result).toContain('Full output: .dev-first/tool-output/terminal-');
    expect(result).not.toContain('full output: .dev-first/tool-output/run_terminal_command');
  });
});
