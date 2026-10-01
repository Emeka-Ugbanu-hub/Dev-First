import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
  statusMessages: [] as Array<{ text: string; timeout: number | undefined }>,
  executed: [] as unknown[][],
  historyListener: undefined as (() => void) | undefined,
  diff: {
    runId: undefined as string | undefined,
    files: [] as Array<{
      path: string;
      status: 'modified' | 'added' | 'deleted';
      additions: number;
      deletions: number;
    }>,
    content: new Set<string>(),
    viewable: [] as string[],
  },
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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-changed-files-test' } }],
      asRelativePath: (value: string) => value,
    },
    window: {
      onDidChangeTextEditorSelection: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      visibleTextEditors: [],
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
      setStatusBarMessage: (text: string, timeout?: number) => {
        env.statusMessages.push({ text, timeout });
        return disposable;
      },
    },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        env.executed.push(args);
      },
      registerCommand: () => disposable,
    },
    Uri: {
      file: (filePath: string) => ({ scheme: 'file', fsPath: filePath }),
      from: (parts: { scheme: string; path: string; query?: string }) => ({
        ...parts,
        fsPath: parts.path,
      }),
    },
    ConfigurationTarget: { Global: 1 },
  };
});

import type { HostMessage, Plan } from '../src/shared/protocol';
import { SessionController } from '../src/session/SessionController';
import { OriginalContentProvider } from '../src/diff/OriginalContentProvider';

function createController(posted: HostMessage[], options: { withHistory?: boolean } = {}): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-changed-files-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-changed-files-test-global-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => env.diff.runId,
    hasPendingChanges: () => false,
    setRunContext: () => undefined,
    setFileSummaries: () => undefined,
    runFiles: (runId: string) => (runId === env.diff.runId ? env.diff.files : []),
    viewableRunIds: () => env.diff.viewable,
    hasDiffContent: (runId: string, filePath: string) => env.diff.content.has(`${runId}:${filePath}`),
    ...(options.withHistory
      ? {
          onDidChangeHistory: (listener: () => void) => {
            env.historyListener = listener;
            return { dispose() {} };
          },
        }
      : {}),
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

function toolSse(name: string, args: Record<string, unknown>): string {
  const chunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  env.statusMessages = [];
  env.executed = [];
  env.historyListener = undefined;
  env.diff = { runId: undefined, files: [], content: new Set(), viewable: [] };
  vi.stubEnv('HOME', '/tmp/dev-first-changed-files-test-home');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('completion changed files', () => {
  it('attaches changedFiles and runId to the completion message and exposes viewableRuns', async () => {
    env.diff.runId = 'run1';
    env.diff.viewable = ['run1'];
    env.diff.files = [
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 3 },
    ];
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (String(url).includes('chat/completions')) {
        return new Response(
          toolSse('finish', { summary: 'Done — added retry.', files: [] }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('{}', { status: 200 });
    });
    const posted: HostMessage[] = [];
    const controller = createController(posted, { withHistory: true });
    (controller as unknown as { plan: Plan | null }).plan = draftPlan();

    await controller.handleMessage({ type: 'approvePlan' });

    const completion = posted
      .filter((message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage')
      .map((message) => message.message)
      .find((message) => message.kind === 'completion');
    expect(completion?.runId).toBe('run1');
    expect(completion?.changedFiles).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 3 },
    ]);
    expect(controller.getState().viewableRuns).toEqual(['run1']);
    controller.dispose();
  });

  it('posts state with viewableRuns when the run history changes', () => {
    env.diff.viewable = ['run1'];
    const posted: HostMessage[] = [];
    const controller = createController(posted, { withHistory: true });

    env.historyListener?.();

    const state = posted.filter((message) => message.type === 'state').at(-1);
    expect(state?.type === 'state' && state.state.viewableRuns).toEqual(['run1']);
    controller.dispose();
  });

  it('omits changedFiles when the run has none', async () => {
    env.diff.runId = 'run1';
    vi.stubGlobal('fetch', async (url: string | URL) => {
      if (String(url).includes('chat/completions')) {
        return new Response(
          toolSse('finish', { summary: 'Done.', files: [] }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('{}', { status: 200 });
    });
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    (controller as unknown as { plan: Plan | null }).plan = draftPlan();

    await controller.handleMessage({ type: 'approvePlan' });

    const completion = posted
      .filter((message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage')
      .map((message) => message.message)
      .find((message) => message.kind === 'completion');
    expect(completion?.runId).toBe('run1');
    expect(completion?.changedFiles).toBeUndefined();
    controller.dispose();
  });
});

describe('openFileDiff', () => {
  it('shows a status bar message and nothing else when the diff is gone', async () => {
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'openFileDiff', path: 'src/a.ts', runId: 'run1' });

    expect(env.statusMessages).toEqual([{ text: 'Dev-First: diff no longer available', timeout: 3000 }]);
    expect(env.executed).toEqual([]);
    controller.dispose();
  });

  it('opens a native diff against the run-scoped original for modified files', async () => {
    env.diff.runId = 'run1';
    env.diff.content.add('run1:src/a.ts');
    env.diff.files = [{ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 }];
    const controller = createController([]);
    await controller.handleMessage({ type: 'openFileDiff', path: 'src/a.ts', runId: 'run1' });

    const call = env.executed.find((args) => args[0] === 'vscode.diff');
    expect(call).toBeTruthy();
    const expectedLeft = OriginalContentProvider.uriFor('src/a.ts', 'run1');
    expect(call![1]).toEqual(expectedLeft);
    expect(call![2]).toEqual({ scheme: 'file', fsPath: '/tmp/dev-first-changed-files-test/src/a.ts' });
    expect(env.statusMessages).toEqual([]);
    controller.dispose();
  });

  it('uses an empty left side for added files and an empty right side for deleted files', async () => {
    env.diff.runId = 'run1';
    env.diff.content.add('run1:src/new.ts');
    env.diff.content.add('run1:src/gone.ts');
    env.diff.files = [
      { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 },
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 3 },
    ];
    const controller = createController([]);
    await controller.handleMessage({ type: 'openFileDiff', path: 'src/new.ts', runId: 'run1' });
    await controller.handleMessage({ type: 'openFileDiff', path: 'src/gone.ts', runId: 'run1' });

    const calls = env.executed.filter((args) => args[0] === 'vscode.diff');
    expect(calls).toHaveLength(2);
    expect(calls[0][1].query).toBe('empty=1');
    expect(calls[0][2]).toEqual({ scheme: 'file', fsPath: '/tmp/dev-first-changed-files-test/src/new.ts' });
    expect(calls[1][1].query).toBe('runId=run1');
    expect(calls[1][2].query).toBe('empty=1');
    controller.dispose();
  });
});

describe('OriginalContentProvider', () => {
  it('serves run-scoped originals, empty documents, and legacy pending originals', () => {
    const provider = new OriginalContentProvider({
      getRunOriginal: (runId: string, relPath: string) => `${runId}:${relPath}`,
      getOriginalContent: (relPath: string) => `pending:${relPath}`,
    } as never);

    expect(provider.provideTextDocumentContent(OriginalContentProvider.uriFor('src/a.ts', 'run1'))).toBe(
      'run1:src/a.ts',
    );
    expect(provider.provideTextDocumentContent(OriginalContentProvider.uriFor('src/a.ts'))).toBe(
      'pending:src/a.ts',
    );
    expect(provider.provideTextDocumentContent(OriginalContentProvider.emptyUri('src/a.ts'))).toBe('');
    expect(provider.provideTextDocumentContent(OriginalContentProvider.uriFor('src/missing.ts', 'gone'))).toBe(
      'gone:src/missing.ts',
    );
  });

  it('returns an empty string when the run original is unavailable', () => {
    const provider = new OriginalContentProvider({
      getRunOriginal: () => undefined,
      getOriginalContent: () => undefined,
    } as never);
    expect(provider.provideTextDocumentContent(OriginalContentProvider.uriFor('src/a.ts', 'gone'))).toBe('');
  });
});
