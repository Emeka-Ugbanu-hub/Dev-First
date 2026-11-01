import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { writeFileAtomic } from '../util/atomicWrite';

const MAX_MEMORY_CHARS = 6000;
const MAX_ENTRY_CHARS = 800;
const HOT_ENTRY_LIMIT = 24;
const ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class MemoryStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly storageRoot: string,
  ) {}

  filePath(): string {
    const hash = createHash('sha1').update(this.workspaceRoot).digest('hex').slice(0, 16);
    return path.join(this.storageRoot, 'memory', `${hash}.md`);
  }

  private archivePath(): string {
    return `${this.filePath()}.archive`;
  }

  async read(): Promise<string> {
    await this.hygiene();
    return this.readRaw();
  }

  private async readRaw(): Promise<string> {
    try {
      const content = await fs.readFile(this.filePath(), 'utf-8');
      return content.slice(0, MAX_MEMORY_CHARS);
    } catch {
      return '';
    }
  }

  async recall(query?: string): Promise<string> {
    const content = await this.read();
    if (!content.trim()) {
      return 'No project memory saved yet.';
    }
    if (!query?.trim()) {
      return content;
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const lines = content
      .split('\n')
      .filter((line) => terms.some((term) => line.toLowerCase().includes(term)));
    return lines.length > 0 ? lines.join('\n') : `No memory entries matched "${query}".`;
  }

  async save(content: string, section = 'Notes'): Promise<string> {
    const entry = redactMemory(content.trim()).slice(0, MAX_ENTRY_CHARS);
    if (!entry) {
      return 'Error: nothing to save.';
    }
    const existing = await this.readRaw();
    const heading = `## ${section.trim() || 'Notes'}`;
    const bullet = `- ${entry}`;
    if (existing.split('\n').some((line) => line.trim() === bullet)) {
      return `Memory already contains this entry (${section}).`;
    }
    let updated: string;
    if (existing.includes(heading)) {
      updated = `${existing.replace(heading, `${heading}\n${bullet}`)}`;
    } else {
      updated = `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${heading}\n${bullet}`;
    }
    await writeFileAtomic(this.filePath(), updated.trimStart(), 0o600);
    await this.hygiene();
    return `Saved to project memory (${section}).`;
  }

  async replace(content: string): Promise<void> {
    await writeFileAtomic(this.filePath(), redactMemory(content).slice(0, MAX_MEMORY_CHARS), 0o600);
    await this.hygiene();
  }

  /** Keep the hot memory small and move old entries out of the prompt path. */
  private async hygiene(): Promise<void> {
    const archive = this.archivePath();
    try {
      const stat = await fs.stat(archive);
      if (Date.now() - stat.mtimeMs > ARCHIVE_RETENTION_MS) {
        await fs.rm(archive, { force: true });
      }
    } catch {}

    let content: string;
    try {
      content = await fs.readFile(this.filePath(), 'utf-8');
    } catch {
      return;
    }
    const lines = content.split('\n');
    const bullets = lines.filter((line) => line.trimStart().startsWith('- '));
    if (bullets.length <= HOT_ENTRY_LIMIT && content.length <= MAX_MEMORY_CHARS) {
      return;
    }
    const keep = new Set(bullets.slice(-HOT_ENTRY_LIMIT));
    const archived = lines.filter((line) => line.trimStart().startsWith('- ') && !keep.has(line));
    const hot = lines.filter((line) => !line.trimStart().startsWith('- ') || keep.has(line)).join('\n').trim();
    if (archived.length > 0) {
      let prior = '';
      try { prior = await fs.readFile(archive, 'utf-8'); } catch {}
      await writeFileAtomic(archive, `${prior}${prior ? '\n' : ''}${new Date().toISOString()}\n${archived.join('\n')}`.slice(-20_000), 0o600);
    }
    await writeFileAtomic(this.filePath(), hot.slice(0, MAX_MEMORY_CHARS), 0o600);
  }
}

function redactMemory(value: string): string {
  return value
    .replace(/(api[_-]?key|authorization|bearer|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]');
}
