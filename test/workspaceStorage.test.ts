import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { workspaceStoragePath } from '../src/util/workspaceStorage';
import { SessionStore } from '../src/session/SessionStore';

describe('workspaceStoragePath', () => {
  it('keeps extension data for separate workspaces in separate directories', () => {
    const projectA = workspaceStoragePath('/extension-storage', '/projects/a', 'sessions');
    const projectB = workspaceStoragePath('/extension-storage', '/projects/b', 'sessions');

    expect(projectA).not.toBe(projectB);
    expect(projectA).toContain('/workspaces/');
    expect(projectB).toContain('/workspaces/');
  });

  it('normalizes equivalent workspace paths to the same directory', () => {
    expect(
      workspaceStoragePath('/extension-storage', '/projects/a/../a', 'codebase-index.json'),
    ).toBe(workspaceStoragePath('/extension-storage', '/projects/a', 'codebase-index.json'));
  });

  it('does not list or restore one workspace session from another workspace', async () => {
    const storageRoot = await mkdtemp(path.join(tmpdir(), 'dev-first-workspaces-'));
    try {
      const projectA = new SessionStore(workspaceStoragePath(storageRoot, '/projects/a', 'sessions'));
      const projectB = new SessionStore(workspaceStoragePath(storageRoot, '/projects/b', 'sessions'));
      await projectA.save({
        id: 'session-a',
        title: 'Project A',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        conversation: [{ role: 'user', content: 'A-only context' }],
        plan: null,
        todos: [],
        planVersion: 0,
        lastRequest: '',
        contextTokens: 0,
      });

      expect(await projectB.list()).toEqual([]);
      expect(await projectB.load('session-a')).toBeUndefined();
      expect(await projectA.list()).toHaveLength(1);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
