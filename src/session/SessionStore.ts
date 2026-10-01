import { promises as fs } from 'fs';
import * as path from 'path';
import { ChatMessage } from '../llm/types';
import { Plan, SessionSummary, TodoItem, UiMessage } from '../shared/protocol';

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
}

interface IndexEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class SessionStore {
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
    try {
      const raw = await fs.readFile(this.filePath(id), 'utf-8');
      const parsed = JSON.parse(raw) as StoredSession;
      return parsed?.id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async save(session: StoredSession): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const trimmed: StoredSession = {
      ...session,
      messages: session.messages.slice(-400),
      conversation: session.conversation.slice(-200),
    };
    await fs.writeFile(this.filePath(session.id), JSON.stringify(trimmed));
    const index = await this.readIndex();
    index[session.id] = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    };
    await this.writeIndex(index);
  }

  async delete(id: string): Promise<void> {
    await fs.rm(this.filePath(id), { force: true });
    const index = await this.readIndex();
    delete index[id];
    await this.writeIndex(index);
  }

  async rename(id: string, title: string): Promise<void> {
    const trimmed = title.trim().slice(0, 80);
    if (!trimmed) {
      return;
    }
    const session = await this.load(id);
    if (session) {
      session.title = trimmed;
      await this.save(session);
      return;
    }
    const index = await this.readIndex();
    if (index[id]) {
      index[id].title = trimmed;
      await this.writeIndex(index);
    }
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private indexFile(): string {
    return path.join(this.dir, 'index.json');
  }

  private async readIndex(): Promise<Record<string, IndexEntry>> {
    try {
      const raw = await fs.readFile(this.indexFile(), 'utf-8');
      return (JSON.parse(raw) as Record<string, IndexEntry>) ?? {};
    } catch {
      return {};
    }
  }

  private async writeIndex(index: Record<string, IndexEntry>): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.indexFile(), JSON.stringify(index, null, 2));
  }
}
