import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    EventEmitter: class {
      private listeners = new Set<(value: unknown) => void>();
      event = (listener: (value: unknown) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire = (value?: unknown) => {
        for (const listener of this.listeners) listener(value);
      };
      dispose = () => this.listeners.clear();
    },
    window: {
      onDidChangeActiveTextEditor: () => disposable,
      onDidChangeTextDocument: () => disposable,
      onDidChangeVisibleTextEditors: () => disposable,
      visibleTextEditors: [],
      createTextEditorDecorationType: () => disposable,
    },
    workspace: {
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      asRelativePath: (value: string) => value,
      workspaceFolders: [],
    },
    ThemeColor: class {},
    OverviewRulerLane: { Right: 1 },
    Range: class {},
  };
});

import { DiffManager, DiffHistoryLimits } from '../src/diff/DiffManager';

const DEFAULT_LIMITS: DiffHistoryLimits = {
  maxRuns: 20,
  maxOriginalBytes: 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'df-diff-history-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('DiffManager run history', () => {
  it('records status and stats for modified, added, and deleted files', async () => {
    const root = await tempRoot();
    const manager = new DiffManager(DEFAULT_LIMITS);
    manager.setRunContext({ id: 'run1', label: 'Task one' });

    const modified = path.join(root, 'a.ts');
    await fs.writeFile(modified, 'one\ntwo\nthree\n', 'utf-8');
    await manager.applyChange(modified, 'one\nTWO\nthree\nfour\n');

    const added = path.join(root, 'new.ts');
    await manager.applyChange(added, 'fresh\nline\n');

    const deleted = path.join(root, 'gone.ts');
    await fs.writeFile(deleted, 'x\ny\nz\n', 'utf-8');
    await manager.applyDeletion(deleted);

    const files = manager.runFiles('run1');
    expect(files).toHaveLength(3);
    expect(files.find((file) => file.path === modified)).toEqual({
      path: modified,
      status: 'modified',
      additions: 4,
      deletions: 3,
    });
    expect(files.find((file) => file.path === added)).toEqual({
      path: added,
      status: 'added',
      additions: 3,
      deletions: 0,
    });
    expect(files.find((file) => file.path === deleted)).toEqual({
      path: deleted,
      status: 'deleted',
      additions: 0,
      deletions: 4,
    });

    expect(manager.hasDiffContent('run1')).toBe(true);
    expect(manager.hasDiffContent('run1', modified)).toBe(true);
    expect(manager.hasDiffContent('run1', added)).toBe(true);
    expect(manager.hasDiffContent('run1', deleted)).toBe(true);
    expect(manager.getRunOriginal('run1', modified)).toBe('one\ntwo\nthree\n');
    expect(manager.getRunOriginal('run1', added)).toBe('');
    expect(manager.getRunOriginal('run1', deleted)).toBe('x\ny\nz\n');
    expect(manager.viewableRunIds()).toEqual(['run1']);
    manager.dispose();
  });

  it('aggregates repeated changes to the same file and keeps the first original', async () => {
    const root = await tempRoot();
    const manager = new DiffManager(DEFAULT_LIMITS);
    manager.setRunContext({ id: 'run1', label: 'Task one' });
    const created = path.join(root, 'created.ts');
    await manager.applyChange(created, 'first\n');
    await manager.applyChange(created, 'first\nsecond\n');
    expect(manager.runFiles('run1')).toEqual([
      { path: created, status: 'added', additions: 4, deletions: 0 },
    ]);
    expect(manager.getRunOriginal('run1', created)).toBe('');

    const removed = path.join(root, 'removed.ts');
    await fs.writeFile(removed, 'alpha\n', 'utf-8');
    await manager.applyChange(removed, 'beta\n');
    await manager.applyDeletion(removed);
    const entry = manager.runFiles('run1').find((file) => file.path === removed);
    expect(entry?.status).toBe('deleted');
    expect(manager.getRunOriginal('run1', removed)).toBe('alpha\n');
    manager.dispose();
  });

  it('retains history after changes are accepted', async () => {
    const root = await tempRoot();
    const manager = new DiffManager(DEFAULT_LIMITS);
    manager.setRunContext({ id: 'run1', label: 'Task one' });
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'before\n', 'utf-8');
    await manager.applyChange(file, 'after\n');

    const changeId = manager.getPendingChanges(file)[0]?.id;
    expect(changeId).toBeTruthy();
    manager.acceptChange(changeId!);
    expect(manager.hasPendingChanges()).toBe(false);

    expect(manager.hasDiffContent('run1', file)).toBe(true);
    expect(manager.runFiles('run1')).toEqual([
      { path: file, status: 'modified', additions: 2, deletions: 2 },
    ]);

    manager.setRunContext({ id: 'run2', label: 'Task two' });
    const second = path.join(root, 'b.ts');
    await fs.writeFile(second, 'before\n', 'utf-8');
    await manager.applyChange(second, 'after\n');
    await manager.acceptRun('run2');
    expect(manager.hasDiffContent('run2', second)).toBe(true);
    manager.dispose();
  });

  it('keeps metadata only when a file original exceeds 1 MB', async () => {
    const root = await tempRoot();
    const manager = new DiffManager(DEFAULT_LIMITS);
    manager.setRunContext({ id: 'big', label: 'Big task' });
    const file = path.join(root, 'big.txt');
    const original = `${'a'.repeat(1024 * 1024)}b`;
    await fs.writeFile(file, original, 'utf-8');
    await manager.applyChange(file, 'small replacement');

    expect(manager.runFiles('big')).toEqual([
      { path: file, status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect(manager.hasDiffContent('big', file)).toBe(false);
    expect(manager.hasDiffContent('big')).toBe(false);
    expect(manager.viewableRunIds()).toEqual([]);
    manager.dispose();
  });

  it('caps runs at 20 and drops the oldest metadata', async () => {
    const root = await tempRoot();
    const manager = new DiffManager(DEFAULT_LIMITS);
    for (let index = 0; index < 21; index++) {
      manager.setRunContext({ id: `run${index}`, label: `Task ${index}` });
      const file = path.join(root, `file${index}.ts`);
      await manager.applyChange(file, `content ${index}\n`);
    }
    expect(manager.runFiles('run0')).toEqual([]);
    expect(manager.hasDiffContent('run0')).toBe(false);
    expect(manager.runFiles('run1')).toHaveLength(1);
    expect(manager.viewableRunIds()).toHaveLength(20);
    expect(manager.viewableRunIds()).not.toContain('run0');
    manager.dispose();
  });

  it('evicts the oldest run content when the content budget is exceeded', async () => {
    const root = await tempRoot();
    const manager = new DiffManager({ maxRuns: 20, maxOriginalBytes: 1000, maxTotalBytes: 60 });
    manager.setRunContext({ id: 'run1', label: 'Task one' });
    const first = path.join(root, 'one.ts');
    await fs.writeFile(first, `${'x'.repeat(40)}\n`, 'utf-8');
    await manager.applyChange(first, `${'x'.repeat(39)}z\n`);
    manager.setRunContext({ id: 'run2', label: 'Task two' });
    const second = path.join(root, 'two.ts');
    await fs.writeFile(second, `${'y'.repeat(40)}\n`, 'utf-8');
    await manager.applyChange(second, `${'y'.repeat(39)}z\n`);

    expect(manager.hasDiffContent('run1')).toBe(false);
    expect(manager.runFiles('run1')).toHaveLength(1);
    expect(manager.hasDiffContent('run2')).toBe(true);
    expect(manager.viewableRunIds()).toEqual(['run2']);
    manager.dispose();
  });

  it('fires onDidChangeHistory when history changes', async () => {
    const root = await tempRoot();
    const manager = new DiffManager(DEFAULT_LIMITS);
    let events = 0;
    const subscription = manager.onDidChangeHistory(() => {
      events++;
    });
    manager.setRunContext({ id: 'run1', label: 'Task' });
    const file = path.join(root, 'a.ts');
    await manager.applyChange(file, 'content\n');
    expect(events).toBeGreaterThan(0);
    subscription.dispose();
    manager.dispose();
  });
});
