import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    workspace: {
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: async () => undefined }),
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
      workspaceFolders: [],
      asRelativePath: (value: string) => value,
    },
    window: {
      onDidChangeTextEditorSelection: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      visibleTextEditors: [],
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
    },
    commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
    ConfigurationTarget: { Global: 1 },
  };
});

import { AgentService } from '../src/agent/AgentService';
import type { ToolBox } from '../src/agent/ToolBox';
import { HttpError } from '../src/llm/errors';
import type { LLMProvider, StreamEvent } from '../src/llm/types';
import type { Plan } from '../src/shared/protocol';

interface StatusRecord {
  id: string;
  text: string;
  tone?: 'progress' | 'error';
  done: boolean;
}

function flakyProvider(failures: number): LLMProvider & { attempts: number } {
  const provider = {
    id: 'flaky',
    attempts: 0,
    async *chat(): AsyncIterable<StreamEvent> {
      provider.attempts++;
      if (provider.attempts <= failures) {
        throw new HttpError(429, 'rate limited');
      }
      yield { type: 'text', text: 'All set.' };
      yield { type: 'done' };
    },
  };
  return provider as unknown as LLMProvider & { attempts: number };
}

function recorder() {
  const statuses: StatusRecord[] = [];
  const notices: string[] = [];
  return {
    statuses,
    notices,
    callbacks: {
      onTextDelta: () => undefined,
      onToolActivity: () => undefined,
      requestTerminalApproval: async () => 'deny' as const,
      onNotice: (text: string) => notices.push(text),
      onStatus: (id: string, text: string, tone?: 'progress' | 'error', done?: boolean) => {
        statuses.push({ id, text, tone, done: Boolean(done) });
      },
    },
  };
}

function approvedPlan(): Plan {
  return { version: 1, status: 'approved', steps: ['Do the thing'] };
}

function serviceFor(provider: LLMProvider): AgentService {
  return new AgentService(provider, 'test-model', {} as ToolBox, {
    maxSteps: 1,
    tools: [],
    autoCompact: false,
    contextLimitTokens: 100000,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('agent retry status', () => {
  it('posts progress on a stable id and clears it on success', async () => {
    vi.useFakeTimers();
    const provider = flakyProvider(2);
    const rec = recorder();

    const running = serviceFor(provider).run(approvedPlan(), 'do it', new AbortController().signal, rec.callbacks);
    await vi.runAllTimersAsync();
    await running;

    expect(provider.attempts).toBe(3);
    const progress = rec.statuses.filter((status) => !status.done);
    expect(progress.map((status) => status.id)).toEqual(['retry', 'retry']);
    expect(progress.map((status) => status.text)).toEqual(['Retrying attempt 1…', 'Retrying attempt 2…']);
    expect(rec.statuses[rec.statuses.length - 1]).toEqual({
      id: 'retry',
      text: '',
      tone: undefined,
      done: true,
    });
    expect(rec.notices.some((notice) => /retrying/i.test(notice))).toBe(false);
  });

  it('clears the status on final failure and records no retry notices', async () => {
    vi.useFakeTimers();
    const provider = flakyProvider(10);
    const rec = recorder();

    const running = serviceFor(provider).run(approvedPlan(), 'do it', new AbortController().signal, rec.callbacks);
    const failure = expect(running).rejects.toThrow('rate limited');
    await vi.runAllTimersAsync();
    await failure;

    expect(provider.attempts).toBe(4);
    expect(rec.statuses.filter((status) => !status.done).map((status) => status.text)).toEqual([
      'Retrying attempt 1…',
      'Retrying attempt 2…',
      'Retrying attempt 3…',
    ]);
    expect(rec.statuses[rec.statuses.length - 1].done).toBe(true);
    expect(rec.notices.some((notice) => /retrying/i.test(notice))).toBe(false);
  });
});
