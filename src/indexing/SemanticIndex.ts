import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { listWorkspaceFiles, TEXT_EXTENSIONS } from '../util/fsWalk';

const MAX_FILE_BYTES = 100_000;
const MAX_FILES = 2000;
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;

interface Chunk {
  start: number;
  end: number;
  text: string;
  vector: number[];
}

interface FileEntry {
  hash: string;
  chunks: Chunk[];
}

interface IndexData {
  version: 1;
  files: Record<string, FileEntry>;
}

export interface SemanticSearchResult {
  path: string;
  start: number;
  end: number;
  text: string;
  score: number;
}

export interface SemanticIndexOptions {
  root: string;
  storageFile: string;
  embed: (texts: string[]) => Promise<number[][]>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export class SemanticIndex {
  private data: IndexData = { version: 1, files: {} };
  private loaded = false;
  private building: Promise<void> | undefined;

  constructor(private readonly options: SemanticIndexOptions) {}

  async search(query: string, limit: number): Promise<SemanticSearchResult[]> {
    await this.ensureIndexed();
    const [vector] = await this.options.embed([query]);
    if (!vector?.length) {
      return [];
    }
    const scored: SemanticSearchResult[] = [];
    for (const [relPath, entry] of Object.entries(this.data.files)) {
      for (const chunk of entry.chunks) {
        if (!chunk.vector.length) {
          continue;
        }
        scored.push({
          path: relPath,
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
          score: cosine(vector, chunk.vector),
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(limit, 20)));
  }

  async ensureIndexed(): Promise<void> {
    if (this.building) {
      return this.building;
    }
    this.building = this.build().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  clear(): void {
    this.data = { version: 1, files: {} };
    this.loaded = true;
  }

  stats(): { files: number; chunks: number } {
    let chunks = 0;
    for (const entry of Object.values(this.data.files)) {
      chunks += entry.chunks.length;
    }
    return { files: Object.keys(this.data.files).length, chunks };
  }

  private async build(): Promise<void> {
    await this.load();
    const files = await listWorkspaceFiles(this.options.root, {
      extensions: TEXT_EXTENSIONS,
      maxEntries: MAX_FILES,
    });
    const fileSet = new Set(files);
    for (const rel of Object.keys(this.data.files)) {
      if (!fileSet.has(rel)) {
        delete this.data.files[rel];
      }
    }

    const pending: Array<{ rel: string; hash: string; chunks: Array<{ start: number; end: number; text: string }> }> = [];
    for (const rel of files) {
      if (this.options.signal?.aborted) {
        break;
      }
      const absolute = path.join(this.options.root, rel);
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(absolute, 'utf-8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) {
        continue;
      }
      const hash = createHash('sha1').update(content).digest('hex');
      if (this.data.files[rel]?.hash === hash) {
        continue;
      }
      pending.push({ rel, hash, chunks: chunkText(content) });
    }

    if (pending.length === 0) {
      this.options.onProgress?.('Semantic index is up to date.');
      return;
    }

    let updated = 0;
    for (let index = 0; index < pending.length; index++) {
      if (this.options.signal?.aborted) {
        break;
      }
      const item = pending[index];
      this.options.onProgress?.(`Indexing ${item.rel} (${index + 1}/${pending.length})…`);
      try {
        const vectors = await this.options.embed(item.chunks.map((chunk) => chunk.text));
        this.data.files[item.rel] = {
          hash: item.hash,
          chunks: item.chunks.map((chunk, chunkIndex) => ({
            ...chunk,
            vector: vectors[chunkIndex] ?? [],
          })),
        };
        updated++;
      } catch (error) {
        this.options.onProgress?.(
          `Indexing stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }

    if (updated > 0) {
      await this.save();
    }
    const stats = this.stats();
    this.options.onProgress?.(`Index ready: ${stats.files} files, ${stats.chunks} chunks.`);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.options.storageFile, 'utf-8');
      const parsed = JSON.parse(raw) as IndexData;
      if (parsed?.version === 1 && parsed.files) {
        this.data = parsed;
      }
    } catch {
      // no index yet
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.options.storageFile), { recursive: true });
    await fs.writeFile(this.options.storageFile, JSON.stringify(this.data));
  }
}

function chunkText(content: string): Array<{ start: number; end: number; text: string }> {
  const lines = content.split('\n');
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join('\n').trim();
    if (text.length >= 40) {
      chunks.push({ start: start + 1, end, text });
    }
    if (end >= lines.length) {
      break;
    }
  }
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
