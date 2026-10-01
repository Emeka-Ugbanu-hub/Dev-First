import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  BackgroundEntry,
  BackgroundProcesses,
  formatTrackedProcesses,
} from '../src/agent/BackgroundProcesses';
import { ToolBox } from '../src/agent/ToolBox';
import { executionTools, plannerTools, readOnlyTools } from '../src/agent/tools';

function toolbox(backgroundProcesses?: BackgroundProcesses): ToolBox {
  return new ToolBox({ root: process.cwd(), backgroundProcesses } as any);
}

const context = { requestTerminalApproval: async () => 'deny' as const };

function entry(overrides: Partial<BackgroundEntry> = {}): BackgroundEntry {
  return {
    id: 'bg_test',
    name: 'api',
    command: 'node server.js',
    status: 'running',
    exitCode: null,
    startedAt: 1_700_000_000_000,
    output: '',
    ...overrides,
  };
}

describe('formatTrackedProcesses', () => {
  it('reports the empty case', () => {
    expect(formatTrackedProcesses([])).toBe('No background processes are tracked by Dev-First.');
  });

  it('includes name, command, start time, status, and readiness info', () => {
    const text = formatTrackedProcesses([
      entry({ status: 'ready', readyPort: 3000, readyPattern: 'listening' }),
    ]);
    expect(text).toContain('api');
    expect(text).toContain('node server.js');
    expect(text).toContain(new Date(1_700_000_000_000).toISOString());
    expect(text).toContain('ready');
    expect(text).toContain('port 3000');
    expect(text).toContain('ready pattern /listening/');
  });

  it('prints exited processes with their code', () => {
    const text = formatTrackedProcesses([entry({ status: 'exited', exitCode: 2 })]);
    expect(text).toContain('exited(2)');
  });
});

describe('list_processes tool', () => {
  it('answers the empty case', async () => {
    expect(await toolbox().execute('list_processes', '{}', context)).toBe(
      'No background processes are tracked by Dev-First.',
    );
    expect(await toolbox(new BackgroundProcesses(process.cwd())).execute('list_processes', '{}', context)).toBe(
      'No background processes are tracked by Dev-First.',
    );
  });

  it('lists tracked processes with status and exit code', async () => {
    const bg = new BackgroundProcesses(process.cwd());
    const child = new EventEmitter() as unknown as ChildProcess;
    bg.adopt('web', 'npm run dev -- --port 5173', child);

    const running = await toolbox(bg).execute('list_processes', '{}', context);
    expect(running).toContain('web');
    expect(running).toContain('npm run dev -- --port 5173');
    expect(running).toContain('running');

    child.emit('exit', 1);
    const exited = await toolbox(bg).execute('list_processes', '{}', context);
    expect(exited).toContain('exited(1)');
  });
});

describe('tool registries', () => {
  it('exposes list_processes to the planner and executor', () => {
    expect(readOnlyTools().map((tool) => tool.name)).toContain('list_processes');
    expect(executionTools().map((tool) => tool.name)).toContain('list_processes');
  });

  it('gives the planner run_terminal_command without duplicating it in execution', () => {
    const plannerNames = plannerTools().map((tool) => tool.name);
    expect(plannerNames).toContain('run_terminal_command');
    expect(plannerNames).toContain('list_processes');
    expect(executionTools().filter((tool) => tool.name === 'run_terminal_command')).toHaveLength(1);
  });
});
