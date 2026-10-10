import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { SessionStore, StoredSession } from '../src/session/SessionStore';

function session(id: string, title: string, updatedAt: number): StoredSession {
  return {
    id,
    title,
    createdAt: 1,
    updatedAt,
    messages: [{ id: 'm1', role: 'user', text: 'hello' }],
    conversation: [{ role: 'user', content: 'hello' }],
    plan: null,
    todos: [],
    planVersion: 0,
    lastRequest: '',
    contextTokens: 0,
  };
}

describe('SessionStore', () => {
  it('saves, lists, loads, renames and deletes sessions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-sessions-'));
    try {
      const store = new SessionStore(dir);
      await store.save(session('a', 'First', 10));
      await store.save(session('b', 'Second', 20));

      const list = await store.list();
      expect(list.map((entry) => entry.id)).toEqual(['b', 'a']);
      expect(list[0].messageCount).toBe(1);

      expect((await store.load('a'))?.title).toBe('First');

      await store.rename('a', 'Renamed');
      expect((await store.load('a'))?.title).toBe('Renamed');

      await store.delete('a');
      expect(await store.load('a')).toBeUndefined();
      expect((await store.list()).map((entry) => entry.id)).toEqual(['b']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a fresh store', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-sessions-'));
    try {
      const store = new SessionStore(dir);
      expect(await store.list()).toEqual([]);
      expect(await store.load('missing')).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the backup when the primary session file is corrupted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-sessions-'));
    try {
      const store = new SessionStore(dir);
      await store.save(session('a', 'First', 10));
      await store.save(session('a', 'Second', 20));
      await writeFile(path.join(dir, 'a.json'), '{ corrupted', 'utf-8');
      const loaded = await store.load('a');
      expect(loaded?.title).toBe('First');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
