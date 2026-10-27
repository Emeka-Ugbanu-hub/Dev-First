import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';

function toolbox(): ToolBox {
  return new ToolBox({
    root: process.cwd(),
    terminalTimeoutSeconds: 15,
    autoApproveTerminal: false,
    autoApproveEdits: true,
    safeCommandsOnly: true,
    yolo: false,
    autoApproveMcp: true,
    checkDiagnostics: false,
    sandbox: 'off',
  } as any);
}

const GUIDANCE =
  'This command was blocked because it is not an allowed read-only operation. Relative workspace navigation (for example, `cd functions && find .`) is allowed; writes, destructive commands, redirects, and unsafe shell execution are not.';

describe('run_terminal_command during planning', () => {
  it('declines an unsafe command with guidance and no approval request', async () => {
    const approval = vi.fn(async () => 'allow' as const);
    const result = await toolbox().execute(
      'run_terminal_command',
      JSON.stringify({ command: 'npm run build' }),
      { requestTerminalApproval: approval, planning: true },
    );

    expect(result).toBe(GUIDANCE);
    expect(approval).not.toHaveBeenCalled();
  });

  it('runs an allowlisted command without an approval request', async () => {
    const approval = vi.fn(async () => 'allow' as const);
    const result = await toolbox().execute(
      'run_terminal_command',
      JSON.stringify({ command: 'echo planning-check' }),
      { requestTerminalApproval: approval, planning: true },
    );

    expect(result).toContain('planning-check');
    expect(result).toContain('Exit code: 0');
    expect(approval).not.toHaveBeenCalled();
  });

  it('allows relative workspace navigation before a read-only command', async () => {
    const approval = vi.fn(async () => 'allow' as const);
    const result = await toolbox().execute(
      'run_terminal_command',
      JSON.stringify({ command: 'cd src && pwd' }),
      { requestTerminalApproval: approval, planning: true },
    );

    expect(result).toContain('Exit code: 0');
    expect(approval).not.toHaveBeenCalled();
  });

  it('blocks parent navigation during planning', async () => {
    const approval = vi.fn(async () => 'allow' as const);
    const result = await toolbox().execute(
      'run_terminal_command',
      JSON.stringify({ command: 'cd .. && find . -maxdepth 1' }),
      { requestTerminalApproval: approval, planning: true },
    );

    expect(result).toContain('blocked');
    expect(approval).not.toHaveBeenCalled();
  });

  it('still requests approval for unsafe commands during execution', async () => {
    const approval = vi.fn(async () => 'deny' as const);
    const result = await toolbox().execute(
      'run_terminal_command',
      JSON.stringify({ command: 'npm run build' }),
      { requestTerminalApproval: approval },
    );

    expect(approval).toHaveBeenCalledTimes(1);
    expect(result).toContain('denied');
  });

  it('still runs allowlisted execution commands without approval when auto-approve is on', async () => {
    const box = new ToolBox({
      root: process.cwd(),
      terminalTimeoutSeconds: 15,
      autoApproveTerminal: true,
      autoApproveEdits: true,
      safeCommandsOnly: true,
      yolo: false,
      autoApproveMcp: true,
      checkDiagnostics: false,
      sandbox: 'off',
    } as any);
    const approval = vi.fn(async () => 'deny' as const);
    const result = await box.execute('run_terminal_command', JSON.stringify({ command: 'echo exec-check' }), {
      requestTerminalApproval: approval,
    });

    expect(result).toContain('exec-check');
    expect(approval).not.toHaveBeenCalled();
  });
});
