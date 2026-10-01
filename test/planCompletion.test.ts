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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-plan-completion-test' } }],
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

import type { HostMessage, Plan, TodoItem } from '../src/shared/protocol';
import { SessionController } from '../src/session/SessionController';
import { shouldDockPlan } from '../webview/src/lib/planDock';

const CHANGES = [
  { path: 'src/a.ts', additions: 2, deletions: 1, isNew: false, isDeleted: false },
];

function createController(posted: HostMessage[]): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-plan-completion-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-plan-completion-test-global-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => CHANGES,
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => true,
    setRunContext: () => undefined,
    setFileSummaries: () => undefined,
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
    steps: ['Add a retry helper', 'Wire it into the client'],
  };
}

function setPlan(controller: SessionController, plan: Plan | null): void {
  (controller as unknown as { plan: Plan | null }).plan = plan;
}

function setTodos(controller: SessionController, todos: TodoItem[]): void {
  (controller as unknown as { todos: TodoItem[] }).todos = todos;
}

function toolSse(name: string, args: Record<string, unknown>): string {
  const chunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: `call_${name}`,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

function stubFetch(responses: string[]): void {
  let index = 0;
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).includes('chat/completions')) {
      const response = responses[index++] ?? responses[responses.length - 1];
      return new Response(response, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200 });
  });
}

function posts<T extends HostMessage['type']>(posted: HostMessage[], type: T) {
  return posted.filter((message): message is Extract<HostMessage, { type: T }> => message.type === type);
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-plan-completion-test-home');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('run completion plan lifecycle', () => {
  it('completes the plan, clears the dock, and carries the snapshot in the completion message', async () => {
    stubFetch([
      toolSse('finish', {
        summary: 'Done — added retry.',
        files: [{ path: 'src/a.ts', summary: 'added retry handling' }],
      }),
    ]);
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    setPlan(controller, draftPlan());
    setTodos(controller, [
      { text: 'Add a retry helper', status: 'done' },
      { text: 'Wire it into the client', status: 'in_progress' },
    ]);

    await controller.handleMessage({ type: 'approvePlan' });

    const planPosts = posts(posted, 'plan');
    const completedPost = planPosts.find((message) => message.plan?.status === 'completed');
    expect(completedPost?.plan?.title).toBe('Add retry handling');
    expect(planPosts[planPosts.length - 1]).toEqual({ type: 'plan', plan: null });

    const completion = posts(posted, 'addMessage')
      .map((message) => message.message)
      .find((message) => message.kind === 'completion');
    expect(completion?.planSnapshot).toEqual({
      title: 'Add retry handling',
      steps: ['Add a retry helper', 'Wire it into the client'],
    });

    expect(controller.getState().plan).toBeNull();
    expect(controller.getState().todos).toEqual([]);

    const todoPosts = posts(posted, 'todos');
    expect(todoPosts.some((message) => message.todos.every((todo) => todo.status === 'done'))).toBe(true);
    expect(todoPosts[todoPosts.length - 1]).toEqual({ type: 'todos', todos: [] });

    const completedPlan: Plan = { ...draftPlan(), status: 'completed' };
    expect(shouldDockPlan(controller.getState().phase, completedPlan)).toBe(false);
    controller.dispose();
  });

  it('completes and clears the plan when the run fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('boom');
    });
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    setPlan(controller, draftPlan());

    await controller.handleMessage({ type: 'approvePlan' });

    expect(posts(posted, 'plan').some((message) => message.plan?.status === 'completed')).toBe(true);
    expect(controller.getState().plan).toBeNull();
    controller.dispose();
  });

  it('clears a completed plan before sending the next message', async () => {
    stubFetch([
      toolSse('submit_plan', {
        intent: 'plan',
        what: 'Add caching.',
        steps: ['Add a cache helper'],
      }),
    ]);
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    setPlan(controller, { ...draftPlan(), status: 'completed' });

    await controller.handleMessage({ type: 'sendMessage', text: 'add caching next' });

    const planPosts = posts(posted, 'plan');
    const cleared = planPosts.findIndex((message) => message.plan === null);
    const nextDraft = planPosts.findIndex((message) => message.plan?.status === 'draft');
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(nextDraft).toBeGreaterThan(cleared);
    expect(controller.getState().plan?.status).toBe('draft');
    controller.dispose();
  });
});
