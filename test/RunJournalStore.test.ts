import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { MAX_AGE_MS, MAX_RUNS, RunJournalStore, shouldPrune } from '../src/session/RunJournalStore';
import { RunRecord, RunOperation, RunStatus } from '../src/shared/protocol';

function run(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const now = Date.now();
  return {
    id,
    sessionId: 's1',
    request: 'do a thing',
    provider: 'openai',
    model: 'gpt-4o',
    status: 'completed',
    planVersion: 1,
    stepIndex: 0,
    completedSteps: [],
    workspaceHash: 'hash',
    operations: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'df-runs-'));
}

describe('RunJournalStore', () => {
  it('round-trips a run and lists newest first', async () => {
    const dir = await tempDir();
    try {
      const store = new RunJournalStore(dir);
      const now = Date.now();
      await store.save(run('a', { updatedAt: now - 1000 }));
      await store.save(run('b', { updatedAt: now }));

      expect(await readFile(path.join(dir, 'runs', 'a.json'), 'utf-8')).toContain('"id":"a"');
      const loaded = await store.load('a');
      expect(loaded?.request).toBe('do a thing');
      expect(loaded?.sessionId).toBe('s1');
      expect((await store.list()).map((entry) => entry.id)).toEqual(['b', 'a']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the .bak file when the primary is corrupted', async () => {
    const dir = await tempDir();
    try {
      const store = new RunJournalStore(dir);
      await store.save(run('a', { request: 'v1' }));
      await store.save(run('a', { request: 'v2' }));
      await writeFile(path.join(dir, 'runs', 'a.json'), '{ not json', 'utf-8');
      expect((await store.load('a'))?.request).toBe('v1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('removes runs and index entries', async () => {
    const dir = await tempDir();
    try {
      const store = new RunJournalStore(dir);
      await store.save(run('a'));
      await store.remove('a');
      expect(await store.load('a')).toBeUndefined();
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('truncates operations to the last 500 and normalizes completed steps', async () => {
    const dir = await tempDir();
    try {
      const store = new RunJournalStore(dir);
      const operations: RunOperation[] = Array.from({ length: 600 }, (_, index) => ({
        id: `op${index}`,
        tool: 'read_file',
        status: 'succeeded',
        startedAt: index,
      }));
      await store.save(run('ops', { operations, completedSteps: [3, 1, 3, 2, 0] }));
      const loaded = await store.load('ops');
      expect(loaded?.operations.length).toBe(500);
      expect(loaded?.operations[0].id).toBe('op100');
      expect(loaded?.completedSteps).toEqual([0, 1, 2, 3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prunes completed runs older than the max age but keeps protected statuses', async () => {
    const dir = await tempDir();
    const now = Date.now();
    try {
      const store = new RunJournalStore(dir);
      await store.save(run('old', { status: 'completed', updatedAt: now - MAX_AGE_MS - 1000 }));
      await store.save(run('keep', { status: 'interrupted', updatedAt: now - MAX_AGE_MS - 1000 }));
      expect(await store.load('old')).toBeUndefined();
      expect((await store.load('keep'))?.status).toBe('interrupted');
      expect((await store.list()).map((entry) => entry.id)).toEqual(['keep']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps at most MAX_RUNS non-protected runs', async () => {
    const dir = await tempDir();
    const now = Date.now();
    try {
      const store = new RunJournalStore(dir);
      for (let index = 0; index < MAX_RUNS + 5; index += 1) {
        await store.save(
          run(`r${index}`, { status: 'completed', updatedAt: now - (MAX_RUNS + 5 - index) * 1000 }),
        );
      }
      const list = await store.list();
      expect(list.length).toBe(MAX_RUNS);
      expect(list[0].id).toBe(`r${MAX_RUNS + 4}`);
      expect(list.some((entry) => entry.id === 'r0')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shouldPrune only prunes old unprotected runs', async () => {
    const now = Date.now();
    expect(shouldPrune(run('x', { status: 'completed', updatedAt: now - MAX_AGE_MS - 1 }), now)).toBe(true);
    expect(shouldPrune(run('x', { status: 'completed', updatedAt: now }), now)).toBe(false);
    const protectedStatuses: RunStatus[] = ['planned', 'approved', 'executing', 'waiting', 'interrupted'];
    for (const status of protectedStatuses) {
      expect(shouldPrune(run('x', { status, updatedAt: now - MAX_AGE_MS - 1 }), now)).toBe(false);
    }
  });
});
