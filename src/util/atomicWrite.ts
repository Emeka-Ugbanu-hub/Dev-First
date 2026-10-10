import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';

export function sha1Of(content: string | Buffer): string {
  return createHash('sha1').update(content).digest('hex');
}

export async function writeFileAtomic(target: string, content: string | Buffer, mode?: number): Promise<void> {
  let resolved = target;
  let existingMode: number | undefined;
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) {
      resolved = await fs.realpath(target);
      const targetInfo = await fs.stat(resolved);
      existingMode = targetInfo.mode;
    } else {
      existingMode = info.mode;
    }
  } catch {
    resolved = target;
  }
  const directory = path.dirname(resolved);
  const basename = path.basename(resolved);
  const activeMode = mode ?? existingMode;
  await fs.mkdir(directory, { recursive: true });
  const tmp = path.join(directory, `.${basename}.dev-first-${randomBytes(6).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'w', activeMode ?? 0o666);
    await handle.writeFile(content);
    await handle.sync();
    if (activeMode !== undefined) {
      await handle.chmod(activeMode & 0o777);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmp, resolved);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

export async function cleanupStaleTemps(dir: string, maxAgeMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.endsWith('.tmp') || !entry.includes('.dev-first-')) {
        return;
      }
      const target = path.join(dir, entry);
      try {
        const info = await fs.stat(target);
        if (now - info.mtimeMs > maxAgeMs) {
          await fs.rm(target, { force: true });
        }
      } catch {}
    }),
  );
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
}
