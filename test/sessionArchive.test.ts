import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import type { ChatMessage } from '../src/llm/types';
import type { UiMessage } from '../src/shared/protocol';
import { SessionStore, StoredSession } from '../src/session/SessionStore';

function session(id: string, conversation: ChatMessage[]): StoredSession {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    conversation,
    plan: null,
    todos: [],
    planVersion: 0,
    lastRequest: '',
    contextTokens: 0,
  };
}

function messages(count: number, prefix = 'm'): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: 'user' as const,
    content: `${prefix} message ${index} ${'x'.repeat(200)}`,
  }));
}

describe('SessionStore archive rotation', () => {
  it('moves the oldest messages into an archive and keeps the active file loadable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-archive-'));
    try {
      const store = new SessionStore(dir, 1000);
      const conversation = messages(24);
      await store.save(session('a', conversation));

      const active = await store.load('a');
      expect(active).toBeDefined();
      expect(active!.conversation.length).toBeLessThan(conversation.length);
      expect(active!.archived?.count).toBeGreaterThan(0);
      expect(active!.archived?.files.length).toBe(1);

      const archived = await store.loadArchive('a');
      expect(archived).toHaveLength(active!.archived!.count);
      expect([...archived, ...active!.conversation]).toEqual(conversation);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('appends to the newest archive and rotates once it exceeds the threshold', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-archive-'));
    try {
      const store = new SessionStore(dir, 1000, 3000);
      const conversation = messages(24);
      await store.save(session('a', conversation));
      const extended = [...conversation, ...messages(8, 'n')];
      await store.save(session('a', extended));

      const active = await store.load('a');
      expect(active!.archived?.files.length).toBe(2);
      expect(active!.archived!.files[0]).toMatch(/\.1\.json$/);
      expect(active!.archived!.files[1]).toMatch(/session\.archive\.a\.json$/);

      const archived = await store.loadArchive('a');
      expect(archived).toHaveLength(active!.archived!.count);
      expect([...archived, ...active!.conversation]).toEqual(extended);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes archives atomically with a backup copy', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-archive-'));
    try {
      const store = new SessionStore(dir, 1000);
      const conversation = messages(24);
      await store.save(session('a', conversation));
      await store.save(session('a', [...conversation, ...messages(4, 'n')]));

      await expect(stat(path.join(dir, 'session.archive.a.json.bak'))).resolves.toBeDefined();
      await expect(stat(path.join(dir, 'a.json.bak'))).resolves.toBeDefined();
      const backup = JSON.parse(await readFile(path.join(dir, 'session.archive.a.json.bak'), 'utf-8')) as {
        conversation: ChatMessage[];
      };
      expect(backup.conversation.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces archiveUnavailable and keeps the full active session when the archive write fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-archive-'));
    try {
      const store = new SessionStore(dir, 1000);
      await mkdir(path.join(dir, 'session.archive.a.json.tmp'));
      const conversation = messages(24);
      await store.save(session('a', conversation));

      const active = await store.load('a');
      expect(active?.archiveUnavailable).toBe(true);
      expect(active?.conversation).toHaveLength(conversation.length);
      expect(await store.loadArchive('a')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not archive small sessions and keeps the existing uncompacted history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-archive-'));
    try {
      const store = new SessionStore(dir, 5 * 1024 * 1024);
      const conversation = messages(30);
      await store.save(session('a', conversation));
      const active = await store.load('a');
      expect(active?.conversation).toHaveLength(conversation.length);
      expect(active?.archived).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('archives old UI cards when visible history is what makes the session large', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-archive-'));
    try {
      const store = new SessionStore(dir, 1000);
      const uiMessages: UiMessage[] = Array.from({ length: 30 }, (_, index) => ({
        id: `ui-${index}`,
        role: 'assistant',
        text: `card ${index} ${'x'.repeat(200)}`,
      }));
      await store.save({ ...session('ui', messages(2)), messages: uiMessages });
      const active = await store.load('ui');
      expect(active!.messages.length).toBeLessThan(uiMessages.length);
      expect(active!.archived?.uiCount).toBeGreaterThan(0);
      expect(await store.loadArchiveUi('ui')).toHaveLength(active!.archived!.uiCount);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
