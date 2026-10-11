import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
  workspace: '',
  statusMessages: [] as string[],
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
      get workspaceFolders() {
        return [{ uri: { fsPath: env.workspace } }];
      },
      asRelativePath: (value: string) => value,
    },
    window: {
      onDidChangeTextEditorSelection: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      visibleTextEditors: [],
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
      setStatusBarMessage: (text: string) => {
        env.statusMessages.push(text);
        return disposable;
      },
    },
    commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
    Uri: {
      file: (filePath: string) => ({ scheme: 'file', fsPath: filePath }),
      from: (parts: { scheme: string; path: string; query?: string }) => ({
        ...parts,
        fsPath: parts.path,
        toString: () => `dev-first-original:${parts.path}?${parts.query ?? ''}`,
      }),
    },
    ConfigurationTarget: { Global: 1 },
  };
});

import type { HostMessage, PendingDecisionRecord, QueuedPromptRecord, RunRecord } from '../src/shared/protocol';
import type { ToolCall } from '../src/llm/types';
import { SessionController } from '../src/session/SessionController';
import { SessionStore } from '../src/session/SessionStore';
import { RunJournalStore } from '../src/session/RunJournalStore';
import { questionAnswerId, validateRecoveredAnswers } from '../src/session/runRecovery';

function runRecord(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const now = Date.now();
  return {
    id,
    sessionId: 's1',
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
    ...overrides,
  };
}

function questionPending(overrides: Partial<PendingDecisionRecord> = {}): PendingDecisionRecord {
  return {
    id: 'q1',
    kind: 'question',
    prompt: 'Which database?',
    requestId: 'q1',
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    allowCustom: true,
    createdAt: 5,
    ...overrides,
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

async function waitForAsync(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await check()).toBe(true);
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  env.statusMessages = [];
  vi.stubEnv('HOME', '/tmp/dev-first-question-recovery-home');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('questionAnswerId', () => {
  it('namespaces batch questions by request id with an index fallback', () => {
    expect(questionAnswerId({ id: 'p1', requestId: 'q1' }, 2)).toBe('q1:2');
    expect(questionAnswerId({ id: 'p1' }, 0)).toBe('p1:0');
  });
});

describe('validateRecoveredAnswers', () => {
  it('accepts option labels and rejects unknown labels when custom is disabled', () => {
    const pending = questionPending({ allowCustom: false });
    expect(validateRecoveredAnswers(pending, [{ value: 'Postgres' }])).toBe(true);
    expect(validateRecoveredAnswers(pending, [{ value: 'MySQL' }])).toBe(false);
  });

  it('accepts a non-empty custom answer only when custom is allowed', () => {
    expect(validateRecoveredAnswers(questionPending(), [{ value: 'MySQL' }])).toBe(true);
    expect(validateRecoveredAnswers(questionPending({ options: [], allowCustom: false }), [{ value: 'MySQL' }])).toBe(
      false,
    );
  });

  it('rejects empty values and non-question decisions', () => {
    expect(validateRecoveredAnswers(questionPending(), [{ value: '   ' }])).toBe(false);
    expect(validateRecoveredAnswers({ ...questionPending(), kind: 'terminal' }, [{ value: 'Postgres' }])).toBe(false);
  });

  it('requires one answer per batch question and validates each value', () => {
    const pending = questionPending({
      questions: [
        { id: 'q1:0', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
        { id: 'q1:1', question: 'Run migrations?', options: [{ label: 'Yes' }, { label: 'No' }], custom: false },
      ],
    });
    expect(
      validateRecoveredAnswers(pending, [
        { questionId: 'q1:0', value: 'Postgres' },
        { questionId: 'q1:1', value: 'Yes' },
      ]),
    ).toBe(true);
    expect(validateRecoveredAnswers(pending, [{ questionId: 'q1:0', value: 'Postgres' }])).toBe(false);
    expect(
      validateRecoveredAnswers(pending, [
        { questionId: 'q1:0', value: 'Postgres' },
        { questionId: 'q1:1', value: 'Maybe' },
      ]),
    ).toBe(false);
  });

  it('allows comma-joined multiple selections of option labels', () => {
    const pending = questionPending({ multiple: true });
    expect(validateRecoveredAnswers(pending, [{ value: 'Postgres, SQLite' }])).toBe(true);
    expect(validateRecoveredAnswers(pending, [{ value: 'Postgres, MySQL' }])).toBe(true);
    expect(validateRecoveredAnswers(questionPending({ multiple: true, allowCustom: false }), [
      { value: 'Postgres, MySQL' },
    ])).toBe(false);
  });
});

describe('pending question persistence', () => {
  it('round-trips the full question record through the session store', async () => {
    const storage = await mkdtemp(path.join(tmpdir(), 'df-question-session-'));
    try {
      const pending = questionPending({
        multiple: true,
        questions: [
          { id: 'q1:0', question: 'Which database?', options: [{ label: 'Postgres' }], custom: false },
          { id: 'q1:1', question: 'Anything else?', options: [] },
        ],
      });
      const store = new SessionStore(path.join(storage, 'sessions'));
      await store.save({
        id: 's1',
        title: 'Recovered',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        conversation: [],
        plan: null,
        todos: [],
        planVersion: 0,
        lastRequest: '',
        contextTokens: 0,
        pending,
      });
      const loaded = await store.load('s1');
      expect(loaded?.pending).toEqual(pending);
    } finally {
      await rm(storage, { recursive: true, force: true });
    }
  });

  it('round-trips the full question record through the run journal', async () => {
    const storage = await mkdtemp(path.join(tmpdir(), 'df-question-run-'));
    try {
      const pending = questionPending({ multiple: true, allowCustom: false });
      const runs = new RunJournalStore(path.join(storage, 'runs'));
      await runs.save(runRecord('r1', { status: 'interrupted', pending }));
      const loaded = await runs.load('r1');
      expect(loaded?.pending).toEqual(pending);
    } finally {
      await rm(storage, { recursive: true, force: true });
    }
  });
});

describe('SessionController recovered questions', () => {
  async function harness(options: {
    run?: RunRecord;
    pending?: PendingDecisionRecord;
    queued?: QueuedPromptRecord[];
  }): Promise<{
    controller: SessionController;
    runs: RunJournalStore;
    posted: HostMessage[];
    storage: string;
    workspace: string;
  }> {
    const storage = await mkdtemp(path.join(tmpdir(), 'df-question-recovery-'));
    const workspace = await mkdtemp(path.join(tmpdir(), 'df-question-recovery-ws-'));
    env.workspace = workspace;
    const store = new SessionStore(path.join(storage, 'sessions'));
    await store.save({
      id: 's1',
      title: 'Recovered',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      conversation: [],
      plan: null,
      todos: [],
      planVersion: 0,
      lastRequest: '',
      contextTokens: 0,
      queued: options.queued ?? [],
      ...(options.pending ? { pending: options.pending } : {}),
    });
    const runs = new RunJournalStore(path.join(storage, 'runs'));
    if (options.run) {
      await runs.save(options.run);
    }
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
      viewableRunIds: () => [],
      hasDiffContent: () => false,
      runFiles: () => [],
      revertWholeFile: async () => undefined,
    } as never;
    const posted: HostMessage[] = [];
    const controller = new SessionController(context, (message) => posted.push(message), diffManager);
    await waitFor(() =>
      options.run
        ? controller.getState().recovery?.run?.id === options.run.id
        : controller.getState().recovery?.pending?.id === options.pending?.id,
    );
    return { controller, runs, posted, storage, workspace };
  }

  async function askUser(controller: SessionController, question: string, options: string[]): Promise<string> {
    const executor = controller.readOnlyToolExecutor();
    expect(executor).toBeDefined();
    const call: ToolCall = {
      id: 'call1',
      name: 'ask_user',
      arguments: JSON.stringify({ question, options: options.map((label) => ({ label })) }),
    };
    return executor!(call);
  }

  function notices(posted: HostMessage[]): string[] {
    return posted
      .filter((message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage')
      .map((message) => message.message.text);
  }

  function questionCards(posted: HostMessage[]): number {
    return posted.filter((message) => message.type === 'question' && message.request !== null).length;
  }

  it('injects a recovered run answer into ask_user without showing the card', async () => {
    const pending = questionPending();
    const { controller, runs, posted, storage, workspace } = await harness({
      run: runRecord('r1', { status: 'interrupted', pending }),
    });
    try {
      await controller.handleMessage({
        type: 'answerRecoveredQuestion',
        runId: 'r1',
        answers: [{ value: 'Postgres' }],
      });
      const result = await askUser(controller, 'Which database?', ['Postgres', 'SQLite']);
      expect(result).toBe('Developer answered: Postgres');
      expect(questionCards(posted)).toBe(0);
      await waitForAsync(async () => !(await runs.load('r1'))?.pending);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('injects a batch answer with one entry per question', async () => {
    const pending = questionPending({
      questions: [
        { id: 'q1:0', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
        { id: 'q1:1', question: 'Run migrations?', options: [{ label: 'Yes' }, { label: 'No' }], custom: false },
      ],
    });
    const { controller, posted, storage, workspace } = await harness({
      run: runRecord('r1', { status: 'interrupted', pending }),
    });
    try {
      await controller.handleMessage({
        type: 'answerRecoveredQuestion',
        runId: 'r1',
        answers: [
          { questionId: 'q1:0', value: 'Postgres' },
          { questionId: 'q1:1', value: 'Yes' },
        ],
      });
      const executor = controller.readOnlyToolExecutor()!;
      const result = await executor({
        id: 'call1',
        name: 'ask_user',
        arguments: JSON.stringify({
          questions: [
            { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
            { question: 'Run migrations?', options: [{ label: 'Yes' }, { label: 'No' }] },
          ],
        }),
      });
      expect(result).toBe('Developer answered:\nWhich database?: Postgres\nRun migrations?: Yes');
      expect(questionCards(posted)).toBe(0);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects an answer that is not one of the options', async () => {
    const pending = questionPending({ allowCustom: false });
    const { controller, runs, posted, storage, workspace } = await harness({
      run: runRecord('r1', { status: 'interrupted', pending }),
    });
    try {
      await controller.handleMessage({
        type: 'answerRecoveredQuestion',
        runId: 'r1',
        answers: [{ value: 'MySQL' }],
      });
      expect(notices(posted).some((text) => text.includes('not valid'))).toBe(true);
      expect((await runs.load('r1'))?.pending?.id).toBe('q1');
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('rejects an empty recovered answer', async () => {
    const { controller, runs, posted, storage, workspace } = await harness({
      run: runRecord('r1', { status: 'interrupted', pending: questionPending() }),
    });
    try {
      await controller.handleMessage({
        type: 'answerRecoveredQuestion',
        runId: 'r1',
        answers: [{ value: '   ' }],
      });
      expect(notices(posted).some((text) => text.includes('not valid'))).toBe(true);
      expect((await runs.load('r1'))?.pending?.id).toBe('q1');
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('skips a run-level question by stopping the run and clearing pending', async () => {
    const { controller, runs, storage, workspace } = await harness({
      run: runRecord('r1', { status: 'interrupted', pending: questionPending() }),
    });
    try {
      await controller.handleMessage({ type: 'skipRecoveredQuestion', runId: 'r1' });
      const stored = await runs.load('r1');
      expect(stored?.status).toBe('stopped');
      expect(stored?.pending).toBeUndefined();
      expect(controller.getState().recovery).toBeUndefined();
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('answers a session-level question and injects it on the next planner ask', async () => {
    const { controller, posted, storage, workspace } = await harness({ pending: questionPending() });
    try {
      await controller.handleMessage({ type: 'answerRecoveredQuestion', answers: [{ value: 'SQLite' }] });
      expect(controller.getState().recovery).toBeUndefined();
      const store = new SessionStore(path.join(storage, 'sessions'));
      expect((await store.load('s1'))?.pending).toBeUndefined();
      const result = await askUser(controller, 'Which database?', ['Postgres', 'SQLite']);
      expect(result).toBe('Developer answered: SQLite');
      expect(questionCards(posted)).toBe(0);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('skips a session-level question and clears the persisted pending', async () => {
    const { controller, storage, workspace } = await harness({ pending: questionPending() });
    try {
      expect(controller.getState().recovery?.pending?.id).toBe('q1');
      await controller.handleMessage({ type: 'skipRecoveredQuestion' });
      expect(controller.getState().recovery).toBeUndefined();
      const store = new SessionStore(path.join(storage, 'sessions'));
      expect((await store.load('s1'))?.pending).toBeUndefined();
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('shows the live card when the question text no longer matches', async () => {
    const { controller, posted, storage, workspace } = await harness({ pending: questionPending() });
    try {
      await controller.handleMessage({ type: 'answerRecoveredQuestion', answers: [{ value: 'SQLite' }] });
      const pendingCall = askUser(controller, 'Which runtime?', ['Node', 'Deno']);
      await waitFor(() => questionCards(posted) === 1);
      const card = posted.find(
        (message): message is Extract<HostMessage, { type: 'question' }> =>
          message.type === 'question' && message.request !== null,
      );
      await controller.handleMessage({ type: 'questionAnswer', id: card!.request!.id, answer: 'Node' });
      expect(await pendingCall).toBe('Node');
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
