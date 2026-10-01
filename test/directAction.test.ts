import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-direct-action-test' } }],
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
import { AgentService } from '../src/agent/AgentService';
import { SessionStore } from '../src/session/SessionStore';

interface ControllerOptions {
  storage?: string;
  runContext?: ReturnType<typeof vi.fn>;
}

function createController(posted: HostMessage[], options: ControllerOptions = {}): SessionController {
  const storage = options.storage ?? `/tmp/dev-first-direct-action-${Math.random().toString(36).slice(2)}`;
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-direct-action-test' },
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
    setRunContext: options.runContext ?? (() => undefined),
    setFileSummaries: () => undefined,
  } as never;
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

function planVersion(controller: SessionController): number {
  return (controller as unknown as { planVersion: number }).planVersion;
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

function noticeTexts(posted: HostMessage[]): string[] {
  return posts(posted, 'addMessage')
    .map((message) => message.message)
    .filter((message) => message.role === 'notice')
    .map((message) => message.text);
}

function draftPlan(): Plan {
  return { version: 1, status: 'draft', intent: 'plan', title: 'Retry handling', steps: ['Add a retry helper'] };
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-direct-action-test-home');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('direct trivial runs', () => {
  it('executes a trivial plan immediately with no plan card and no version bump', async () => {
    stubFetch([
      toolSse('submit_plan', { intent: 'plan', trivial: true, steps: ['Rename the flag'] }),
    ]);
    const run = vi.spyOn(AgentService.prototype, 'run').mockResolvedValue({ reachedLimit: false });
    const runContext = vi.fn();
    const posted: HostMessage[] = [];
    const controller = createController(posted, { runContext });

    await controller.handleMessage({ type: 'sendMessage', text: 'rename the flag' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ trivial: true, steps: ['Rename the flag'] });
    expect(runContext).toHaveBeenCalledTimes(1);
    expect(planVersion(controller)).toBe(0);
    expect(posts(posted, 'plan')).toEqual([]);
    expect(controller.getState().plan).toBeNull();
    expect(noticeTexts(posted)).toContain('Trivial change — running it now: Rename the flag');
    expect(posts(posted, 'phase').some((message) => message.phase === 'executing')).toBe(true);
    controller.dispose();
  });

  it('never starts the executor for a non-trivial plan before handleApprove', async () => {
    stubFetch([
      toolSse('submit_plan', { intent: 'plan', what: 'Add retries', steps: ['Add a retry helper', 'Wire it in'] }),
    ]);
    const run = vi.spyOn(AgentService.prototype, 'run').mockResolvedValue({ reachedLimit: false });
    const posted: HostMessage[] = [];
    const controller = createController(posted);

    await controller.handleMessage({ type: 'sendMessage', text: 'add retries' });

    expect(run).not.toHaveBeenCalled();
    expect(controller.getState().plan?.status).toBe('draft');
    expect(planVersion(controller)).toBe(1);
    expect(posts(posted, 'plan').some((message) => message.plan?.status === 'draft')).toBe(true);
    const approved = controller.getState().plan;

    await controller.handleMessage({ type: 'approvePlan' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(approved);
    controller.dispose();
  });
});

describe('restored plans', () => {
  it('drops a restored approved plan but restores a draft', async () => {
    const approvedStorage = `/tmp/dev-first-restore-approved-${Math.random().toString(36).slice(2)}`;
    await new SessionStore(path.join(approvedStorage, 'sessions')).save({
      id: 's_approved',
      title: 'Approved plan',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      conversation: [],
      plan: { ...draftPlan(), status: 'approved' },
      todos: [],
      planVersion: 2,
      lastRequest: 'add retries',
      contextTokens: 0,
    });
    const approvedController = createController([], { storage: approvedStorage });
    await vi.waitFor(() => expect(approvedController.getState().sessionTitle).toBe('Approved plan'));
    expect(approvedController.getState().plan).toBeNull();
    approvedController.dispose();

    const draftStorage = `/tmp/dev-first-restore-draft-${Math.random().toString(36).slice(2)}`;
    await new SessionStore(path.join(draftStorage, 'sessions')).save({
      id: 's_draft',
      title: 'Draft plan',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      conversation: [],
      plan: draftPlan(),
      todos: [],
      planVersion: 1,
      lastRequest: 'add retries',
      contextTokens: 0,
    });
    const draftController = createController([], { storage: draftStorage });
    await vi.waitFor(() => expect(draftController.getState().sessionTitle).toBe('Draft plan'));
    expect(draftController.getState().plan?.status).toBe('draft');
    draftController.dispose();
  });
});
