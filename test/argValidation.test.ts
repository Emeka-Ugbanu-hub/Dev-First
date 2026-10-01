import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';

function toolbox(): ToolBox {
  return new ToolBox({
    root: process.cwd(),
    diffManager: {} as any,
    terminalTimeoutSeconds: 15,
    autoApproveTerminal: false,
    autoApproveEdits: true,
    safeCommandsOnly: true,
    yolo: false,
    autoApproveMcp: true,
    checkDiagnostics: false,
    sandbox: 'off',
  });
}

const context = { requestTerminalApproval: async () => 'deny' as const };

describe('argument validation', () => {
  it('rejects a missing required field with a corrective message', async () => {
    const result = await toolbox().execute('read_file', '{}', context);
    expect(result).toBe(
      'Error: invalid arguments for read_file — missing required field "path". Re-emit the call with valid JSON matching the schema.',
    );
  });

  it('rejects a wrong top-level type', async () => {
    const result = await toolbox().execute('read_file', JSON.stringify({ path: 5 }), context);
    expect(result).toContain('invalid arguments for read_file');
    expect(result).toContain('"path" must be a string (got number)');
  });

  it('rejects NaN-like numbers before execution', async () => {
    const approval = vi.fn(async () => 'allow' as const);
    const result = await toolbox().execute(
      'run_terminal_command',
      JSON.stringify({ command: 'echo hi', timeout_seconds: 'soon' }),
      { requestTerminalApproval: approval },
    );
    expect(result).toContain('"timeout_seconds" must be a finite number');
    expect(approval).not.toHaveBeenCalled();
  });

  it('rejects a wrong type for an array field', async () => {
    const result = await toolbox().execute('todo_write', JSON.stringify({ todos: 'nope' }), context);
    expect(result).toContain('"todos" must be an array');
  });

  it('still runs tools whose schema is unknown', async () => {
    const result = await toolbox().execute('list_processes', '{}', context);
    expect(result).toBe('No background processes are tracked by Dev-First.');
  });
});
