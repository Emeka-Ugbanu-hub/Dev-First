import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
  changes: [] as Array<{
    path: string;
    additions: number;
    deletions: number;
    isNew: boolean;
    isDeleted: boolean;
  }>,
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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-review-empty-test' } }],
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

import type { HostMessage } from '../src/shared/protocol';
import { SessionController } from '../src/session/SessionController';

function createController(posted: HostMessage[]): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-review-empty-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-review-empty-test-global-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => env.changes,
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => env.changes.length > 0,
  } as never;
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

function addedMessages(posted: HostMessage[]) {
  return posted.filter(
    (message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage',
  );
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  env.changes = [];
  vi.stubEnv('HOME', '/tmp/dev-first-review-empty-test-home');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('empty review actions', () => {
  it('openMultiDiff does nothing at all when there are no changes', async () => {
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    const before = controller.getState().messages.length;

    await controller.handleMessage({ type: 'reviewChanges' });

    expect(addedMessages(posted)).toEqual([]);
    expect(controller.getState().messages.length).toBe(before);
    controller.dispose();
  });

  it('summarize and cross-file review do nothing at all when there are no changes', async () => {
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    const before = controller.getState().messages.length;

    await controller.handleMessage({ type: 'summarizeReview' });
    await controller.handleMessage({ type: 'reviewAcrossFiles' });

    expect(addedMessages(posted)).toEqual([]);
    expect(controller.getState().messages.length).toBe(before);
    controller.dispose();
  });

  it('treats deleted-only changes as nothing to review', async () => {
    env.changes = [{ path: 'src/gone.ts', additions: 0, deletions: 4, isNew: false, isDeleted: true }];
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    const before = controller.getState().messages.length;

    await controller.handleMessage({ type: 'reviewChanges' });
    await controller.handleMessage({ type: 'summarizeReview' });
    await controller.handleMessage({ type: 'reviewAcrossFiles' });

    expect(addedMessages(posted)).toEqual([]);
    expect(controller.getState().messages.length).toBe(before);
    controller.dispose();
  });
});
