import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ChangeSummary, ChangedFile } from '../shared/protocol';
import { findBlockInLines } from '../agent/patch';

export interface DiffChange {
  id: string;
  filePath: string;
  originalContent: string;
  newContent: string;
  startLine: number;
  endLine: number;
  changeType: 'insert' | 'delete' | 'replace';
  fileDeleted?: boolean;
  runId?: string;
  runLabel?: string;
  timestamp: Date;
}

export interface RunContext {
  id: string;
  label: string;
}

export interface RunHistoryFile {
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  original?: string;
}

export interface RunHistoryEntry {
  label: string;
  files: Map<string, RunHistoryFile>;
}

export interface DiffHistoryLimits {
  maxRuns: number;
  maxOriginalBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_HISTORY_LIMITS: DiffHistoryLimits = {
  maxRuns: 20,
  maxOriginalBytes: 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
};

export type RunFileSummary = ChangedFile;

interface LineDiffBlock {
  type: 'equal' | 'delete' | 'insert' | 'replace';
  originalStart: number;
  originalLines: string[];
  newStart: number;
  newLines: string[];
}

export class DiffManager {
  private static instance: DiffManager | undefined;
  private pendingChanges = new Map<string, DiffChange[]>();
  private originalFiles = new Map<string, string>();
  private writtenContent = new Map<string, string>();
  private fileSummaries = new Map<string, string>();
  private runContext: RunContext | undefined;
  private readonly runHistory = new Map<string, RunHistoryEntry>();
  private readonly contentOrder: string[] = [];
  private historyBytes = 0;
  private dynamicDecorations = new Map<string, vscode.TextEditorDecorationType[]>();
  private updateTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangePendingChanges: vscode.Event<void> = this.onDidChangeEmitter.event;
  private readonly onDidChangeHistoryEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeHistory: vscode.Event<void> = this.onDidChangeHistoryEmitter.event;

  constructor(private readonly limits: DiffHistoryLimits = DEFAULT_HISTORY_LIMITS) {
    vscode.window.onDidChangeActiveTextEditor(() => this.updateAllVisibleDecorations());
    vscode.workspace.onDidChangeTextDocument((event) => this.handleTextDocumentChange(event));
    vscode.window.onDidChangeVisibleTextEditors(() => this.updateAllVisibleDecorations());
  }

  static getInstance(): DiffManager {
    if (!DiffManager.instance) {
      DiffManager.instance = new DiffManager();
    }
    return DiffManager.instance;
  }

  async applyChange(filePath: string, newContent: string): Promise<string> {
    const absolutePath = this.getAbsolutePath(filePath);
    const relativePath = vscode.workspace.asRelativePath(absolutePath);

    let originalContent = '';
    try {
      originalContent = await fs.readFile(absolutePath, 'utf-8');
    } catch {
      originalContent = '';
    }

    if (originalContent === newContent) {
      return `No changes to apply for ${relativePath}.`;
    }

    if (!this.originalFiles.has(relativePath)) {
      this.originalFiles.set(relativePath, originalContent);
    }
    this.writtenContent.set(relativePath, newContent);

    const changes = this.generateDiffChanges(originalContent, newContent, relativePath).map((change) => ({
      ...change,
      runId: this.runContext?.id,
      runLabel: this.runContext?.label,
    }));
    if (changes.length === 0) {
      return 'No changes detected.';
    }

    this.pendingChanges.set(relativePath, changes);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, newContent, 'utf-8');
    const runOriginal = this.originalFiles.get(relativePath) ?? originalContent;
    this.recordRunChange(this.runContext?.id, relativePath, {
      status: runOriginal === '' ? 'added' : 'modified',
      additions: countAdditions(changes),
      deletions: countDeletions(changes),
      original: runOriginal,
    });
    this.scheduleDecorationUpdate();
    this.onDidChangeEmitter.fire();

    return `Applied ${changes.length} change${changes.length === 1 ? '' : 's'} to ${path.basename(relativePath)}.`;
  }

  async applyDeletion(filePath: string): Promise<string> {
    const absolutePath = this.getAbsolutePath(filePath);
    const relativePath = vscode.workspace.asRelativePath(absolutePath);

    let originalContent: string;
    try {
      originalContent = await fs.readFile(absolutePath, 'utf-8');
    } catch {
      return `Error: file ${relativePath} does not exist.`;
    }

    const change: DiffChange = {
      id: `${relativePath}-deleted`,
      filePath: relativePath,
      originalContent,
      newContent: '',
      startLine: 0,
      endLine: 0,
      changeType: 'delete',
      fileDeleted: true,
      runId: this.runContext?.id,
      runLabel: this.runContext?.label,
      timestamp: new Date(),
    };
    this.pendingChanges.set(relativePath, [change]);
    await fs.unlink(absolutePath);
    const runOriginal = this.originalFiles.get(relativePath) ?? originalContent;
    this.recordRunChange(this.runContext?.id, relativePath, {
      status: 'deleted',
      additions: 0,
      deletions: lineCount(originalContent),
      original: runOriginal,
    });
    this.onDidChangeEmitter.fire();
    return `Deleted ${relativePath}.`;
  }

  acceptChange(changeId: string): void {
    for (const [filePath, changes] of this.pendingChanges) {
      const change = changes.find((candidate) => candidate.id === changeId);
      if (!change) {
        continue;
      }
      changes.splice(changes.indexOf(change), 1);
      if (changes.length === 0) {
        this.pendingChanges.delete(filePath);
        this.cleanupFile(filePath);
      }
      this.updateAllVisibleDecorations();
      this.onDidChangeEmitter.fire();
      return;
    }
  }

  async rejectChange(changeId: string): Promise<void> {
    for (const [filePath, changes] of this.pendingChanges) {
      const change = changes.find((candidate) => candidate.id === changeId);
      if (!change) {
        continue;
      }
      const result = await this.revertChanges(filePath, [change]);
      if (result === 'conflict') {
        void vscode.window.showWarningMessage(
          'Dev-First: could not revert this change — the file was edited since. Use the review bar to revert the whole file or keep it.',
        );
        return;
      }
      changes.splice(changes.indexOf(change), 1);
      if (changes.length === 0) {
        this.pendingChanges.delete(filePath);
        this.cleanupFile(filePath);
      }
      this.updateAllVisibleDecorations();
      this.onDidChangeEmitter.fire();
      return;
    }
  }

  acceptFile(filePath: string): void {
    if (this.pendingChanges.delete(filePath)) {
      this.cleanupFile(filePath);
      this.updateAllVisibleDecorations();
      this.onDidChangeEmitter.fire();
    }
  }

  async rejectFile(filePath: string): Promise<'ok' | 'conflict'> {
    const changes = this.pendingChanges.get(filePath);
    if (!changes?.length) {
      return 'ok';
    }
    const result = await this.revertChanges(filePath, changes);
    if (result === 'conflict') {
      return 'conflict';
    }
    this.pendingChanges.delete(filePath);
    this.cleanupFile(filePath);
    this.updateAllVisibleDecorations();
    this.onDidChangeEmitter.fire();
    return 'ok';
  }

  async acceptRun(runId: string): Promise<void> {
    for (const [filePath, changes] of [...this.pendingChanges.entries()]) {
      if (changes.some((change) => change.runId === runId)) {
        this.pendingChanges.delete(filePath);
        this.cleanupFile(filePath);
      }
    }
    this.updateAllVisibleDecorations();
    this.onDidChangeEmitter.fire();
  }

  async rejectRun(runId: string): Promise<string[]> {
    const conflicts: string[] = [];
    for (const [filePath, changes] of [...this.pendingChanges.entries()]) {
      if (!changes.some((change) => change.runId === runId)) {
        continue;
      }
      const result = await this.rejectFile(filePath);
      if (result === 'conflict') {
        conflicts.push(filePath);
      }
    }
    return conflicts;
  }

  async revertWholeFile(filePath: string): Promise<void> {
    const absolutePath = this.getAbsolutePath(filePath);
    const original = this.originalFiles.get(filePath);
    if (original !== undefined) {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, original, 'utf-8');
    }
    this.pendingChanges.delete(filePath);
    this.cleanupFile(filePath);
    this.updateAllVisibleDecorations();
    this.onDidChangeEmitter.fire();
  }

  keepFile(filePath: string): void {
    this.pendingChanges.delete(filePath);
    this.cleanupFile(filePath);
    this.updateAllVisibleDecorations();
    this.onDidChangeEmitter.fire();
  }

  setRunContext(context: RunContext | undefined): void {
    this.runContext = context;
  }

  forceRefreshDecorations(): void {
    this.updateAllVisibleDecorations();
  }

  getCurrentRunId(): string | undefined {
    return this.runContext?.id;
  }

  setFileSummaries(entries: Array<{ path: string; summary: string }>): void {
    for (const entry of entries) {
      if (entry.path && entry.summary) {
        this.fileSummaries.set(entry.path.replace(/\\/g, '/'), entry.summary.trim());
      }
    }
    this.onDidChangeEmitter.fire();
  }

  getOriginalContent(filePath: string): string | undefined {
    return this.originalFiles.get(filePath);
  }

  hasDiffContent(runId: string, relPath?: string): boolean {
    const entry = this.runHistory.get(runId);
    if (!entry) {
      return false;
    }
    if (relPath !== undefined) {
      return entry.files.get(relPath)?.original !== undefined;
    }
    for (const file of entry.files.values()) {
      if (file.original !== undefined) {
        return true;
      }
    }
    return false;
  }

  runFiles(runId: string): RunFileSummary[] {
    const entry = this.runHistory.get(runId);
    if (!entry) {
      return [];
    }
    return [...entry.files.entries()].map(([filePath, file]) => ({
      path: filePath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }));
  }

  getRunOriginal(runId: string, relPath: string): string | undefined {
    return this.runHistory.get(runId)?.files.get(relPath)?.original;
  }

  viewableRunIds(): string[] {
    const runIds: string[] = [];
    for (const runId of this.runHistory.keys()) {
      if (this.hasDiffContent(runId)) {
        runIds.push(runId);
      }
    }
    return runIds;
  }

  private recordRunChange(
    runId: string | undefined,
    relativePath: string,
    change: { status: RunHistoryFile['status']; additions: number; deletions: number; original?: string },
  ): void {
    if (!runId) {
      return;
    }
    let entry = this.runHistory.get(runId);
    if (!entry) {
      entry = { label: this.runContext?.label?.trim() || 'Task', files: new Map() };
      this.runHistory.set(runId, entry);
    }
    const existing = entry.files.get(relativePath);
    if (existing) {
      existing.additions += change.additions;
      existing.deletions += change.deletions;
    } else {
      entry.files.set(relativePath, {
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
      });
    }
    const file = entry.files.get(relativePath)!;
    if (change.original !== undefined) {
      this.setRunOriginal(file, change.original);
    }
    file.status = change.status === 'deleted' ? 'deleted' : file.original === '' ? 'added' : 'modified';
    if (this.hasContentForRun(entry) && !this.contentOrder.includes(runId)) {
      this.contentOrder.push(runId);
    }
    this.enforceHistoryLimits();
    this.onDidChangeHistoryEmitter.fire();
  }

  private setRunOriginal(file: RunHistoryFile, original: string): void {
    if (file.original !== undefined) {
      this.historyBytes -= byteLength(file.original);
    }
    if (byteLength(original) <= this.limits.maxOriginalBytes) {
      file.original = original;
      this.historyBytes += byteLength(original);
    } else {
      file.original = undefined;
    }
  }

  private hasContentForRun(entry: RunHistoryEntry): boolean {
    for (const file of entry.files.values()) {
      if (file.original !== undefined) {
        return true;
      }
    }
    return false;
  }

  private enforceHistoryLimits(): void {
    while (this.historyBytes > this.limits.maxTotalBytes && this.contentOrder.length > 0) {
      const oldest = this.contentOrder.shift();
      if (oldest === undefined) {
        break;
      }
      const entry = this.runHistory.get(oldest);
      if (!entry) {
        continue;
      }
      for (const file of entry.files.values()) {
        if (file.original !== undefined) {
          this.historyBytes -= byteLength(file.original);
          file.original = undefined;
        }
      }
    }
    while (this.runHistory.size > this.limits.maxRuns) {
      const oldest = this.runHistory.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      const entry = this.runHistory.get(oldest);
      if (entry) {
        for (const file of entry.files.values()) {
          if (file.original !== undefined) {
            this.historyBytes -= byteLength(file.original);
            file.original = undefined;
          }
        }
      }
      this.runHistory.delete(oldest);
      const index = this.contentOrder.indexOf(oldest);
      if (index !== -1) {
        this.contentOrder.splice(index, 1);
      }
    }
  }

  private cleanupFile(filePath: string): void {
    this.originalFiles.delete(filePath);
    this.writtenContent.delete(filePath);
    this.fileSummaries.delete(filePath);
  }

  acceptAllChanges(): void {
    this.pendingChanges.clear();
    this.originalFiles.clear();
    this.clearDynamicDecorations();
    this.updateAllVisibleDecorations();
    this.onDidChangeEmitter.fire();
  }

  async rejectAllChanges(): Promise<string[]> {
    const conflicts: string[] = [];
    for (const filePath of [...this.pendingChanges.keys()]) {
      const result = await this.rejectFile(filePath);
      if (result === 'conflict') {
        conflicts.push(filePath);
      }
    }
    this.clearDynamicDecorations();
    this.updateAllVisibleDecorations();
    this.onDidChangeEmitter.fire();
    return conflicts;
  }

  hasPendingChanges(): boolean {
    return this.pendingChanges.size > 0;
  }

  getPendingChanges(filePath: string): DiffChange[] {
    return this.pendingChanges.get(filePath) ?? [];
  }

  getChangeSummaries(): ChangeSummary[] {
    const summaries: ChangeSummary[] = [];
    for (const [filePath, changes] of this.pendingChanges) {
      let additions = 0;
      let deletions = 0;
      let isDeleted = false;
      let isNew = changes.length > 0;
      for (const change of changes) {
        if (change.fileDeleted) {
          isDeleted = true;
          deletions += lineCount(change.originalContent);
          continue;
        }
        if (change.originalContent !== '') {
          isNew = false;
        }
        if (change.changeType === 'insert') {
          additions += lineCount(change.newContent);
        } else if (change.changeType === 'delete') {
          deletions += lineCount(change.originalContent);
        } else {
          additions += lineCount(change.newContent);
          deletions += lineCount(change.originalContent);
        }
      }
      const last = changes[changes.length - 1];
      summaries.push({
        path: filePath,
        additions,
        deletions,
        isNew,
        isDeleted,
        runId: last?.runId,
        runLabel: last?.runLabel,
        summary: this.fileSummaries.get(filePath),
        hunks: changes.map((change) => ({
          id: change.id,
          startLine: change.startLine,
          endLine: change.endLine,
          type: change.changeType,
        })),
      });
    }
    return summaries;
  }

  private async revertChanges(filePath: string, changes: DiffChange[]): Promise<'ok' | 'conflict'> {
    const absolutePath = this.getAbsolutePath(filePath);
    const deleted = changes.some((change) => change.fileDeleted);
    if (deleted) {
      let exists = true;
      try {
        await fs.access(absolutePath);
      } catch {
        exists = false;
      }
      if (exists) {
        const written = this.writtenContent.get(filePath);
        let current = '';
        try {
          current = await fs.readFile(absolutePath, 'utf-8');
        } catch {
          current = '';
        }
        if (written !== undefined && current !== written) {
          return 'conflict';
        }
      }
      const original = changes.find((change) => change.fileDeleted)?.originalContent ?? '';
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, original, 'utf-8');
      return 'ok';
    }

    let currentContent: string;
    try {
      currentContent = await fs.readFile(absolutePath, 'utf-8');
    } catch {
      return 'ok';
    }
    const eol = currentContent.includes('\r\n') ? '\r\n' : '\n';
    const written = this.writtenContent.get(filePath);
    const externallyEdited = written !== undefined && currentContent !== written;
    const lines = currentContent.replace(/\r\n/g, '\n').split('\n');
    const sorted = [...changes].sort((a, b) => b.startLine - a.startLine);

    if (!externallyEdited) {
      for (const change of sorted) {
        const originalLines = change.originalContent.split('\n');
        if (change.changeType === 'delete') {
          lines.splice(change.startLine, 0, ...originalLines);
        } else if (change.changeType === 'insert') {
          lines.splice(change.startLine, change.endLine - change.startLine + 1);
        } else {
          lines.splice(change.startLine, change.endLine - change.startLine + 1, ...originalLines);
        }
      }
    } else {
      for (const change of sorted) {
        if (change.changeType === 'delete') {
          return 'conflict';
        }
        const newBlock = change.newContent.split('\n');
        const index = findBlockInLines(lines, newBlock);
        if (index === -1) {
          return 'conflict';
        }
        if (change.originalContent === '') {
          lines.splice(index, newBlock.length);
        } else {
          lines.splice(index, newBlock.length, ...change.originalContent.split('\n'));
        }
      }
    }

    await fs.writeFile(absolutePath, lines.join(eol), 'utf-8');
    return 'ok';
  }

  private generateDiffChanges(originalContent: string, newContent: string, filePath: string): DiffChange[] {
    const originalLines = originalContent.split('\n');
    const newLines = newContent.split('\n');
    const diff = computeDiff(originalLines, newLines);
    const changes: DiffChange[] = [];
    let changeId = 0;

    for (const block of diff) {
      if (block.type === 'equal') {
        continue;
      }
      const startLine = block.newStart;
      const endLine =
        block.type === 'delete'
          ? block.newStart
          : block.newStart + Math.max(block.newLines.length, 1) - 1;
      changes.push({
        id: `${filePath}-${changeId++}`,
        filePath,
        originalContent: block.originalLines.join('\n'),
        newContent: block.newLines.join('\n'),
        startLine,
        endLine,
        changeType: block.type,
        timestamp: new Date(),
      });
    }
    return changes;
  }

  private updateAllVisibleDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.updateDecorationsForEditor(editor);
    }
  }

  private updateDecorationsForEditor(editor: vscode.TextEditor): void {
    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    const changes = this.pendingChanges.get(filePath);

    const existing = this.dynamicDecorations.get(filePath) ?? [];
    existing.forEach((decoration) => decoration.dispose());
    this.dynamicDecorations.set(filePath, []);

    if (!changes?.length) {
      return;
    }

    const decorations: vscode.TextEditorDecorationType[] = [];
    for (const change of changes) {
      if (change.changeType === 'delete' && !change.fileDeleted) {
        const deletedCount = lineCount(change.originalContent);
        const line = clampLine(change.startLine, editor.document.lineCount);
        const decoration = vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
          overviewRulerColor: new vscode.ThemeColor('editorError.foreground'),
          overviewRulerLane: vscode.OverviewRulerLane.Right,
          after: {
            contentText: `  🗑 ${deletedCount} line${deletedCount === 1 ? '' : 's'} removed by Dev-First`,
            fontStyle: 'italic',
            margin: '0 0 0 1em',
          },
        });
        decorations.push(decoration);
        const range = new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length);
        editor.setDecorations(decoration, [
          {
            range,
            hoverMessage: new vscode.MarkdownString(
              `**Dev-First removed:**\n\`\`\`\n${truncateHover(change.originalContent)}\n\`\`\``,
            ),
          },
        ]);
        continue;
      }

      const startLine = clampLine(change.startLine, editor.document.lineCount);
      const endLine = clampLine(Math.max(change.endLine, change.startLine), editor.document.lineCount);
      const decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor:
          change.changeType === 'insert'
            ? new vscode.ThemeColor('diffEditor.insertedTextBackground')
            : new vscode.ThemeColor('diffEditor.modifiedTextBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: {
          contentText: change.changeType === 'insert' ? '  ＋ added by Dev-First' : '  ✎ modified by Dev-First',
          fontStyle: 'italic',
          margin: '0 0 0 1em',
        },
      });
      decorations.push(decoration);
      const range = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length);
      const hover =
        change.changeType === 'insert'
          ? `**Dev-First added:**\n\`\`\`\n${truncateHover(change.newContent)}\n\`\`\``
          : `**Before:**\n\`\`\`\n${truncateHover(change.originalContent)}\n\`\`\`\n\n**After:**\n\`\`\`\n${truncateHover(change.newContent)}\n\`\`\``;
      editor.setDecorations(decoration, [{ range, hoverMessage: new vscode.MarkdownString(hover) }]);
    }

    this.dynamicDecorations.set(filePath, decorations);
  }

  private handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const filePath = vscode.workspace.asRelativePath(event.document.uri);
    if (!this.pendingChanges.has(filePath)) {
      return;
    }
    clearTimeout(this.updateTimeouts.get(filePath));
    const timeout = setTimeout(() => {
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document.uri.fsPath === event.document.uri.fsPath,
      );
      if (editor) {
        this.updateDecorationsForEditor(editor);
      }
      this.updateTimeouts.delete(filePath);
    }, 150);
    this.updateTimeouts.set(filePath, timeout);
  }

  private scheduleDecorationUpdate(): void {
    setTimeout(() => {
      this.updateAllVisibleDecorations();
      setTimeout(() => this.updateAllVisibleDecorations(), 200);
    }, 100);
  }

  private clearDynamicDecorations(): void {
    for (const decorations of this.dynamicDecorations.values()) {
      decorations.forEach((decoration) => decoration.dispose());
    }
    this.dynamicDecorations.clear();
  }

  private getAbsolutePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, filePath) : filePath;
  }

  dispose(): void {
    this.clearDynamicDecorations();
    this.pendingChanges.clear();
    this.runHistory.clear();
    this.contentOrder.length = 0;
    this.historyBytes = 0;
    for (const timeout of this.updateTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.updateTimeouts.clear();
    this.onDidChangeEmitter.dispose();
    this.onDidChangeHistoryEmitter.dispose();
  }
}

function computeDiff(originalLines: string[], newLines: string[]): LineDiffBlock[] {
  const diff: LineDiffBlock[] = [];
  let i = 0;
  let j = 0;

  while (i < originalLines.length || j < newLines.length) {
    const equalStart = { original: i, new: j };
    while (i < originalLines.length && j < newLines.length && originalLines[i] === newLines[j]) {
      i++;
      j++;
    }
    if (i > equalStart.original) {
      diff.push({
        type: 'equal',
        originalStart: equalStart.original,
        originalLines: originalLines.slice(equalStart.original, i),
        newStart: equalStart.new,
        newLines: newLines.slice(equalStart.new, j),
      });
    }
    if (i >= originalLines.length && j >= newLines.length) {
      break;
    }

    const changeStart = { original: i, new: j };
    let foundMatch = false;
    for (let lookAhead = 1; lookAhead <= 10 && !foundMatch; lookAhead++) {
      for (let oi = i; oi < Math.min(i + lookAhead, originalLines.length) && !foundMatch; oi++) {
        for (let ni = j; ni < Math.min(j + lookAhead, newLines.length); ni++) {
          if (
            originalLines[oi] === newLines[ni] &&
            oi + 1 < originalLines.length &&
            ni + 1 < newLines.length &&
            originalLines[oi + 1] === newLines[ni + 1]
          ) {
            const originalBlock = originalLines.slice(changeStart.original, oi);
            const newBlock = newLines.slice(changeStart.new, ni);
            if (originalBlock.length > 0 || newBlock.length > 0) {
              diff.push(makeBlock(changeStart, originalBlock, newBlock));
            }
            i = oi;
            j = ni;
            foundMatch = true;
            break;
          }
        }
      }
    }

    if (!foundMatch) {
      const originalBlock = originalLines.slice(changeStart.original);
      const newBlock = newLines.slice(changeStart.new);
      if (originalBlock.length > 0 || newBlock.length > 0) {
        diff.push(makeBlock(changeStart, originalBlock, newBlock));
      }
      break;
    }
  }

  return diff;
}

function makeBlock(
  start: { original: number; new: number },
  originalBlock: string[],
  newBlock: string[],
): LineDiffBlock {
  const type: 'delete' | 'insert' | 'replace' =
    originalBlock.length === 0 ? 'insert' : newBlock.length === 0 ? 'delete' : 'replace';
  return {
    type,
    originalStart: start.original,
    originalLines: originalBlock,
    newStart: start.new,
    newLines: newBlock,
  };
}

function lineCount(content: string): number {
  if (content === '') {
    return 0;
  }
  return content.split('\n').length;
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf-8');
}

function countAdditions(changes: DiffChange[]): number {
  let additions = 0;
  for (const change of changes) {
    if (change.changeType !== 'delete') {
      additions += lineCount(change.newContent);
    }
  }
  return additions;
}

function countDeletions(changes: DiffChange[]): number {
  let deletions = 0;
  for (const change of changes) {
    if (change.changeType !== 'insert') {
      deletions += lineCount(change.originalContent);
    }
  }
  return deletions;
}

function clampLine(line: number, lineCount: number): number {
  return Math.max(0, Math.min(line, lineCount - 1));
}

function truncateHover(content: string): string {
  return content.length > 2000 ? `${content.slice(0, 2000)}\n...` : content;
}
