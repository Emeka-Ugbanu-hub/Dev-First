import { promises as fs } from 'fs';
import * as path from 'path';
import { RunRecord, RunStatus } from '../shared/protocol';

export const MAX_RUNS = 20;
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const MAX_OPERATIONS = 500;

const PROTECTED_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'executing',
  'waiting',
  'interrupted',
  'approved',
  'planned',
]);

export function shouldPrune(run: RunRecord, now: number): boolean {
  if (PROTECTED_STATUSES.has(run.status)) {
    return false;
  }
  return now - run.updatedAt > MAX_AGE_MS;
}

export class RunJournalStore {
  private readonly dir: string;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(rootDir: string) {
    const resolved = path.resolve(rootDir);
    this.dir = path.basename(resolved) === 'runs' ? resolved : path.join(resolved, 'runs');
  }

  async save(run: RunRecord): Promise<void> {
    await this.enqueue(() => this.saveNow(run));
  }

  private async saveNow(run: RunRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const record: RunRecord = {
      ...run,
      operations: run.operations.slice(-MAX_OPERATIONS),
      completedSteps: [...new Set(run.completedSteps)].sort((a, b) => a - b),
    };
    await this.writeAtomic(this.filePath(record.id), JSON.stringify(record), true);
    const index = (await this.readIndex()) ?? (await this.scanIndex());
    index[record.id] = record;
    await this.writeAtomic(this.indexFile(), JSON.stringify(Object.values(index)), true);
    await this.prune(Date.now());
  }

  async load(id: string): Promise<RunRecord | undefined> {
    const primary = await this.readRun(this.filePath(id));
    if (primary) {
      return primary;
    }
    return this.readRun(`${this.filePath(id)}.bak`);
  }

  async list(): Promise<RunRecord[]> {
    const index = await this.readIndex();
    const runs = index ? Object.values(index) : await this.scan();
    return runs
      .filter((run): run is RunRecord => Boolean(run && typeof run.id === 'string'))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(id: string): Promise<void> {
    await this.enqueue(() => this.removeNow(id));
  }

  private async removeNow(id: string): Promise<void> {
    await Promise.all([
      fs.rm(this.filePath(id), { force: true }),
      fs.rm(`${this.filePath(id)}.bak`, { force: true }),
      fs.rm(`${this.filePath(id)}.tmp`, { force: true }),
    ]);
    const index = (await this.readIndex()) ?? (await this.scanIndex());
    delete index[id];
    await fs.mkdir(this.dir, { recursive: true });
    await this.writeAtomic(this.indexFile(), JSON.stringify(Object.values(index)), true);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writes.then(task);
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  private async readRun(file: string): Promise<RunRecord | undefined> {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as RunRecord;
      return parsed?.id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async readIndex(): Promise<Record<string, RunRecord> | undefined> {
    for (const file of [this.indexFile(), `${this.indexFile()}.bak`]) {
      try {
        const raw = await fs.readFile(file, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        const entries = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, RunRecord>);
        const index: Record<string, RunRecord> = {};
        for (const entry of entries) {
          if (entry && typeof entry === 'object' && typeof (entry as RunRecord).id === 'string') {
            index[(entry as RunRecord).id] = entry as RunRecord;
          }
        }
        return index;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async scanIndex(): Promise<Record<string, RunRecord>> {
    const index: Record<string, RunRecord> = {};
    for (const run of await this.scan()) {
      index[run.id] = run;
    }
    return index;
  }

  private async scan(): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'index.json') {
        continue;
      }
      const run = await this.readRun(path.join(this.dir, entry));
      if (run) {
        runs.push(run);
      }
    }
    return runs;
  }

  private async prune(now: number): Promise<void> {
    const all = (await this.readIndex()) ?? (await this.scanIndex());
    const ordered = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = new Set<string>();
    let count = 0;
    for (const run of ordered) {
      const protectedRun = PROTECTED_STATUSES.has(run.status);
      if (protectedRun || (!shouldPrune(run, now) && count < MAX_RUNS)) {
        keep.add(run.id);
        if (!protectedRun) {
          count += 1;
        }
      }
    }
    const removed = ordered.filter((run) => !keep.has(run.id));
    if (removed.length === 0) {
      return;
    }
    await Promise.all(
      removed.map((run) =>
        Promise.all([
          fs.rm(this.filePath(run.id), { force: true }),
          fs.rm(`${this.filePath(run.id)}.bak`, { force: true }),
          fs.rm(`${this.filePath(run.id)}.tmp`, { force: true }),
        ]).then(() => undefined),
      ),
    );
    const survivors: Record<string, RunRecord> = {};
    for (const run of ordered) {
      if (keep.has(run.id)) {
        survivors[run.id] = run;
      }
    }
    await this.writeAtomic(this.indexFile(), JSON.stringify(Object.values(survivors)), true);
  }

  private async writeAtomic(file: string, data: string, backup: boolean): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(data, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (backup) {
      try {
        await fs.rename(file, `${file}.bak`);
      } catch {}
    }
    await fs.rename(tmp, file);
  }
}
