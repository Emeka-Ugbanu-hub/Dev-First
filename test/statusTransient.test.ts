import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
}));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => env.config[key] ?? fallback,
        update: async () => undefined,
      }),
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-status-test' } }],
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

import type { HostMessage, Plan } from '../src/shared/protocol';
import { SessionController } from '../src/session/SessionController';

function createController(posted: HostMessage[]): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-status-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-status-test-global-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => false,
    setRunContext: () => undefined,
    setFileSummaries: () => undefined,
    acceptAllChanges: () => undefined,
    getPendingChanges: () => [],
  } as never;
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

function draftPlan(): Plan {
  return {
    version: 1,
    status: 'draft',
    intent: 'plan',
    title: 'Add retry handling',
    what: 'Retry failed requests',
    steps: ['Add a retry helper'],
  };
}

function setPlan(controller: SessionController, plan: Plan | null): void {
  (controller as unknown as { plan: Plan | null }).plan = plan;
}

function posts<T extends HostMessage['type']>(posted: HostMessage[], type: T) {
  return posted.filter((message): message is Extract<HostMessage, { type: T }> => message.type === type);
}

function finishSse(): string {
  const chunk = JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_finish', function: { name: 'finish', arguments: '{}' } }] } }],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

function stubFetch(responses: Response[]): void {
  let index = 0;
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).includes('chat/completions')) {
      return responses[Math.min(index++, responses.length - 1)];
    }
    return new Response('{}', { status: 200 });
  });
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-status-test-home');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('transient status messages', () => {
  it('updates one status id and never adds it to message history', () => {
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    const api = controller as unknown as {
      setStatus(id: string, text: string, tone?: 'progress' | 'error', done?: boolean): void;
    };

    api.setStatus('retry', 'Retrying attempt 1…');
    api.setStatus('retry', 'Retrying attempt 2…');

    expect(posts(posted, 'status')).toEqual([
      { type: 'status', id: 'retry', text: 'Retrying attempt 1…', tone: 'progress', done: false },
      { type: 'status', id: 'retry', text: 'Retrying attempt 2…', tone: 'progress', done: false },
    ]);
    expect(posts(posted, 'addMessage')).toEqual([]);
    expect(controller.getState().messages).toEqual([]);

    api.setStatus('retry', '', undefined, true);
    expect(posts(posted, 'status')[2]).toEqual({
      type: 'status',
      id: 'retry',
      text: '',
      tone: 'progress',
      done: true,
    });

    api.setStatus('retry', '', undefined, true);
    expect(posts(posted, 'status')).toHaveLength(3);
    controller.dispose();
  });

  it('posts one retry status row during a run and clears it instead of notices', async () => {
    stubFetch([
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
      new Response(finishSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ]);
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    setPlan(controller, draftPlan());

    await controller.handleMessage({ type: 'approvePlan' });

    const statusPosts = posts(posted, 'status');
    expect(
      statusPosts.some((status) => status.id === 'retry' && status.text === 'Retrying attempt 1…' && !status.done),
    ).toBe(true);
    expect(statusPosts[statusPosts.length - 1]).toEqual({
      type: 'status',
      id: 'retry',
      text: '',
      tone: 'progress',
      done: true,
    });

    const notices = posts(posted, 'addMessage')
      .map((message) => message.message)
      .filter((message) => message.role === 'notice');
    expect(notices.some((message) => /retrying/i.test(message.text))).toBe(false);
    expect(controller.getState().messages.some((message) => /retrying/i.test(message.text))).toBe(false);
    controller.dispose();
  });
});
