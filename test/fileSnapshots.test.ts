import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { cleanupStaleTemps, sha1Of, writeFileAtomic } from '../src/util/atomicWrite';
import {
  FileSnapshotStore,
  MAX_FILES,
  MAX_FILE_BYTES,
  isBinaryBuffer,
  normalizeSnapshotPath,
} from '../src/checkpoints/FileSnapshotStore';

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'df-snapshots-'));
  workspace = await mkdtemp(path.join(tmpdir(), 'df-snapshots-ws-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe('normalizeSnapshotPath', () => {
  it('normalizes workspace-relative paths and rejects escapes', () => {
    expect(normalizeSnapshotPath('src/./a.ts')).toBe('src/a.ts');
    expect(normalizeSnapshotPath('src/../b.ts')).toBe('b.ts');
    expect(normalizeSnapshotPath('../outside.ts')).toBeUndefined();
    expect(normalizeSnapshotPath('/etc/hosts')).toBeUndefined();
    expect(normalizeSnapshotPath('')).toBeUndefined();
    expect(normalizeSnapshotPath('.')).toBeUndefined();
    expect(normalizeSnapshotPath('..')).toBeUndefined();
  });
});

describe('isBinaryBuffer', () => {
  it('detects NUL bytes in the first 8 KB', () => {
    expect(isBinaryBuffer(Buffer.from('plain text'))).toBe(false);
    expect(isBinaryBuffer(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(isBinaryBuffer(Buffer.concat([Buffer.alloc(8192, 0x41), Buffer.from([0x00])]))).toBe(false);
  });
});

describe('FileSnapshotStore', () => {
  it('captures originals, reopens, and reverts in a non-git workspace', async () => {
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(path.join(workspace, 'src/a.ts'), 'before', 'utf-8');
    const store = new FileSnapshotStore(root);
    const result = await store.capture('r1', workspace, ['src/a.ts']);
    expect(result).toEqual({ captured: ['src/a.ts'], skipped: [], limited: false });
    expect(store.hasCapture('r1', 'src/a.ts')).toBe(true);
    expect(store.hasCapture('r1', 'src/b.ts')).toBe(false);

    await writeFile(path.join(workspace, 'src/a.ts'), 'after', 'utf-8');
    const reopened = new FileSnapshotStore(root);
    const entries = await reopened.index('r1');
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('src/a.ts');
    expect(entries[0].hash).toBe(sha1Of('before'));
    expect(entries[0].size).toBe(Buffer.byteLength('before'));
    const original = await reopened.readOriginal('r1', 'src/a.ts');
    expect(original).toBe('before');
    await writeFileAtomic(path.join(workspace, 'src/a.ts'), original!, entries[0].mode);
    expect(await readFile(path.join(workspace, 'src/a.ts'), 'utf-8')).toBe('before');
  });

  it('records an absent original and reverts a created file by deletion', async () => {
    const store = new FileSnapshotStore(root);
    const result = await store.capture('r1', workspace, ['new.ts']);
    expect(result.captured).toEqual(['new.ts']);
    const [entry] = await store.index('r1');
    expect(entry.absent).toBe(true);
    expect(await store.readOriginal('r1', 'new.ts')).toBeUndefined();

    await writeFile(path.join(workspace, 'new.ts'), 'created', 'utf-8');
    await rm(path.join(workspace, 'new.ts'), { force: true });
    expect(existsSync(path.join(workspace, 'new.ts'))).toBe(false);
  });

  it('ignores paths that escape the workspace root', async () => {
    const store = new FileSnapshotStore(root);
    const result = await store.capture('r1', workspace, ['../outside.ts', '/etc/hosts', '..']);
    expect(result).toEqual({ captured: [], skipped: [], limited: false });
    expect(await store.index('r1')).toEqual([]);
  });

  it('keeps the first capture for a path', async () => {
    await writeFile(path.join(workspace, 'a.ts'), 'first', 'utf-8');
    const store = new FileSnapshotStore(root);
    await store.capture('r1', workspace, ['a.ts']);
    await writeFile(path.join(workspace, 'a.ts'), 'second', 'utf-8');
    const result = await store.capture('r1', workspace, ['a.ts']);
    expect(result.captured).toEqual([]);
    expect(await store.readOriginal('r1', 'a.ts')).toBe('first');
  });

  it('follows symlinks when capturing and writing and preserves the link', async () => {
    const target = path.join(workspace, 'target.txt');
    const link = path.join(workspace, 'link.txt');
    await writeFile(target, 'original', 'utf-8');
    await symlink(target, link);
    const store = new FileSnapshotStore(root);
    const result = await store.capture('r1', workspace, ['link.txt']);
    expect(result.captured).toEqual(['link.txt']);
    const [entry] = await store.index('r1');
    expect(entry.symlinkTarget).toBe(target);
    expect(await store.readOriginal('r1', 'link.txt')).toBe('original');

    await writeFileAtomic(link, 'updated');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe('updated');

    await writeFileAtomic(link, (await store.readOriginal('r1', 'link.txt'))!);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe('original');
  });

  it('skips oversized and binary files', async () => {
    await writeFile(path.join(workspace, 'big.ts'), Buffer.alloc(MAX_FILE_BYTES + 1));
    await writeFile(path.join(workspace, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
    const store = new FileSnapshotStore(root);
    const result = await store.capture('r1', workspace, ['big.ts', 'bin.dat']);
    expect(result.captured).toEqual([]);
    expect([...result.skipped].sort()).toEqual(['big.ts', 'bin.dat']);
    expect(result.limited).toBe(false);
  });

  it('stops at the per-run file cap and marks the capture limited', async () => {
    const files = Array.from({ length: MAX_FILES + 3 }, (_, index) => `f${index}.txt`);
    await Promise.all(files.map((file) => writeFile(path.join(workspace, file), file, 'utf-8')));
    const store = new FileSnapshotStore(root);
    const result = await store.capture('r1', workspace, files);
    expect(result.captured).toHaveLength(MAX_FILES);
    expect(result.limited).toBe(true);
    expect(result.skipped).toHaveLength(3);
  });

  it('treats a corrupt index as empty', async () => {
    const store = new FileSnapshotStore(root);
    await store.capture('r1', workspace, []);
    await writeFile(path.join(root, 'r1', 'index.json'), '{not json', 'utf-8');
    const reopened = new FileSnapshotStore(root);
    expect(await reopened.index('r1')).toEqual([]);
    expect(reopened.hasCapture('r1', 'a.ts')).toBe(false);
    expect(await reopened.readOriginal('r1', 'a.ts')).toBeUndefined();
  });

  it('prunes unlisted runs and removes one on demand', async () => {
    await writeFile(path.join(workspace, 'a.ts'), 'a', 'utf-8');
    const store = new FileSnapshotStore(root);
    await store.capture('r1', workspace, ['a.ts']);
    await store.capture('r2', workspace, ['a.ts']);
    await store.prune(['r1']);
    expect(existsSync(path.join(root, 'r1'))).toBe(true);
    expect(existsSync(path.join(root, 'r2'))).toBe(false);
    await store.remove('r1');
    expect(existsSync(path.join(root, 'r1'))).toBe(false);
  });
});

describe('writeFileAtomic', () => {
  it('preserves permissions', async () => {
    const file = path.join(workspace, 'script.sh');
    await writeFile(file, 'echo hi', 'utf-8');
    await chmod(file, 0o755);
    await writeFileAtomic(file, 'echo bye');
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });

  it('applies an explicit mode when provided', async () => {
    const file = path.join(workspace, 'fresh.sh');
    await writeFileAtomic(file, 'echo new', 0o744);
    expect((await stat(file)).mode & 0o777).toBe(0o744);
  });

  it('creates missing parent directories', async () => {
    const file = path.join(workspace, 'nested/deep/file.ts');
    await writeFileAtomic(file, 'content');
    expect(await readFile(file, 'utf-8')).toBe('content');
  });

  it('leaves the target intact when the temp write fails', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const dir = path.join(workspace, 'locked');
    await mkdir(dir);
    const target = path.join(dir, 'file.txt');
    await writeFile(target, 'original', 'utf-8');
    await chmod(dir, 0o555);
    try {
      await expect(writeFileAtomic(target, 'updated')).rejects.toBeDefined();
      expect(await readFile(target, 'utf-8')).toBe('original');
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it('removes stale temp files and keeps fresh ones', async () => {
    const staleA = path.join(workspace, '.a.dev-first-dead.tmp');
    const staleB = path.join(workspace, '.dev-first-dead.tmp');
    const fresh = path.join(workspace, '.fresh.dev-first-live.tmp');
    await writeFile(staleA, 'tmp', 'utf-8');
    await writeFile(staleB, 'tmp', 'utf-8');
    await writeFile(fresh, 'tmp', 'utf-8');
    await writeFile(path.join(workspace, 'keep.ts'), 'keep', 'utf-8');
    const old = (Date.now() - 60_000) / 1000;
    await utimes(staleA, old, old);
    await utimes(staleB, old, old);
    await cleanupStaleTemps(workspace, 1000);
    expect(existsSync(staleA)).toBe(false);
    expect(existsSync(staleB)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path.join(workspace, 'keep.ts'))).toBe(true);
  });

  it('ignores a missing directory', async () => {
    await expect(cleanupStaleTemps(path.join(workspace, 'nope'), 1000)).resolves.toBeUndefined();
  });
});
