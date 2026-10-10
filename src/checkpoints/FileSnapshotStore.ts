import { promises as fs } from 'fs';
import * as path from 'path';
import { sha1Of, writeFileAtomic } from '../util/atomicWrite';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES = 200;
export const BINARY_SNIFF_BYTES = 8192;

export function isBinaryBuffer(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export interface FileSnapshotEntry {
  path: string;
  hash: string;
  size: number;
  mode: number;
  symlinkTarget?: string;
  absent?: boolean;
  capturedAt: number;
}

export interface SnapshotCaptureResult {
  captured: string[];
  skipped: string[];
  limited: boolean;
}

export function normalizeSnapshotPath(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return undefined;
  }
  const normalized = path.normalize(trimmed).split(path.sep).join('/');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return undefined;
  }
  return normalized;
}

export class FileSnapshotStore {
  private readonly indexCache = new Map<string, Record<string, FileSnapshotEntry>>();

  constructor(private readonly rootDir: string) {}

  async capture(runId: string, workspaceRoot: string, relPaths: string[]): Promise<SnapshotCaptureResult> {
    const key = this.segment(runId);
    const index = await this.loadIndex(runId);
    const captured: string[] = [];
    const skipped: string[] = [];
    let limited = false;
    let count = Object.keys(index).length;
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const raw of relPaths) {
      const normalized = normalizeSnapshotPath(raw);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      targets.push(normalized);
    }
    for (let i = 0; i < targets.length; i++) {
      const rel = targets[i];
      if (index[rel]) {
        continue;
      }
      if (count >= MAX_FILES) {
        limited = true;
        skipped.push(...targets.slice(i));
        break;
      }
      const absolute = path.join(workspaceRoot, ...rel.split('/'));
      try {
        const entry = await this.captureOne(key, absolute, rel);
        index[rel] = entry;
        count += 1;
        captured.push(rel);
      } catch {
        skipped.push(rel);
      }
    }
    await fs.mkdir(this.runDir(runId), { recursive: true });
    await writeFileAtomic(this.indexFile(runId), JSON.stringify(Object.values(index)));
    this.indexCache.set(key, index);
    return { captured, skipped, limited };
  }

  async readOriginal(runId: string, relPath: string): Promise<string | undefined> {
    const normalized = normalizeSnapshotPath(relPath);
    if (!normalized) {
      return undefined;
    }
    const index = await this.loadIndex(runId);
    const entry = index[normalized];
    if (!entry || entry.absent) {
      return undefined;
    }
    try {
      return await fs.readFile(this.copyPath(runId, normalized), 'utf-8');
    } catch {
      return undefined;
    }
  }

  hasCapture(runId: string, relPath: string): boolean {
    const normalized = normalizeSnapshotPath(relPath);
    if (!normalized) {
      return false;
    }
    return Boolean(this.indexCache.get(this.segment(runId))?.[normalized]);
  }

  async entry(runId: string, relPath: string): Promise<FileSnapshotEntry | undefined> {
    const normalized = normalizeSnapshotPath(relPath);
    if (!normalized) {
      return undefined;
    }
    return (await this.loadIndex(runId))[normalized];
  }

  async index(runId: string): Promise<FileSnapshotEntry[]> {
    return Object.values(await this.loadIndex(runId));
  }

  async remove(runId: string): Promise<void> {
    const key = this.segment(runId);
    this.indexCache.delete(key);
    await fs.rm(path.join(this.rootDir, key), { recursive: true, force: true }).catch(() => undefined);
  }

  async prune(keepRunIds: string[]): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir);
    } catch {
      return;
    }
    const keep = new Set(keepRunIds.map((id) => this.segment(id)));
    await Promise.all(
      entries.map(async (entry) => {
        if (keep.has(entry)) {
          return;
        }
        this.indexCache.delete(entry);
        await fs.rm(path.join(this.rootDir, entry), { recursive: true, force: true }).catch(() => undefined);
      }),
    );
  }

  private async captureOne(runId: string, absolute: string, rel: string): Promise<FileSnapshotEntry> {
    let info;
    try {
      info = await fs.lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return { path: rel, hash: sha1Of(Buffer.alloc(0)), size: 0, mode: 0, absent: true, capturedAt: Date.now() };
      }
      throw error;
    }
    let symlinkTarget: string | undefined;
    let targetInfo = info;
    let source = absolute;
    if (info.isSymbolicLink()) {
      symlinkTarget = path.resolve(path.dirname(absolute), await fs.readlink(absolute));
      targetInfo = await fs.stat(symlinkTarget);
      source = symlinkTarget;
    }
    if (!targetInfo.isFile() || targetInfo.size > MAX_FILE_BYTES) {
      throw new Error('unsupported file');
    }
    const bytes = await fs.readFile(source);
    if (isBinaryBuffer(bytes)) {
      throw new Error('binary file');
    }
    const mode = targetInfo.mode & 0o777;
    const destination = this.copyPath(runId, rel);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await writeFileAtomic(destination, bytes, mode);
    return {
      path: rel,
      hash: sha1Of(bytes),
      size: targetInfo.size,
      mode,
      ...(symlinkTarget ? { symlinkTarget } : {}),
      capturedAt: Date.now(),
    };
  }

  private async loadIndex(runId: string): Promise<Record<string, FileSnapshotEntry>> {
    const key = this.segment(runId);
    const cached = this.indexCache.get(key);
    if (cached) {
      return cached;
    }
    const index: Record<string, FileSnapshotEntry> = {};
    try {
      const raw = await fs.readFile(this.indexFile(key), 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && typeof (item as FileSnapshotEntry).path === 'string') {
            const entry = item as FileSnapshotEntry;
            index[entry.path] = entry;
          }
        }
      }
    } catch {}
    this.indexCache.set(key, index);
    return index;
  }

  private segment(runId: string): string {
    return runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private runDir(runId: string): string {
    return path.join(this.rootDir, this.segment(runId));
  }

  private indexFile(runId: string): string {
    return path.join(this.runDir(runId), 'index.json');
  }

  private copyPath(runId: string, relPath: string): string {
    return path.join(this.runDir(runId), 'files', ...relPath.split('/'));
  }
}
