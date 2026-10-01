import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';
import { todoWriteTool } from '../src/agent/tools';
import type { TodoItem } from '../src/shared/protocol';

function toolbox(root: string): ToolBox {
  return new ToolBox({
    root,
    diffManager: {} as never,
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

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-tierb-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('todo_write cancelled status', () => {
  it('advertises cancelled and the one-in-progress rule', () => {
    expect(todoWriteTool.description).toContain('cancelled');
    expect(todoWriteTool.description).toContain('exactly one task in_progress');
    const items = (todoWriteTool.parameters.properties as Record<string, any>).todos.items;
    expect(items.properties.status.enum).toEqual(['pending', 'in_progress', 'done', 'cancelled']);
  });

  it('records cancelled todos and reports them', async () => {
    let recorded: TodoItem[] = [];
    const box = new ToolBox({
      root,
      diffManager: {} as never,
      terminalTimeoutSeconds: 15,
      autoApproveTerminal: false,
      autoApproveEdits: true,
      safeCommandsOnly: true,
      yolo: false,
      autoApproveMcp: true,
      checkDiagnostics: false,
      sandbox: 'off',
      onTodos: (todos) => {
        recorded = todos;
      },
    });
    const result = await box.execute(
      'todo_write',
      JSON.stringify({
        todos: [
          { text: 'one', status: 'done' },
          { text: 'two', status: 'cancelled' },
          { text: 'three', status: 'in_progress' },
        ],
      }),
      context,
    );
    expect(recorded.map((todo) => todo.status)).toEqual(['done', 'cancelled', 'in_progress']);
    expect(result).toContain('1/3 done');
    expect(result).toContain('1 cancelled');
  });
});

describe('use_skill files listing', () => {
  it('returns the body plus skill files and the absolute base directory', async () => {
    const skillDir = path.join(root, '.dev-first', 'skills', 'greet');
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Greet\nSay hello politely.\n', 'utf-8');
    await fs.writeFile(path.join(skillDir, 'references', 'style.md'), 'Style notes.\n', 'utf-8');
    await fs.writeFile(path.join(skillDir, 'scripts', 'run.sh'), 'echo hi\n', 'utf-8');

    const result = await toolbox(root).execute('use_skill', JSON.stringify({ name: 'greet' }), context);
    expect(result).toContain('# Greet');
    expect(result).toContain('<skill_files>');
    expect(result).toContain('- references/style.md');
    expect(result).toContain('- scripts/run.sh');
    expect(result).not.toContain('- SKILL.md');
    expect(result).toContain(`Base directory: ${skillDir}`);
  });

  it('caps the file list at ten entries', async () => {
    const skillDir = path.join(root, '.dev-first', 'skills', 'many');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Many\n', 'utf-8');
    for (let index = 0; index < 12; index++) {
      await fs.writeFile(path.join(skillDir, `file-${String(index).padStart(2, '0')}.md`), 'x\n', 'utf-8');
    }
    const result = await toolbox(root).execute('use_skill', JSON.stringify({ name: 'many' }), context);
    const listed = result.split('\n').filter((line) => line.startsWith('- '));
    expect(listed).toHaveLength(10);
  });

  it('still supports legacy single-file skills', async () => {
    const skillsDir = path.join(root, '.dev-first', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'simple.md'), '# Simple\nDo the thing.\n', 'utf-8');
    const result = await toolbox(root).execute('use_skill', JSON.stringify({ name: 'simple' }), context);
    expect(result).toContain('Do the thing.');
    expect(result).toContain('(no other files)');
  });
});
