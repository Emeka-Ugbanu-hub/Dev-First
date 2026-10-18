import { promises as fs } from 'fs';
import * as path from 'path';
import { ChatMessage } from '../llm/types';
import { Plan, PendingDecisionRecord, PlanningState, QueuedPromptRecord, SessionSummary, TodoItem, UiMessage } from '../shared/protocol';
import { rebuildContextIndex, messageHash } from './contextIndex';

export interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UiMessage[];
  conversation: ChatMessage[];
  plan: Plan | null;
  planningState?: PlanningState;
  todos: TodoItem[];
  planVersion: number;
  lastRequest: string;
  contextTokens: number;
  queued?: QueuedPromptRecord[];
  pending?: PendingDecisionRecord;
  archived?: { count: number; files: string[]; uiCount?: number };
  archiveUnavailable?: boolean;
}

export interface SessionContextEntry {
  index: number;
  messageId: string;
  files: string[];
  symbols: string[];
  planStepIds: string[];
  decisionIds: string[];
  toolNames: string[];
  summary?: string;
  createdAt: number;
  hash: string;
}

export interface SessionArchiveFile {
  sessionId: string;
  createdAt: number;
  conversation?: ChatMessage[];
  uiMessages?: UiMessage[];
  contextIndex?: SessionContextEntry[];
}

const SESSION_CONVERSATION_FLOOR = 4;
const SESSION_UI_FLOOR = 20;

interface IndexEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export class SessionStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly archiveThreshold = 5 * 1024 * 1024,
    private readonly archiveFileLimit = 20 * 1024 * 1024,
  ) {}

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

  async loadArchive(sessionId: string): Promise<ChatMessage[]> {
    const files = await this.archiveFiles(sessionId);
    const messages: ChatMessage[] = [];
    for (const entry of files) {
      const archive = await this.readArchive(entry.file);
      if (archive?.conversation?.length) {
        messages.push(...archive.conversation);
      }
    }
    return messages;
  }

  async loadArchiveUi(sessionId: string): Promise<UiMessage[]> {
    const files = await this.archiveFiles(sessionId);
    const messages: UiMessage[] = [];
    for (const entry of files) {
      const archive = await this.readArchive(entry.file);
      if (archive?.uiMessages?.length) messages.push(...archive.uiMessages);
    }
    return messages;
  }

  async loadContext(sessionId: string): Promise<{ active: SessionContextEntry[]; archived: SessionContextEntry[] }> {
    const files = await this.archiveFiles(sessionId);
    const archived: SessionContextEntry[] = [];
    for (const entry of files) {
      const archive = await this.readArchive(entry.file);
      if (archive?.contextIndex?.length) {
        archived.push(...archive.contextIndex);
      } else if (archive?.conversation?.length) {
        archived.push(...rebuildContextIndex(archive.conversation));
      }
    }
    const session = await this.load(sessionId);
    const conversation = session?.conversation ?? [];
    const stored = await this.readContextFile(sessionId);
    if (!stored) {
      return { active: rebuildContextIndex(conversation), archived };
    }
    const active = stored.slice(0, conversation.length).map((entry, index) => (entry.index === index ? entry : { ...entry, index }));
    if (active.length < conversation.length) {
      const missing = rebuildContextIndex(conversation.slice(active.length));
      for (const entry of missing) {
        active.push({ ...entry, index: active.length });
      }
    }
    return { active, archived };
  }

  async save(session: StoredSession, contextIndex: SessionContextEntry[] = []): Promise<void> {
    await this.enqueue(() => this.saveNow(session, contextIndex));
  }

  private async saveNow(session: StoredSession, contextIndex: SessionContextEntry[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    let active: StoredSession = session;
    let activeEntries = contextIndex;
    if (JSON.stringify(session).length > this.archiveThreshold) {
      const archivedUi = await this.loadArchiveUi(session.id);
      const uiSkip = this.archivedUiPrefixLength(session.messages, archivedUi);
      const uiPending: StoredSession = { ...session, messages: session.messages.slice(uiSkip) };
      const uiSplit = this.splitUiForArchive(uiPending);
      if (uiSplit) {
        try {
          const archived = await this.archiveUiOverflow(session.id, uiSplit.older);
          active = { ...uiSplit.active, archived: { count: 0, files: archived.files, uiCount: archived.count } };
        } catch {
          active = { ...session, archiveUnavailable: true };
        }
      }
      const conversation = active.conversation ?? [];
      const archivedMessages = await this.loadArchive(session.id);
      const skip = this.archivedPrefixLength(conversation, archivedMessages);
      const pending: StoredSession = { ...active, conversation: conversation.slice(skip) };
      const pendingEntries = contextIndex.length === conversation.length ? contextIndex.slice(skip) : contextIndex;
      const split = this.splitForArchive(pending, pendingEntries);
      if (split) {
        try {
          const archived = await this.archiveOverflow(session.id, split.older, split.entries);
          active = { ...split.active, archived: { ...(active.archived ?? { count: 0, files: [] }), count: archived.count, files: archived.files } };
          activeEntries = split.activeEntries;
        } catch {
          active = { ...session, archiveUnavailable: true };
          activeEntries = contextIndex;
        }
      }
    }
    await this.writeAtomic(this.filePath(session.id), JSON.stringify(active), true);
    await this.writeAtomic(this.contextFile(session.id), JSON.stringify(activeEntries), false);
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

  private archivedPrefixLength(conversation: ChatMessage[], archived: ChatMessage[]): number {
    if (archived.length === 0) {
      return 0;
    }
    let skip = 0;
    while (skip < conversation.length && skip < archived.length && messageHash(conversation[skip]) === messageHash(archived[skip])) {
      skip++;
    }
    return skip;
  }

  private archivedUiPrefixLength(messages: UiMessage[], archived: UiMessage[]): number {
    let skip = 0;
    while (skip < messages.length && skip < archived.length && messages[skip].id === archived[skip].id) skip++;
    return skip;
  }

  private splitUiForArchive(session: StoredSession): { older: UiMessage[]; active: StoredSession } | undefined {
    const messages = session.messages ?? [];
    const minActive = Math.min(SESSION_UI_FLOOR, messages.length);
    if (messages.length <= minActive) return undefined;
    const base = { ...session, messages: [], archived: undefined, archiveUnavailable: undefined };
    const baseSize = JSON.stringify(base).length;
    const sizes = messages.map((message) => JSON.stringify(message).length + 1);
    let remove = 0;
    let remaining = sizes.reduce((total, size) => total + size, 0);
    while (remove < messages.length - minActive && baseSize + remaining > this.archiveThreshold) {
      remaining -= sizes[remove++];
    }
    return remove > 0 ? { older: messages.slice(0, remove), active: { ...session, messages: messages.slice(remove) } } : undefined;
  }

  private splitForArchive(
    session: StoredSession,
    contextIndex: SessionContextEntry[],
  ): { older: ChatMessage[]; entries: SessionContextEntry[]; active: StoredSession; activeEntries: SessionContextEntry[] } | undefined {
    const conversation = session.conversation ?? [];
    const minActive = Math.min(SESSION_CONVERSATION_FLOOR, conversation.length);
    if (conversation.length <= minActive) {
      return undefined;
    }
    const base = { ...session, conversation: [], archived: undefined, archiveUnavailable: undefined };
    const baseSize = JSON.stringify(base).length;
    const sizes = conversation.map((message) => JSON.stringify(message).length + 1);
    let remove = 0;
    let remaining = sizes.reduce((total, size) => total + size, 0);
    while (remove < conversation.length - minActive && baseSize + remaining > this.archiveThreshold) {
      remaining -= sizes[remove];
      remove++;
    }
    if (remove === 0) {
      return undefined;
    }
    const older = conversation.slice(0, remove);
    const aligned = contextIndex.length === conversation.length ? contextIndex : undefined;
    const entries = aligned ? aligned.slice(0, remove) : rebuildContextIndex(older);
    const activeEntries = aligned
      ? aligned.slice(remove).map((entry, index) => (entry.index === index ? entry : { ...entry, index }))
      : [];
    return {
      older,
      entries,
      active: { ...session, conversation: conversation.slice(remove) },
      activeEntries,
    };
  }

  private async archiveOverflow(
    sessionId: string,
    older: ChatMessage[],
    entries: SessionContextEntry[],
  ): Promise<{ files: string[]; count: number }> {
    const files = await this.archiveFiles(sessionId);
    const count = (await this.loadArchive(sessionId)).length + older.length;
    const newest = files[files.length - 1];
    if (newest) {
      const current = await this.readArchive(newest.file);
      const merged: SessionArchiveFile = {
        sessionId,
        createdAt: Date.now(),
        conversation: [...(current?.conversation ?? []), ...older],
        contextIndex: [...(current?.contextIndex ?? []), ...entries],
        ...(current?.uiMessages ? { uiMessages: current.uiMessages } : {}),
      };
      if (JSON.stringify(merged).length <= this.archiveFileLimit) {
        await this.writeAtomic(newest.file, JSON.stringify(merged), true);
        return { files: files.map((entry) => entry.file).reverse(), count };
      }
    }
    const seq = newest ? newest.seq + 1 : 0;
    const file = this.archiveFile(sessionId, seq);
    await this.writeAtomic(
      file,
      JSON.stringify({ sessionId, createdAt: Date.now(), conversation: older, contextIndex: entries }),
      true,
    );
    return { files: [...files.map((entry) => entry.file), file].reverse(), count };
  }

  private async archiveUiOverflow(
    sessionId: string,
    older: UiMessage[],
  ): Promise<{ files: string[]; count: number }> {
    const files = await this.archiveFiles(sessionId);
    const count = (await this.loadArchiveUi(sessionId)).length + older.length;
    const newest = files[files.length - 1];
    if (newest) {
      const current = await this.readArchive(newest.file);
      const merged: SessionArchiveFile = {
        sessionId,
        createdAt: Date.now(),
        ...(current?.conversation ? { conversation: current.conversation } : {}),
        ...(current?.contextIndex ? { contextIndex: current.contextIndex } : {}),
        uiMessages: [...(current?.uiMessages ?? []), ...older],
      };
      if (JSON.stringify(merged).length <= this.archiveFileLimit) {
        await this.writeAtomic(newest.file, JSON.stringify(merged), true);
        return { files: files.map((entry) => entry.file).reverse(), count };
      }
    }
    const seq = newest ? newest.seq + 1 : 0;
    const file = this.archiveFile(sessionId, seq);
    await this.writeAtomic(file, JSON.stringify({ sessionId, createdAt: Date.now(), uiMessages: older }), true);
    return { files: [...files.map((entry) => entry.file), file].reverse(), count };
  }

  async delete(id: string): Promise<void> {
    await this.enqueue(async () => {
      const archives = await this.archiveFiles(id);
      await Promise.all([
        fs.rm(this.filePath(id), { force: true }),
        fs.rm(`${this.filePath(id)}.bak`, { force: true }),
        fs.rm(`${this.filePath(id)}.tmp`, { force: true }),
        fs.rm(this.contextFile(id), { force: true }),
        fs.rm(`${this.contextFile(id)}.bak`, { force: true }),
        fs.rm(`${this.contextFile(id)}.tmp`, { force: true }),
        ...archives.flatMap((entry) => [
          fs.rm(entry.file, { force: true }),
          fs.rm(`${entry.file}.bak`, { force: true }),
          fs.rm(`${entry.file}.tmp`, { force: true }),
        ]),
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
        const context = await this.loadContext(id);
        await this.saveNow(session, context.active);
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

  private contextFile(id: string): string {
    return path.join(this.dir, `${id}.context.json`);
  }

  private archiveFile(id: string, seq: number): string {
    return path.join(this.dir, seq === 0 ? `session.archive.${id}.json` : `session.archive.${id}.${seq}.json`);
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

  private async readContextFile(id: string): Promise<SessionContextEntry[] | undefined> {
    for (const file of [this.contextFile(id), `${this.contextFile(id)}.bak`]) {
      try {
        const raw = await fs.readFile(file, 'utf-8');
        const parsed = JSON.parse(raw) as SessionContextEntry[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async readArchive(file: string): Promise<SessionArchiveFile | undefined> {
    for (const candidate of [file, `${file}.bak`]) {
      try {
        const raw = await fs.readFile(candidate, 'utf-8');
        const parsed = JSON.parse(raw) as SessionArchiveFile;
        if (parsed && (parsed.conversation || parsed.contextIndex || parsed.uiMessages)) {
          return parsed;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private async archiveFiles(id: string): Promise<Array<{ file: string; seq: number }>> {
    const prefix = `session.archive.${id}`;
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .map((name) => {
        if (!name.startsWith(prefix)) {
          return undefined;
        }
        const match = /^(?:\.(\d+))?\.json$/.exec(name.slice(prefix.length));
        return match ? { name, seq: match[1] ? Number(match[1]) : 0 } : undefined;
      })
      .filter((entry): entry is { name: string; seq: number } => entry !== undefined && Number.isFinite(entry.seq))
      .map((entry) => ({ file: path.join(this.dir, entry.name), seq: entry.seq }))
      .sort((a, b) => a.seq - b.seq);
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
