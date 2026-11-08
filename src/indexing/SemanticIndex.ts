import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { listWorkspaceFilesDetailed, TEXT_EXTENSIONS } from '../util/fsWalk';

const MAX_FILE_BYTES = 100_000;
const DEFAULT_MAX_FILES = 2000;
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const EXCLUDED_SEGMENTS = /(^|\/)(__tests?__|tests?|specs?|fixtures?|mocks?|snapshots?|dist|build|coverage|node_modules)(\/|$)/i;
const EXCLUDED_EXTENSIONS = /\.(?:test|spec)\.[^.]+$|\.(?:md|mdx|lock|json|ya?ml|toml|css|scss|less|html?)$/i;

interface Chunk {
  start: number;
  end: number;
  text: string;
  vector: number[];
}

interface FileEntry {
  hash: string;
  chunks: Chunk[];
  size?: number;
  mtimeMs?: number;
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
  maxFiles?: number;
}

function isSemanticCandidate(relative: string): boolean {
  return !EXCLUDED_SEGMENTS.test(relative) && !EXCLUDED_EXTENSIONS.test(relative);
}

export class SemanticIndex {
  private data: IndexData = { version: 1, files: {} };
  private loaded = false;
  private building: Promise<void> | undefined;
  private dirty = true;
  private fullScan = true;
  private readonly pendingFiles = new Set<string>();
  private readonly maxFiles: number;
  private coverage = { scannedFiles: 0, truncated: false, skippedFiles: 0 };
  private lastSaveAt = 0;

  constructor(private readonly options: SemanticIndexOptions) {
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  }

  startBackgroundIndex(): void {
    if (!this.dirty || this.building) return;
    void this.ensureIndexed().catch(() => undefined);
  }

  async ready(): Promise<boolean> {
    await this.load();
    return this.loaded && !this.dirty;
  }

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
    await this.load();
    if (!this.dirty && this.loaded) {
      return;
    }
    if (this.building) {
      return this.building;
    }
    this.building = this.build().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  invalidate(filePath?: string): void {
    this.dirty = true;
    if (filePath) {
      const relative = path.relative(this.options.root, path.resolve(filePath));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        this.pendingFiles.add(relative.split(path.sep).join('/'));
        return;
      }
    }
    this.fullScan = true;
  }

  clear(): void {
    this.data = { version: 1, files: {} };
    this.loaded = true;
    this.dirty = true;
    this.fullScan = true;
    this.pendingFiles.clear();
    this.coverage = { scannedFiles: 0, truncated: false, skippedFiles: 0 };
  }

  stats(): {
    files: number;
    chunks: number;
    ready: boolean;
    truncated: boolean;
    maxFiles: number;
    scannedFiles: number;
    skippedFiles: number;
  } {
    let chunks = 0;
    for (const entry of Object.values(this.data.files)) {
      chunks += entry.chunks.length;
    }
    return {
      files: Object.keys(this.data.files).length,
      chunks,
      ready: this.loaded && !this.dirty,
      truncated: this.coverage.truncated,
      maxFiles: this.maxFiles,
      scannedFiles: this.coverage.scannedFiles,
      skippedFiles: this.coverage.skippedFiles,
    };
  }

  private async build(): Promise<void> {
    if (!this.fullScan && this.pendingFiles.size > 0) {
      await this.buildPending();
      return;
    }
    const listing = await listWorkspaceFilesDetailed(this.options.root, {
      extensions: TEXT_EXTENSIONS,
      maxEntries: this.maxFiles * 4,
    });
    const candidates = listing.files.filter(isSemanticCandidate);
    const files = candidates.slice(0, this.maxFiles);
    this.coverage = {
      scannedFiles: listing.files.length,
      truncated: listing.truncated || candidates.length > this.maxFiles,
      skippedFiles: listing.files.length - candidates.length,
    };
    const fileSet = new Set(files);
    for (const rel of Object.keys(this.data.files)) {
      if (!fileSet.has(rel)) {
        delete this.data.files[rel];
      }
    }

    let updated = 0;
    let paused = false;
    for (let index = 0; index < files.length; index++) {
      if (this.options.signal?.aborted) {
        paused = true;
        break;
      }
      const rel = files[index];
      this.options.onProgress?.(`Indexing ${rel} (${index + 1}/${files.length})…`);
      try {
        if (await this.updateFile(rel)) {
          updated++;
          await this.maybeSave(updated);
        }
      } catch (error) {
        this.options.onProgress?.(
          `Semantic indexing paused: ${error instanceof Error ? error.message : String(error)}`,
        );
        paused = true;
        break;
      }
    }
    this.fullScan = false;
    this.loaded = true;
    this.dirty = paused || this.pendingFiles.size > 0;
    if (updated > 0) await this.save();
    const stats = this.stats();
    this.options.onProgress?.(
      `Semantic index ready: ${stats.files} files, ${stats.chunks} chunks${stats.truncated ? ` (coverage capped at ${this.maxFiles})` : ''}.`,
    );
  }

  private async buildPending(): Promise<void> {
    const pending = [...this.pendingFiles];
    this.pendingFiles.clear();
    let updated = 0;
    let paused = false;
    for (let index = 0; index < pending.length; index++) {
      const rel = pending[index];
      if (this.options.signal?.aborted) {
        // Keep the unprocessed files queued so a later run can finish the
        // incremental update instead of silently dropping them.
        for (const remaining of pending.slice(index)) {
          this.pendingFiles.add(remaining);
        }
        paused = true;
        break;
      }
      try {
        if (await this.updateFile(rel)) {
          updated++;
          await this.maybeSave(updated);
        }
      } catch (error) {
        for (const remaining of pending.slice(index + 1)) {
          this.pendingFiles.add(remaining);
        }
        this.options.onProgress?.(
          `Semantic indexing paused: ${error instanceof Error ? error.message : String(error)}`,
        );
        paused = true;
        break;
      }
    }
    this.loaded = true;
    this.dirty = paused || this.pendingFiles.size > 0;
    if (updated > 0) await this.save();
    const stats = this.stats();
    this.options.onProgress?.(`Semantic index updated: ${stats.files} files, ${stats.chunks} chunks.`);
  }

  private async updateFile(relative: string): Promise<boolean> {
    const absolute = path.join(this.options.root, relative);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      if (this.data.files[relative]) {
        delete this.data.files[relative];
        return true;
      }
      return false;
    }
    const previous = this.data.files[relative];
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      return false;
    }
    if (stat.size > MAX_FILE_BYTES) {
      const removed = Boolean(this.data.files[relative]);
      delete this.data.files[relative];
      return removed;
    }
    let content: string;
    try {
      content = await fs.readFile(absolute, 'utf-8');
    } catch {
      return false;
    }
    if (content.includes('\u0000')) {
      const removed = Boolean(this.data.files[relative]);
      delete this.data.files[relative];
      return removed;
    }
    const hash = createHash('sha1').update(content).digest('hex');
    if (previous?.hash === hash) {
      this.data.files[relative] = { ...previous, size: stat.size, mtimeMs: stat.mtimeMs };
      return false;
    }
    const chunks = chunkText(content);
    if (chunks.length === 0) {
      this.data.files[relative] = { hash, chunks: [], size: stat.size, mtimeMs: stat.mtimeMs };
      return true;
    }
    const vectors = await this.options.embed(chunks.map((chunk) => chunk.text));
    this.data.files[relative] = {
      hash,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        vector: vectors[index] ?? [],
      })),
    };
    return true;
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

  /** Persist every ten changed files, and at least every 15 seconds during a
   * long local embedding run so a worker restart does not lose all progress. */
  private async maybeSave(updated: number): Promise<void> {
    if (updated <= 0) {
      return;
    }
    const now = Date.now();
    if (updated % 10 !== 0 && now - this.lastSaveAt < 15_000) {
      return;
    }
    await this.save();
    this.lastSaveAt = now;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.options.storageFile), { recursive: true });
    await fs.writeFile(this.options.storageFile, JSON.stringify(this.data));
    this.lastSaveAt = Date.now();
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
