import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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

import type { HostMessage, QueuedPromptRecord, RunRecord } from '../src/shared/protocol';
import { SessionController } from '../src/session/SessionController';
import { SessionStore } from '../src/session/SessionStore';
import { RunJournalStore } from '../src/session/RunJournalStore';
import {
  appendStepHash,
  buildRunOperation,
  classifyOperationRetry,
  filterAlivePids,
  mutationTargets,
  operationAfterHash,
  parseOperationExpectations,
  upsertRunChangedFile,
  validateRecoveredDecision,
} from '../src/session/runRecovery';
import { FileSnapshotStore } from '../src/checkpoints/FileSnapshotStore';

function sha1(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

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
  env.statusMessages = [];
  vi.stubEnv('HOME', '/tmp/dev-first-run-recovery-home');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('classifyOperationRetry', () => {
  it('treats a matching after hash as succeeded', () => {
    expect(classifyOperationRetry({ beforeHash: 'before', afterHash: 'after' }, 'after')).toBe('succeeded');
  });

  it('treats a matching before hash as not applied', () => {
    expect(classifyOperationRetry({ beforeHash: 'before', afterHash: 'after' }, 'before')).toBe('failed');
    expect(classifyOperationRetry({ beforeHash: 'before' }, 'before')).toBe('failed');
  });

  it('is uncertain when nothing matches, including terminal operations', () => {
    expect(classifyOperationRetry({ beforeHash: 'before', afterHash: 'after' }, 'other')).toBe('uncertain');
    expect(classifyOperationRetry({ beforeHash: 'before' }, 'other')).toBe('uncertain');
    expect(classifyOperationRetry({ beforeHash: 'before' }, undefined)).toBe('uncertain');
    expect(classifyOperationRetry({}, undefined)).toBe('uncertain');
  });
});

describe('upsertRunChangedFile', () => {
  it('adds new paths and dedupes existing ones', () => {
    const first = upsertRunChangedFile(undefined, { path: 'a.ts', status: 'modified' });
    const second = upsertRunChangedFile(first, { path: 'b.ts', status: 'added' });
    const third = upsertRunChangedFile(second, { path: 'a.ts', status: 'modified' });
    expect(third).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
    ]);
  });

  it('keeps added paths added and drops added-then-deleted paths', () => {
    const added = upsertRunChangedFile(undefined, { path: 'a.ts', status: 'added' });
    expect(upsertRunChangedFile(added, { path: 'a.ts', status: 'modified' })).toEqual([
      { path: 'a.ts', status: 'added' },
    ]);
    expect(upsertRunChangedFile(added, { path: 'a.ts', status: 'deleted' })).toEqual([]);
    const modified = upsertRunChangedFile(undefined, { path: 'a.ts', status: 'modified' });
    expect(upsertRunChangedFile(modified, { path: 'a.ts', status: 'deleted' })).toEqual([
      { path: 'a.ts', status: 'deleted' },
    ]);
  });
});

describe('appendStepHash', () => {
  it('appends hashes and ignores empty values', () => {
    expect(appendStepHash(undefined, 'h1')).toEqual(['h1']);
    expect(appendStepHash(['h1'], 'h2')).toEqual(['h1', 'h2']);
    expect(appendStepHash(['h1'], '')).toEqual(['h1']);
  });

  it('caps the history at the maximum length', () => {
    const hashes = Array.from({ length: 5 }, (_, index) => `h${index}`);
    expect(appendStepHash(hashes, 'h5', 3)).toEqual(['h3', 'h4', 'h5']);
  });
});

describe('validateRecoveredDecision', () => {
  it('requires a command and an existing cwd for terminal decisions', () => {
    expect(validateRecoveredDecision({ kind: 'terminal', command: 'npm test' }, { cwdExists: true })).toBe(true);
    expect(validateRecoveredDecision({ kind: 'terminal', command: 'npm test' }, { cwdExists: false })).toBe(false);
    expect(validateRecoveredDecision({ kind: 'terminal', command: '  ' }, { cwdExists: true })).toBe(false);
    expect(validateRecoveredDecision({ kind: 'terminal' }, { cwdExists: true })).toBe(false);
  });

  it('accepts question decisions regardless of cwd', () => {
    expect(validateRecoveredDecision({ kind: 'question' }, { cwdExists: false })).toBe(true);
  });
});

describe('filterAlivePids', () => {
  it('keeps pids whose probe reports alive', () => {
    expect(filterAlivePids([1, 2, 3], (pid) => pid !== 2)).toEqual([1, 3]);
  });

  it('drops pids whose probe throws or reports dead', () => {
    expect(filterAlivePids([1, 2], () => false)).toEqual([]);
    expect(
      filterAlivePids([1, 2], (pid) => {
        if (pid === 2) {
          throw new Error('gone');
        }
        return true;
      }),
    ).toEqual([1]);
  });

  it('handles an empty pid list', () => {
    expect(filterAlivePids([], () => true)).toEqual([]);
  });
});

describe('buildRunOperation', () => {
  it('hashes the target before file edits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'df-op-'));
    try {
      await writeFile(path.join(root, 'a.ts'), 'before', 'utf-8');
      const operation = await buildRunOperation('edit_file', JSON.stringify({ path: 'a.ts' }), root);
      const expected = createHash('sha1').update('before').digest('hex');
      expect(operation?.beforeHash).toBe(expected);
      expect(operation?.target).toBe('a.ts');
      expect(operation?.afterHash).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stores the command for terminal tools and no hashes', async () => {
    const operation = await buildRunOperation(
      'run_terminal_command',
      JSON.stringify({ command: 'npm test' }),
      '/tmp',
    );
    expect(operation?.target).toBe('npm test');
    expect(operation?.beforeHash).toBeUndefined();
    expect(operation?.afterHash).toBeUndefined();
  });

  it('records per-file expectations for patches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'df-op-'));
    try {
      const patch = ['*** Begin Patch', '*** Add File: new.ts', '+hello', '*** End Patch'].join('\n');
      const operation = await buildRunOperation('apply_patch', JSON.stringify({ patch }), root);
      const expectations = parseOperationExpectations(operation!);
      expect(expectations).toEqual([
        { path: 'new.ts', status: 'added', before: null, after: null, captured: false },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('mutationTargets', () => {
  it('derives per-file targets for mutating tools', () => {
    expect(mutationTargets('write_file', JSON.stringify({ path: 'a.ts' }))).toEqual(['a.ts']);
    expect(mutationTargets('edit_file', JSON.stringify({ path: 'b.ts', old_text: 'x', new_text: 'y' }))).toEqual([
      'b.ts',
    ]);
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.ts',
      '+hello',
      '*** Delete File: old.ts',
      '*** End Patch',
    ].join('\n');
    expect(mutationTargets('apply_patch', JSON.stringify({ patch }))).toEqual(['new.ts', 'old.ts']);
    expect(mutationTargets('read_file', JSON.stringify({ path: 'a.ts' }))).toEqual([]);
    expect(mutationTargets('write_file', 'not json')).toEqual([]);
  });
});

describe('operationAfterHash', () => {
  it('returns the latest recorded after hash for a path', () => {
    const run = {
      operations: [
        { id: '1', tool: 'edit_file', target: 'a.ts', status: 'succeeded' as const, startedAt: 1, afterHash: 'h1' },
        { id: '2', tool: 'edit_file', target: 'a.ts', status: 'succeeded' as const, startedAt: 2, afterHash: 'h2' },
        { id: '3', tool: 'write_file', target: 'b.ts', status: 'succeeded' as const, startedAt: 3, afterHash: 'h3' },
      ],
    };
    expect(operationAfterHash(run, 'a.ts')).toBe('h2');
    expect(operationAfterHash(run, 'b.ts')).toBe('h3');
    expect(operationAfterHash(run, 'c.ts')).toBeUndefined();
  });
});

describe('SessionController recovered runs', () => {
  async function harness(
    run: RunRecord,
    queued: QueuedPromptRecord[] = [],
  ): Promise<{
    controller: SessionController;
    runs: RunJournalStore;
    posted: HostMessage[];
    storage: string;
    workspace: string;
  }> {
    const storage = await mkdtemp(path.join(tmpdir(), 'df-run-recovery-'));
    const workspace = await mkdtemp(path.join(tmpdir(), 'df-run-recovery-ws-'));
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
      queued,
    });
    const runs = new RunJournalStore(path.join(storage, 'runs'));
    await runs.save(run);
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
    await waitFor(() => controller.getState().recovery?.run.id === run.id);
    return { controller, runs, posted, storage, workspace };
  }

  it('drops a rejected recovered decision as stopped and clears recovery', async () => {
    const pending = { id: 'p1', kind: 'terminal' as const, prompt: 'npm test', command: 'npm test', cwd: '/tmp', createdAt: 1 };
    const { controller, runs, storage, workspace } = await harness(runRecord('r1', { status: 'interrupted', pending }));
    try {
      await controller.handleMessage({ type: 'resolveRecoveredDecision', runId: 'r1', approved: false });
      const stored = await runs.load('r1');
      expect(stored?.status).toBe('stopped');
      expect(stored?.pending).toBeUndefined();
      expect(controller.getState().recovery).toBeUndefined();
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps the run interrupted when a recovered terminal cwd no longer exists', async () => {
    const pending = {
      id: 'p1',
      kind: 'terminal' as const,
      prompt: 'npm test',
      command: 'npm test',
      cwd: '/definitely/not/a/real/dir-xyz',
      createdAt: 1,
    };
    const { controller, runs, posted, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', pending }),
    );
    try {
      await controller.handleMessage({ type: 'resolveRecoveredDecision', runId: 'r1', approved: true });
      const stored = await runs.load('r1');
      expect(stored?.status).toBe('interrupted');
      expect(stored?.pending?.id).toBe('p1');
      const notices = posted
        .filter((message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage')
        .map((message) => message.message.text);
      expect(notices.some((text) => text.includes('no longer valid'))).toBe(true);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('resolves a recovered question decision and clears its waiting operation', async () => {
    const pending = { id: 'p1', kind: 'question' as const, prompt: 'Which file?', createdAt: 5 };
    const operations = [{ id: 'op1', tool: 'ask_user', status: 'started' as const, startedAt: 1 }];
    const { controller, runs, posted, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', checkpointId: 'cp1', workspaceHash: 'cp1', pending, operations }),
    );
    try {
      await controller.handleMessage({ type: 'resolveRecoveredDecision', runId: 'r1', approved: true });
      const stored = await runs.load('r1');
      expect(stored?.pending).toBeUndefined();
      expect(stored?.operations[0].status).toBe('failed');
      const notices = posted
        .filter((message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage')
        .map((message) => message.message.text);
      expect(notices.some((text) => text.includes('Cannot resume safely'))).toBe(false);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('exposes and accepts recovered run review data', async () => {
    const changedFiles = [
      { path: 'src/a.ts', status: 'modified' as const },
      { path: 'src/b.ts', status: 'added' as const },
    ];
    const { controller, runs, posted, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', checkpointId: 'cp1', changedFiles }),
    );
    try {
      await controller.handleMessage({ type: 'openRunReview', runId: 'r1' });
      const review = posted.find(
        (message): message is Extract<HostMessage, { type: 'runReview' }> => message.type === 'runReview',
      );
      expect(review?.files.map((file) => [file.path, file.status])).toEqual([
        ['src/a.ts', 'modified'],
        ['src/b.ts', 'added'],
      ]);
      expect((await controller.getRunReview('r1'))?.length).toBe(2);

      await controller.handleMessage({ type: 'acceptRunReview', runId: 'r1' });
      expect((await runs.load('r1'))?.changedFiles).toBeUndefined();
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reverts an added file by deleting it and dropping the review entry', async () => {
    const changedFiles = [{ path: 'new.ts', status: 'added' as const }];
    const { controller, runs, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', changedFiles }),
    );
    try {
      await writeFile(path.join(workspace, 'new.ts'), 'content', 'utf-8');
      await controller.handleMessage({ type: 'revertRunFile', path: 'new.ts', runId: 'r1' });
      expect(existsSync(path.join(workspace, 'new.ts'))).toBe(false);
      expect((await runs.load('r1'))?.changedFiles).toEqual([]);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('restores a file from its snapshot when no checkpoint exists', async () => {
    const rel = 'src/a.ts';
    const changedFiles = [{ path: rel, status: 'modified' as const, originalHash: sha1('original'), captured: true }];
    const operations = [
      {
        id: 'op1',
        tool: 'edit_file',
        target: rel,
        status: 'succeeded' as const,
        startedAt: 1,
        afterHash: sha1('after'),
      },
    ];
    const { controller, runs, posted, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', changedFiles, operations }),
    );
    try {
      await mkdir(path.join(workspace, 'src'), { recursive: true });
      await writeFile(path.join(workspace, rel), 'original', 'utf-8');
      const snapshots = new FileSnapshotStore(path.join(storage, 'file-snapshots'));
      await snapshots.capture('r1', workspace, [rel]);
      await writeFile(path.join(workspace, rel), 'after', 'utf-8');

      await controller.handleMessage({ type: 'revertRunFile', path: rel, runId: 'r1' });
      expect(await readFile(path.join(workspace, rel), 'utf-8')).toBe('original');
      expect(posted.some((message) => message.type === 'runReviewConflict')).toBe(false);
      expect((await runs.load('r1'))?.changedFiles).toEqual([]);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('refuses to revert when the file changed after the run and force restores it', async () => {
    const rel = 'src/a.ts';
    const changedFiles = [{ path: rel, status: 'modified' as const, originalHash: sha1('original'), captured: true }];
    const operations = [
      {
        id: 'op1',
        tool: 'edit_file',
        target: rel,
        status: 'succeeded' as const,
        startedAt: 1,
        afterHash: sha1('after'),
      },
    ];
    const { controller, runs, posted, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', changedFiles, operations }),
    );
    try {
      await mkdir(path.join(workspace, 'src'), { recursive: true });
      await writeFile(path.join(workspace, rel), 'original', 'utf-8');
      const snapshots = new FileSnapshotStore(path.join(storage, 'file-snapshots'));
      await snapshots.capture('r1', workspace, [rel]);
      await writeFile(path.join(workspace, rel), 'conflict', 'utf-8');

      await controller.handleMessage({ type: 'revertRunFile', path: rel, runId: 'r1' });
      expect(await readFile(path.join(workspace, rel), 'utf-8')).toBe('conflict');
      expect(
        posted.some((message) => message.type === 'runReviewConflict' && message.path === rel),
      ).toBe(true);
      expect((await runs.load('r1'))?.changedFiles).toHaveLength(1);

      await controller.handleMessage({ type: 'revertRunFileForce', path: rel, runId: 'r1' });
      expect(await readFile(path.join(workspace, rel), 'utf-8')).toBe('original');
      expect((await runs.load('r1'))?.changedFiles).toEqual([]);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reverts a file whose snapshot is absent by deleting it', async () => {
    const changedFiles = [{ path: 'new.ts', status: 'added' as const, captured: true, absent: true }];
    const { controller, runs, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', changedFiles }),
    );
    try {
      const snapshots = new FileSnapshotStore(path.join(storage, 'file-snapshots'));
      await snapshots.capture('r1', workspace, ['new.ts']);
      await writeFile(path.join(workspace, 'new.ts'), 'created', 'utf-8');

      await controller.handleMessage({ type: 'revertRunFile', path: 'new.ts', runId: 'r1' });
      expect(existsSync(path.join(workspace, 'new.ts'))).toBe(false);
      expect((await runs.load('r1'))?.changedFiles).toEqual([]);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rolls back snapshot files and keeps files that changed since the run', async () => {
    const saved = 'saved.ts';
    const conflicted = 'conflicted.ts';
    const changedFiles = [
      { path: saved, status: 'modified' as const, originalHash: sha1('saved original'), captured: true },
      { path: conflicted, status: 'modified' as const, originalHash: sha1('conflicted original'), captured: true },
    ];
    const operations = [
      {
        id: 'op1',
        tool: 'edit_file',
        target: saved,
        status: 'succeeded' as const,
        startedAt: 1,
        afterHash: sha1('agent change'),
      },
      {
        id: 'op2',
        tool: 'edit_file',
        target: conflicted,
        status: 'succeeded' as const,
        startedAt: 2,
        afterHash: sha1('agent conflicted'),
      },
    ];
    const { controller, runs, posted, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', changedFiles, operations }),
    );
    try {
      await writeFile(path.join(workspace, saved), 'saved original', 'utf-8');
      await writeFile(path.join(workspace, conflicted), 'conflicted original', 'utf-8');
      const snapshots = new FileSnapshotStore(path.join(storage, 'file-snapshots'));
      await snapshots.capture('r1', workspace, [saved, conflicted]);
      await writeFile(path.join(workspace, saved), 'agent change', 'utf-8');
      await writeFile(path.join(workspace, conflicted), 'someone else', 'utf-8');

      await controller.handleMessage({ type: 'rollbackRun', id: 'r1' });
      expect(await readFile(path.join(workspace, saved), 'utf-8')).toBe('saved original');
      expect(await readFile(path.join(workspace, conflicted), 'utf-8')).toBe('someone else');
      const stored = await runs.load('r1');
      expect(stored?.changedFiles).toEqual([
        {
          path: conflicted,
          status: 'modified',
          originalHash: sha1('conflicted original'),
          captured: true,
        },
      ]);
      const notices = posted
        .filter((message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage')
        .map((message) => message.message.text);
      expect(notices.some((text) => text.includes(conflicted))).toBe(true);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('discards a queued prompt and persists the cancellation', async () => {
    const { controller, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted' }),
      [{ id: 'q1', text: 'follow up', status: 'queued', createdAt: 1 }],
    );
    try {
      expect(controller.getState().queued?.map((entry) => entry.id)).toEqual(['q1']);
      await controller.handleMessage({ type: 'cancelQueued', id: 'q1' });
      expect(controller.getState().queued).toEqual([]);
      await controller.persistNow();
      const store = new SessionStore(path.join(storage, 'sessions'));
      expect((await store.load('s1'))?.queued).toEqual([]);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reports alive recovered process pids in the recovery payload', async () => {
    const processes = [{ id: 'bg1', pid: process.pid, command: 'node server.js', startedAt: 1 }];
    const { controller, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', processes }),
    );
    try {
      expect(controller.getState().recovery?.processesAlive).toEqual([process.pid]);
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('forgets recovered processes and browser sessions', async () => {
    const processes = [{ id: 'bg1', pid: 999999, command: 'npm run dev', startedAt: 1 }];
    const { controller, runs, storage, workspace } = await harness(
      runRecord('r1', { status: 'interrupted', processes, browser: { port: 9222 } }),
    );
    try {
      await controller.handleMessage({ type: 'forgetRunProcess', runId: 'r1', pid: 999999 });
      expect((await runs.load('r1'))?.processes).toBeUndefined();
      await controller.handleMessage({ type: 'forgetBrowser', runId: 'r1' });
      expect((await runs.load('r1'))?.browser).toBeUndefined();
      controller.dispose();
    } finally {
      await rm(storage, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
