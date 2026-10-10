import { promises as fs } from 'fs';
import * as path from 'path';
import { ChatMessage } from '../llm/types';
import { Plan, QueuedPromptRecord, SessionSummary, TodoItem, UiMessage } from '../shared/protocol';

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UiMessage[];
  conversation: ChatMessage[];
  plan: Plan | null;
  todos: TodoItem[];
  planVersion: number;
  lastRequest: string;
  contextTokens: number;
  queued?: QueuedPromptRecord[];
}

interface IndexEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class SessionStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async list(): Promise<SessionSummary[]> {
    const index = await this.readIndex();
    return Object.values(index)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        messageCount: entry.messageCount,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<StoredSession | undefined> {
    const primary = await this.readFile(this.filePath(id));
    if (primary) {
      return primary;
    }
    return this.readFile(`${this.filePath(id)}.bak`);
  }

  async save(session: StoredSession): Promise<void> {
    await this.enqueue(() => this.saveNow(session));
  }

  private async saveNow(session: StoredSession): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const trimmed: StoredSession = {
      ...session,
      messages: session.messages.slice(-400),
      conversation: session.conversation.slice(-200),
    };
    await this.writeAtomic(this.filePath(session.id), JSON.stringify(trimmed), true);
    const index = await this.readIndex();
    index[session.id] = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    };
    await this.writeAtomic(this.indexFile(), JSON.stringify(index, null, 2), false);
  }

  async delete(id: string): Promise<void> {
    await this.enqueue(async () => {
      await Promise.all([
        fs.rm(this.filePath(id), { force: true }),
        fs.rm(`${this.filePath(id)}.bak`, { force: true }),
        fs.rm(`${this.filePath(id)}.tmp`, { force: true }),
      ]);
      const index = await this.readIndex();
      delete index[id];
      await this.writeIndex(index);
    });
  }

  async rename(id: string, title: string): Promise<void> {
    const trimmed = title.trim().slice(0, 80);
    if (!trimmed) {
      return;
    }
    await this.enqueue(async () => {
      const session = await this.load(id);
      if (session) {
        session.title = trimmed;
        await this.saveNow(session);
        return;
      }
      const index = await this.readIndex();
      if (index[id]) {
        index[id].title = trimmed;
        await this.writeIndex(index);
      }
    });
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

  private async readFile(file: string): Promise<StoredSession | undefined> {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as StoredSession;
      return parsed?.id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async readIndex(): Promise<Record<string, IndexEntry>> {
    for (const file of [this.indexFile(), `${this.indexFile()}.bak`]) {
      try {
        const raw = await fs.readFile(file, 'utf-8');
        return (JSON.parse(raw) as Record<string, IndexEntry>) ?? {};
      } catch {
        continue;
      }
    }
    return {};
  }

  private async writeIndex(index: Record<string, IndexEntry>): Promise<void> {
    await this.writeAtomic(this.indexFile(), JSON.stringify(index, null, 2), false);
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
