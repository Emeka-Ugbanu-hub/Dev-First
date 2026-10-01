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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-plan-discard-test' } }],
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
  const storage = `/tmp/dev-first-plan-discard-test-global-${Math.random().toString(36).slice(2)}`;
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-plan-discard-test' },
    globalStorageUri: { fsPath: storage },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => false,
  } as never;
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

function draftPlan(): Plan {
  return { version: 1, status: 'draft', intent: 'plan', what: 'Add retry handling', steps: ['Add a retry helper'] };
}

function setPlan(controller: SessionController, plan: Plan | null): void {
  (controller as unknown as { plan: Plan | null }).plan = plan;
}

function getPlanVersion(controller: SessionController): number {
  return (controller as unknown as { planVersion: number }).planVersion;
}

function dismissPlanSse(): string {
  const chunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              function: { name: 'dismiss_plan', arguments: '{}' },
            },
          ],
        },
      },
    ],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

function stubFetch(sse: string): void {
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).includes('chat/completions')) {
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200 });
  });
}

function postedText(posted: HostMessage[], role: 'notice' | 'assistant'): string[] {
  return posted
    .filter((message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage')
    .map((message) => message.message)
    .filter((message) => message.role === role)
    .map((message) => message.text);
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-plan-discard-test-home');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('discardPlan', () => {
  it('clears the plan, posts plan null, and does not bump planVersion', async () => {
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    setPlan(controller, draftPlan());
    (controller as unknown as { planVersion: number }).planVersion = 3;
    const messagesBefore = controller.getState().messages.length;

    await controller.handleMessage({ type: 'discardPlan' });

    expect(controller.getState().plan).toBeNull();
    expect(getPlanVersion(controller)).toBe(3);
    expect(posted).toContainEqual({ type: 'plan', plan: null });
    expect(controller.getState().messages.length).toBe(messagesBefore);
    expect(posted.some((message) => message.type === 'addMessage')).toBe(false);
    controller.dispose();
  });
});

describe('dismiss_plan handling', () => {
  it('clears the draft and posts the discard confirmation', async () => {
    stubFetch(dismissPlanSse());
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    setPlan(controller, draftPlan());
    (controller as unknown as { planVersion: number }).planVersion = 2;

    await controller.handleMessage({ type: 'sendMessage', text: 'cancel the plan' });

    expect(controller.getState().plan).toBeNull();
    expect(getPlanVersion(controller)).toBe(2);
    expect(posted).toContainEqual({ type: 'plan', plan: null });
    expect(postedText(posted, 'notice')).toContain('Draft plan discarded — nothing was changed.');
    controller.dispose();
  });

  it('replies briefly when there is no draft to discard', async () => {
    stubFetch(dismissPlanSse());
    const posted: HostMessage[] = [];
    const controller = createController(posted);

    await controller.handleMessage({ type: 'sendMessage', text: 'forget the draft plan' });

    expect(controller.getState().plan).toBeNull();
    expect(getPlanVersion(controller)).toBe(0);
    expect(postedText(posted, 'notice')).toContain('There is no draft plan to discard.');
    expect(posted.some((message) => message.type === 'plan')).toBe(false);
    controller.dispose();
  });
});
