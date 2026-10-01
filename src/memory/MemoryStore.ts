import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const MAX_MEMORY_CHARS = 6000;
const MAX_ENTRY_CHARS = 800;

export class MemoryStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly storageRoot: string,
  ) {}

  filePath(): string {
    const hash = createHash('sha1').update(this.workspaceRoot).digest('hex').slice(0, 16);
    return path.join(this.storageRoot, 'memory', `${hash}.md`);
  }

  async read(): Promise<string> {
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
    const entry = content.trim().slice(0, MAX_ENTRY_CHARS);
    if (!entry) {
      return 'Error: nothing to save.';
    }
    const existing = await this.read();
    const heading = `## ${section.trim() || 'Notes'}`;
    let updated: string;
    if (existing.includes(heading)) {
      updated = `${existing.replace(heading, `${heading}\n- ${entry}`)}`;
    } else {
      updated = `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${heading}\n- ${entry}`;
    }
    await fs.mkdir(path.dirname(this.filePath()), { recursive: true });
    await fs.writeFile(this.filePath(), updated.trimStart(), 'utf-8');
    return `Saved to project memory (${section}).`;
  }

  async replace(content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath()), { recursive: true });
    await fs.writeFile(this.filePath(), content.slice(0, MAX_MEMORY_CHARS), 'utf-8');
  }
}
