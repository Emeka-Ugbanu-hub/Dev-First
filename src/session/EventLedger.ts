import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomId } from '../util/id';

export type LedgerEventKind =
  | 'message'
  | 'route'
  | 'stage'
  | 'tool'
  | 'plan'
  | 'state'
  | 'compaction'
  | 'checkpoint';

export interface LedgerEvent {
  id: string;
  sessionId: string;
  taskId?: string;
  kind: LedgerEventKind;
  at: number;
  payload: Record<string, unknown>;
}

export interface LedgerProjection {
  sessionId: string;
  taskId?: string;
  state?: string;
  latestRoute?: string;
  latestStage?: string;
  completedSteps: number[];
  nextSteps: number[];
  blockers: string[];
  changedFiles: string[];
  recent: Array<Pick<LedgerEvent, 'kind' | 'at' | 'payload'>>;
}

const MAX_EVENTS = 1200;
const MAX_RECENT = 16;

/**
 * Append-only, session-scoped state journal. Writes are serialized and
 * fire-and-forget at call sites, so persistence never sits on the model's
 * first-token path. The projection is intentionally deterministic and small;
 * it is safe to inject into a later request after compaction or restart.
 */
export class EventLedger {
  private sessionId: string;
  private taskId: string | undefined;
  private readonly dir: string;
  private writes: Promise<void> = Promise.resolve();
  private eventCount = 0;
  private projection: LedgerProjection;

  constructor(rootDir: string, sessionId: string) {
    this.dir = path.resolve(rootDir);
    this.sessionId = sessionId;
    this.projection = emptyProjection(sessionId);
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.projection = emptyProjection(sessionId);
    this.eventCount = 0;
  }

  setTask(taskId: string | undefined): void {
    this.taskId = taskId;
    this.projection.taskId = taskId;
  }

  async flush(): Promise<void> {
    await this.writes;
  }

  snapshot(): LedgerProjection {
    return {
      ...this.projection,
      completedSteps: [...this.projection.completedSteps],
      nextSteps: [...this.projection.nextSteps],
      blockers: [...this.projection.blockers],
      changedFiles: [...this.projection.changedFiles],
      recent: this.projection.recent.map((entry) => ({ ...entry, payload: { ...entry.payload } })),
    };
  }

  condensed(maxChars = 1800): string | undefined {
    const state = this.projection;
    const lines = [
      '[Durable task ledger — deterministic checkpoint]',
      state.state ? `State: ${state.state}` : '',
      state.latestRoute ? `Last route: ${state.latestRoute}` : '',
      state.latestStage ? `Last stage: ${state.latestStage}` : '',
      state.completedSteps.length ? `Completed steps: ${state.completedSteps.join(', ')}` : '',
      state.nextSteps.length ? `Next steps: ${state.nextSteps.join(', ')}` : '',
      state.blockers.length ? `Blockers: ${state.blockers.slice(-4).join('; ')}` : '',
      state.changedFiles.length ? `Changed files: ${state.changedFiles.slice(-12).join(', ')}` : '',
    ].filter(Boolean);
    if (lines.length <= 1 && state.recent.length === 0) return undefined;
    const text = lines.join('\n');
    return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 20))}\n… [ledger capped]`;
  }

  append(kind: LedgerEventKind, payload: Record<string, unknown>): void {
    const event: LedgerEvent = {
      id: randomId('event'),
      sessionId: this.sessionId,
      ...(this.taskId ? { taskId: this.taskId } : {}),
      kind,
      at: Date.now(),
      payload,
    };
    this.apply(event);
    const eventPath = this.eventsPath();
    this.writes = this.writes.then(async () => {
      try {
        await fs.mkdir(this.dir, { recursive: true });
        await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8');
        this.eventCount += 1;
        if (this.eventCount % 24 === 0) {
          await this.writeSnapshot();
          await this.pruneEvents(eventPath);
        }
      } catch {
        // Ledger durability is best-effort and must never interrupt a run.
      }
    });
  }

  async hydrate(): Promise<void> {
    try {
      const raw = await fs.readFile(this.eventsPath(), 'utf8');
      const lines = raw.split('\n').filter(Boolean).slice(-MAX_EVENTS);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as LedgerEvent;
          if (event.sessionId === this.sessionId && event.kind && event.payload) this.apply(event);
        } catch {}
      }
      this.eventCount = lines.length;
    } catch {
      // New sessions do not have a ledger yet.
    }
  }

  private apply(event: LedgerEvent): void {
    const payload = event.payload;
    if (event.taskId) this.projection.taskId = event.taskId;
    if (event.kind === 'route' && typeof payload.route === 'string') this.projection.latestRoute = payload.route;
    if (event.kind === 'stage' && typeof payload.stage === 'string') this.projection.latestStage = payload.stage;
    if (event.kind === 'state') {
      if (typeof payload.state === 'string') this.projection.state = payload.state;
      if (Array.isArray(payload.completedSteps)) this.projection.completedSteps = numbers(payload.completedSteps);
      if (Array.isArray(payload.nextSteps)) this.projection.nextSteps = numbers(payload.nextSteps);
      if (Array.isArray(payload.blockers)) this.projection.blockers = strings(payload.blockers);
    }
    if (event.kind === 'tool' && Array.isArray(payload.changedFiles)) {
      this.projection.changedFiles = [...new Set([...this.projection.changedFiles, ...strings(payload.changedFiles)])].slice(-64);
    }
    this.projection.recent = [
      ...this.projection.recent,
      { kind: event.kind, at: event.at, payload: { ...payload } },
    ].slice(-MAX_RECENT);
  }

  private eventsPath(): string {
    return path.join(this.dir, `${safeName(this.sessionId)}.jsonl`);
  }

  private async writeSnapshot(): Promise<void> {
    const file = path.join(this.dir, `${safeName(this.sessionId)}.snapshot.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.projection), 'utf8');
    await fs.rename(tmp, file);
  }

  private async pruneEvents(file: string): Promise<void> {
    try {
      const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
      if (lines.length <= MAX_EVENTS) return;
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, `${lines.slice(-MAX_EVENTS).join('\n')}\n`, 'utf8');
      await fs.rename(tmp, file);
    } catch {
      // Pruning is optional; the append-only log remains the source of truth.
    }
  }
}

function emptyProjection(sessionId: string): LedgerProjection {
  return { sessionId, completedSteps: [], nextSteps: [], blockers: [], changedFiles: [], recent: [] };
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'session';
}

function numbers(value: unknown[]): number[] {
  return [...new Set(value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry)))].sort((a, b) => a - b);
}

function strings(value: unknown[]): string[] {
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
}
