import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';
import { ApprovalMemory, ExternalDirectoryConsent, commandApprovalPrefix } from '../src/agent/approvals';

function toolbox(options: { root: string; approvalMemory?: ApprovalMemory; externalDirectories?: ExternalDirectoryConsent }) {
  return new ToolBox({
    root: options.root,
    diffManager: {} as never,
    terminalTimeoutSeconds: 15,
    autoApproveTerminal: false,
    autoApproveEdits: true,
    safeCommandsOnly: true,
    yolo: false,
    autoApproveMcp: true,
    checkDiagnostics: false,
    sandbox: 'off',
    approvalMemory: options.approvalMemory,
    externalDirectories: options.externalDirectories,
  });
}

const deny = { requestTerminalApproval: async () => 'deny' as const };

describe('command approval prefixes', () => {
  it('uses the first two tokens plus a star', () => {
    expect(commandApprovalPrefix('npm run dev')).toBe('npm run *');
    expect(commandApprovalPrefix('  npm   install  express ')).toBe('npm install *');
    expect(commandApprovalPrefix('')).toBe('');
  });

  it('matches same-prefix commands and does not over-match', () => {
    const memory = new ApprovalMemory();
    memory.remember('npm run dev');
    expect(memory.allows('npm run build')).toBe(true);
    expect(memory.allows('npm run dev')).toBe(true);
    expect(memory.allows('npm install')).toBe(false);
    expect(memory.size).toBe(1);
    memory.clear();
    expect(memory.allows('npm run build')).toBe(false);
  });

  it('skips the approval card for a remembered command', async () => {
    const memory = new ApprovalMemory();
    const box = toolbox({ root: process.cwd(), approvalMemory: memory });
    const approval = vi.fn(async () => 'allow' as const);
    const first = await box.execute('run_terminal_command', JSON.stringify({ command: 'echo -n first' }), {
      requestTerminalApproval: approval,
    });
    expect(first).toContain('first');
    expect(approval).toHaveBeenCalledTimes(1);

    const second = await box.execute('run_terminal_command', JSON.stringify({ command: 'echo -n second' }), {
      requestTerminalApproval: approval,
    });
    expect(second).toContain('second');
    expect(approval).toHaveBeenCalledTimes(1);
  });

  it('does not remember denied commands', async () => {
    const memory = new ApprovalMemory();
    const box = toolbox({ root: process.cwd(), approvalMemory: memory });
    const approval = vi.fn(async () => 'deny' as const);
    const first = await box.execute('run_terminal_command', JSON.stringify({ command: 'echo -n one' }), {
      requestTerminalApproval: approval,
    });
    expect(first).toContain('denied');
    const second = await box.execute('run_terminal_command', JSON.stringify({ command: 'echo -n two' }), {
      requestTerminalApproval: approval,
    });
    expect(second).toContain('denied');
    expect(approval).toHaveBeenCalledTimes(2);
  });
});

describe('external directory consent', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-external-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'one.txt'), 'external one\n', 'utf-8');
    await fs.writeFile(path.join(outside, 'two.txt'), 'external two\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it('asks once per parent directory and remembers the grant', async () => {
    const consent = new ExternalDirectoryConsent();
    const box = toolbox({ root, externalDirectories: consent });
    const approval = vi.fn(async () => true);
    const first = await box.execute('read_file', JSON.stringify({ path: '../outside/one.txt' }), {
      ...deny,
      requestExternalDirectoryApproval: approval,
    });
    expect(first).toContain('external one');
    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledWith(outside);

    const second = await box.execute('read_file', JSON.stringify({ path: '../outside/two.txt' }), {
      ...deny,
      requestExternalDirectoryApproval: approval,
    });
    expect(second).toContain('external two');
    expect(approval).toHaveBeenCalledTimes(1);
  });

  it('keeps blocking when the developer denies', async () => {
    const box = toolbox({ root, externalDirectories: new ExternalDirectoryConsent() });
    const result = await box.execute('read_file', JSON.stringify({ path: '../outside/one.txt' }), {
      ...deny,
      requestExternalDirectoryApproval: async () => false,
    });
    expect(result).toContain('outside the workspace');
    expect(result).not.toContain('external one');
  });

  it('keeps the hard error when no consent channel exists', async () => {
    const box = toolbox({ root });
    const result = await box.execute('read_file', JSON.stringify({ path: '../outside/one.txt' }), deny);
    expect(result).toContain('outside the workspace');
  });
});
