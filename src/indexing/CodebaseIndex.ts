import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { listWorkspaceFilesDetailed, TEXT_EXTENSIONS } from '../util/fsWalk';

const INDEX_VERSION = 1;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const WORKERS = 8;
const MAX_SYMBOLS_PER_FILE = 160;
const MAX_IMPORTS_PER_FILE = 120;

export interface CodeSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface CodeImport {
  specifier: string;
  line: number;
}

interface IndexedFile {
  hash: string;
  size: number;
  mtimeMs: number;
  language: string;
  symbols: CodeSymbol[];
  imports: CodeImport[];
  exports: string[];
}

interface IndexData {
  version: number;
  files: Record<string, IndexedFile>;
}

export interface CodebaseEvidence {
  path: string;
  language: string;
  score: number;
  symbols: CodeSymbol[];
  imports: CodeImport[];
  exports: string[];
}

export type HybridSearchResult = CodebaseEvidence;

export interface CodebaseIndexOptions {
  root: string;
  storageFile: string;
  onProgress?: (message: string) => void;
  maxFiles?: number;
}

/**
 * A fast, model-free codebase locator. It deliberately stores metadata rather
 * than source text: the model receives exact locations first and the existing
 * read/search tools fetch the smallest necessary ranges afterward.
 */
export class CodebaseIndex {
  private data: IndexData = { version: INDEX_VERSION, files: {} };
  private loaded = false;
  private refreshPromise: Promise<void> | undefined;
  private dirty = true;
  private fullScan = true;
  private readonly pendingFiles = new Set<string>();
  private readonly maxFiles: number;
  private coverage = { scannedFiles: 0, truncated: false };

  constructor(private readonly options: CodebaseIndexOptions) {
    this.maxFiles = Math.max(1, options.maxFiles ?? MAX_FILES);
  }

  startBackgroundRefresh(): void {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.build().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  invalidate(filePath?: string): void {
    this.dirty = true;
    if (filePath) {
      const relative = this.relative(filePath);
      if (relative) {
        this.pendingFiles.add(relative);
      } else {
        this.fullScan = true;
      }
    } else {
      this.fullScan = true;
    }
    // Refresh is intentionally scheduled instead of run inline from a file
    // watcher, so editor saves never block typing or the chat request.
    if (!this.refreshPromise) {
      setTimeout(() => void this.refresh(), 150);
    }
  }

  async evidence(query: string, limit = 8): Promise<string> {
    await this.refresh();
    return this.renderEvidence(query, limit, false);
  }

  /** Use the persisted snapshot immediately while a background refresh runs. */
  async evidenceFast(query: string, limit = 8): Promise<string> {
    await this.load();
    if (Object.keys(this.data.files).length === 0) return '';
    return this.renderEvidence(query, limit, true);
  }

  /** Wait briefly for the first useful index snapshot without blocking the task. */
  async waitForReady(timeoutMs = 350): Promise<boolean> {
    if (this.loaded && !this.dirty) return true;
    await Promise.race([
      this.refresh().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
    ]);
    return this.loaded && !this.dirty;
  }

  private renderEvidence(query: string, limit: number, snapshot: boolean): string {
    const results = this.search(query, limit);
    const fallback = results.length > 0 ? results : this.search('', Math.min(limit, 4));
    if (fallback.length === 0) return '';
    const coverage = this.coverage;
    const lines = [
      snapshot
        ? '[Deterministic codebase index snapshot — background refresh may still be running]'
        : '[Deterministic codebase index — verified locations; read these files for details]',
      ...(coverage.truncated
        ? [`Index coverage: ${Object.keys(this.data.files).length} of ${coverage.scannedFiles}+ files; the file limit is ${this.maxFiles}. Use search_text for files outside the index.`]
        : []),
    ];
    for (const result of fallback) {
      const symbols = result.symbols
        .slice(0, 12)
        .map((symbol) => `${symbol.name} (${symbol.kind}, line ${symbol.line})`)
        .join(', ');
      const imports = result.imports
        .slice(0, 10)
        .map((item) => `${item.specifier} (line ${item.line})`)
        .join(', ');
      lines.push(`- ${result.path} [${result.language}] score=${result.score}`);
      if (symbols) lines.push(`  Symbols: ${symbols}`);
      if (imports) lines.push(`  Imports: ${imports}`);
      if (result.exports.length > 0) lines.push(`  Exports: ${result.exports.slice(0, 12).join(', ')}`);
    }
    return lines.join('\n');
  }

  /**
   * Fast, model-free search over the metadata index. Exact path/symbol matches
   * receive the strongest weight, followed by exports and imports. This is a
   * deliberately cheap first pass before semantic search or file reads.
   */
  async hybridSearch(query: string, limit = 8): Promise<HybridSearchResult[]> {
    await this.refresh();
    return this.search(query, limit);
  }

  stats(): {
    files: number;
    symbols: number;
    imports: number;
    ready: boolean;
    refreshing: boolean;
    scannedFiles: number;
    truncated: boolean;
    maxFiles: number;
  } {
    let symbols = 0;
    let imports = 0;
    for (const file of Object.values(this.data.files)) {
      symbols += file.symbols.length;
      imports += file.imports.length;
    }
    return {
      files: Object.keys(this.data.files).length,
      symbols,
      imports,
      ready: this.loaded && !this.dirty,
      refreshing: Boolean(this.refreshPromise),
      scannedFiles: this.coverage.scannedFiles,
      truncated: this.coverage.truncated,
      maxFiles: this.maxFiles,
    };
  }

  private search(query: string, limit: number): CodebaseEvidence[] {
    const terms = tokenize(query);
    const results: CodebaseEvidence[] = [];
    for (const [file, entry] of Object.entries(this.data.files)) {
      const lowerPath = file.toLowerCase();
      const symbolText = entry.symbols.map((symbol) => symbol.name).join(' ').toLowerCase();
      const importText = entry.imports.map((item) => item.specifier).join(' ').toLowerCase();
      const exportText = entry.exports.join(' ').toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (lowerPath.includes(term)) score += 8;
        if (symbolText.includes(term)) score += 7;
        if (exportText.includes(term)) score += 6;
        if (importText.includes(term)) score += 3;
      }
      // Give exact whole-token matches a deterministic boost. This behaves
      // like a small BM25-style lexical ranker without loading an embedding
      // model or sending source code anywhere.
      const exactTokens = new Set([
        ...tokenize(file),
        ...tokenize(symbolText),
        ...tokenize(exportText),
        ...tokenize(importText),
      ]);
      score += terms.reduce((total, term) => total + (exactTokens.has(term) ? 2 : 0), 0);
      // Keep a small set of likely entry points available for broad questions.
      if (score === 0 && terms.length === 0 && /(^|\/)(index|main|app|server|entry)\./i.test(file)) score = 1;
      if (score <= 0) continue;
      results.push({
        path: file,
        language: entry.language,
        score,
        symbols: entry.symbols,
        imports: entry.imports,
        exports: entry.exports,
      });
    }
    return results
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, Math.min(limit, 20)));
  }

  private async build(): Promise<void> {
    await this.load();
    if (!this.dirty) return;
    if (!this.fullScan && this.pendingFiles.size > 0) {
      await this.buildPending();
      return;
    }
    const listing = await listWorkspaceFilesDetailed(this.options.root, {
      extensions: TEXT_EXTENSIONS,
      maxEntries: this.maxFiles,
    });
    const files = listing.files;
    this.coverage = { scannedFiles: files.length, truncated: listing.truncated };
    const fileSet = new Set(files);
    for (const file of Object.keys(this.data.files)) {
      if (!fileSet.has(file)) delete this.data.files[file];
    }

    let cursor = 0;
    let changed = 0;
    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const index = cursor++;
        if (await this.updateFile(files[index])) changed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, Math.max(1, files.length)) }, () => worker()));
    this.fullScan = false;
    this.dirty = this.pendingFiles.size > 0;
    this.loaded = true;
    if (changed > 0 || Object.keys(this.data.files).length > 0) await this.save();
    this.options.onProgress?.(`Codebase index ready: ${Object.keys(this.data.files).length} files (${changed} updated).`);
    if (this.dirty) setTimeout(() => void this.refresh(), 150);
  }

  private async buildPending(): Promise<void> {
    const pending = [...this.pendingFiles];
    this.pendingFiles.clear();
    let changed = 0;
    await Promise.all(pending.map(async (relative) => {
      if (await this.updateFile(relative)) changed++;
    }));
    this.loaded = true;
    this.dirty = this.pendingFiles.size > 0;
    if (changed > 0) await this.save();
    this.options.onProgress?.(`Codebase index updated: ${Object.keys(this.data.files).length} files (${changed} changed).`);
    if (this.dirty) setTimeout(() => void this.refresh(), 150);
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
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) return false;
    if (stat.size > MAX_FILE_BYTES) {
      const removed = Boolean(this.data.files[relative]);
      delete this.data.files[relative];
      return removed;
    }
    let content: string;
    try {
      content = await fs.readFile(absolute, 'utf8');
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
    this.data.files[relative] = parseFile(relative, content, hash, stat.size, stat.mtimeMs);
    return true;
  }

  private relative(filePath: string): string | undefined {
    const relative = path.relative(this.options.root, path.resolve(filePath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join('/');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.storageFile, 'utf8')) as IndexData;
      if (parsed?.version === INDEX_VERSION && parsed.files) {
        this.data = parsed;
        this.dirty = true; // stat checks still validate every entry cheaply.
      }
    } catch {
      // First run or an interrupted write; rebuild from the workspace.
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.options.storageFile), { recursive: true });
    const temporary = `${this.options.storageFile}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.data), 'utf8');
    await fs.rename(temporary, this.options.storageFile);
  }
}

function parseFile(relative: string, content: string, hash: string, size: number, mtimeMs: number): IndexedFile {
  const lines = content.split('\n');
  const symbols: CodeSymbol[] = [];
  const imports: CodeImport[] = [];
  const exports = new Set<string>();
  const addSymbol = (name: string, kind: string, line: number): void => {
    if (!name || symbols.some((symbol) => symbol.name === name && symbol.line === line)) return;
    if (symbols.length < MAX_SYMBOLS_PER_FILE) symbols.push({ name, kind, line });
  };
  lines.forEach((lineText, index) => {
    const line = index + 1;
    const importMatch = lineText.match(/\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|^\s*from\s+([^\s]+)\s+import\s+/);
    if (importMatch && imports.length < MAX_IMPORTS_PER_FILE) {
      imports.push({ specifier: importMatch[1] ?? importMatch[2] ?? importMatch[3], line });
    }
    const exportMatch = lineText.match(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (exportMatch) exports.add(exportMatch[1]);
    const declarations = [
      [/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
      [/\bclass\s+([A-Za-z_$][\w$]*)/, 'class'],
      [/^\s*(?:interface|type)\s+([A-Za-z_$][\w$]*)/, 'type'],
      [/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'variable'],
      /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.test(lineText) ? [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'] : undefined,
      [/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
    ].filter(Boolean) as Array<[RegExp, string]>;
    for (const [pattern, kind] of declarations) {
      const match = lineText.match(pattern);
      if (match) addSymbol(match[1], kind, line);
    }
  });
  return {
    hash,
    size,
    mtimeMs,
    language: path.extname(relative).slice(1).toLowerCase() || 'text',
    symbols,
    imports,
    exports: [...exports],
  };
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_$-]{2,}/g) ?? [])].slice(0, 12);
}
