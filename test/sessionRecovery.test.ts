import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
  fetchCalls: 0,
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
      workspaceFolders: [],
      asRelativePath: (value: string) => value,
    },
    window: {
      onDidChangeTextEditorSelection: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      visibleTextEditors: [],
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
      setStatusBarMessage: () => disposable,
    },
    commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
    Uri: {
      file: (filePath: string) => ({ scheme: 'file', fsPath: filePath }),
      from: (parts: { scheme: string; path: string; query?: string }) => ({ ...parts, fsPath: parts.path }),
    },
    ConfigurationTarget: { Global: 1 },
  };
});

import type { HostMessage, RunRecord } from '../src/shared/protocol';
import { SessionController } from '../src/session/SessionController';
import { SessionStore } from '../src/session/SessionStore';
import { RunJournalStore } from '../src/session/RunJournalStore';

function runRecord(id: string, sessionId: string): RunRecord {
  const now = Date.now();
  return {
    id,
    sessionId,
    request: 'finish the task',
    provider: 'openai',
    model: 'gpt-4o',
    status: 'executing',
    planVersion: 1,
    stepIndex: 1,
    completedSteps: [0],
    workspaceHash: 'hash',
    operations: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  env.fetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    env.fetchCalls += 1;
    return new Response('{}', { status: 200 });
  });
  vi.stubEnv('HOME', '/tmp/dev-first-session-recovery-home');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('SessionController recovery', () => {
  it('restores queued prompts without executing them and surfaces interrupted runs', async () => {
    const storage = await mkdtemp(path.join(tmpdir(), 'df-recovery-'));
    const workspace = await mkdtemp(path.join(tmpdir(), 'df-recovery-ws-'));
    try {
      const store = new SessionStore(path.join(storage, 'sessions'));
      await store.save({
        id: 's1',
        title: 'Recovered',
        createdAt: 1,
        updatedAt: 2,
        messages: [
          { id: 'q1', role: 'user', text: 'queued hello', queued: true },
          { id: 'q2', role: 'user', text: 'done hello', queued: true },
        ],
        conversation: [],
        plan: null,
        todos: [],
        planVersion: 0,
        lastRequest: '',
        contextTokens: 0,
        queued: [
          { id: 'q1', text: 'queued hello', status: 'queued', createdAt: 1 },
          { id: 'q2', text: 'done hello', status: 'completed', createdAt: 2 },
        ],
      });
      const runs = new RunJournalStore(path.join(storage, 'runs'));
      await runs.save(runRecord('r1', 's1'));

      const context = {
        subscriptions: [],
        extensionUri: { fsPath: workspace },
        globalStorageUri: { fsPath: storage },
        secrets: { get: async () => env.secret, store: async () => undefined },
        workspaceState: {
          get: (key: string) => (key === 'devFirst.activeSessionId' ? 's1' : undefined),
          update: async () => undefined,
        },
        globalState: { get: () => undefined, update: async () => undefined },
      } as never;
      const diffManager = {
        onDidChangePendingChanges: () => ({ dispose() {} }),
        getChangeSummaries: () => [],
        getCurrentRunId: () => undefined,
        hasPendingChanges: () => false,
      } as never;
      const posted: HostMessage[] = [];
      const controller = new SessionController(context, (message) => posted.push(message), diffManager);

      await waitFor(() => (controller as unknown as { queuedMessages: unknown[] }).queuedMessages.length === 1);
      expect(controller.getState().phase).toBe('idle');
      expect(env.fetchCalls).toBe(0);

      const queued = controller.getState().queued;
      expect(queued?.map((record) => record.id)).toEqual(['q1']);
      expect(queued?.[0].status).toBe('queued');

      await waitFor(() => controller.getState().recovery !== undefined);
      expect(controller.getState().recovery?.run.id).toBe('r1');
      expect(controller.getState().recovery?.run.status).toBe('interrupted');
      expect((await runs.load('r1'))?.status).toBe('interrupted');
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
