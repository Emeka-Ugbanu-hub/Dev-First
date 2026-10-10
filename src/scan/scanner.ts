import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import { getConfig } from '../config';
import type { DevFirstConfig } from '../config';
import { activeProvider } from '../llm/activeProvider';
import type { LLMProvider, ToolCall, ToolDef } from '../llm/types';
import { matchGlob } from '../util/glob';
import { isSuppressed } from './engine';
import { scanTextWithAst } from './engine';
import { RULE_PACKS } from './rules';
import { buildCandidateSignals } from './candidates';
import { TreeSitterService } from './treeSitter';
import { DuplicationIndex } from './duplication';
import type { FileFacts } from './duplication';
import type { CrossFileFinding } from './crossFile';
import { AiScanner } from './aiScanner';
import { buildPairCandidates, CrossFileAi } from './crossFileAi';
import type { ScanFinding, ScanRule, ScanSeverity } from './ruleTypes';
import { MemoryStore } from '../memory/MemoryStore';
import {
  CONVENTIONS_HEADING,
  formatConventionsSection,
  mineConventions,
  replaceMemorySection,
} from './conventions';
import type { Convention } from './conventions';
import { ConventionPhraser } from './conventionPhraser';
import { ProjectModel } from './projectModel';
import type { ProjectModelState } from './projectModel';

export { matchGlob };

const AI_RULE_IDS = new Set([
  'ai-bug',
  'ai-vulnerability',
  'ai-smell',
  'ai-secret',
  'ai-architecture',
  'ai-maintainability',
  'ai-scalability',
]);
const MAX_RELATED_PAIRS = 8;
const SEVERITIES: Record<ScanSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

export class ScanRunner implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly findings = new Map<string, ScanFinding[]>();
  private readonly aiFindings = new Map<string, ScanFinding[]>();
  private readonly diagnosticCache = new Map<string, Map<ScanFinding, vscode.Diagnostic>>();
  private readonly trees = new Map<string, { version: number; tree: Tree }>();
  private readonly treeSitter: TreeSitterService;
  private readonly duplication: DuplicationIndex;
  private readonly aiScanner: AiScanner;
  private readonly crossFileAi: CrossFileAi;
  private readonly memory: MemoryStore;
  private readonly conventionPhraser: ConventionPhraser;
  private readonly projectModel: ProjectModel;
  private readonly aiStatus: vscode.StatusBarItem;
  private readonly output: vscode.OutputChannel;
  private readonly pairFindings = new Map<string, ScanFinding[]>();
  private readonly activeScans = new Map<string, number>();
  private readonly duplicationToken = { isCancellationRequested: false };
  private readonly factsUpdated = new vscode.EventEmitter<void>();
  readonly onDidUpdateFacts: vscode.Event<void> = this.factsUpdated.event;
  private conventions: Convention[] = [];
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readOnlyTools?: { getTools: () => Promise<ToolDef[]>; executeTool: (call: ToolCall) => Promise<string> },
  ) {
    this.treeSitter = new TreeSitterService(context);
    this.aiScanner = new AiScanner({
      getConfig: () => {
        const config = getConfig();
        return {
          ...config,
          reasoning:
            config.reasoningEffort === 'off'
              ? undefined
              : { enabled: true, effort: config.reasoningEffort as 'low' | 'medium' | 'high' },
        };
      },
      buildProvider: () => this.buildScanProvider(),
      getTools: readOnlyTools?.getTools,
      executeTool: readOnlyTools?.executeTool,
    });
    this.crossFileAi = new CrossFileAi({
      getConfig: () => getConfig(),
      buildProvider: () => this.buildScanProvider(),
      cache: {
        get: (key) => this.duplication.getPairVerdict(key),
        set: (key, verdict) => this.duplication.setPairVerdict(key, verdict),
      },
    });
    this.duplication = new DuplicationIndex({
      parse: (text, languageId) => this.treeSitter.parse(text, languageId),
      root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      storageFile: context.globalStorageUri
        ? path.join(context.globalStorageUri.fsPath, 'duplication-index.json')
        : undefined,
      getScanIgnore: () => getConfig().scanIgnore,
      getMaxFileKb: () => getConfig().scanMaxFileKb,
      getMaxFiles: () => getConfig().scanMaxFiles,
    });
    this.memory = new MemoryStore(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      context.globalStorageUri.fsPath,
    );
    this.conventionPhraser = new ConventionPhraser({
      getModel: () => getConfig().scanAiModel.trim() || getConfig().model,
      buildProvider: () => this.buildScanProvider(),
    });
    this.projectModel = new ProjectModel({
      memory: this.memory,
      loadState: () => this.context.workspaceState.get<ProjectModelState>('devFirst.projectModel'),
      saveState: async (state) => {
        await this.context.workspaceState.update('devFirst.projectModel', state);
      },
      getFacts: () => this.duplication.getFacts(),
      getHashes: () => this.duplication.getFileHashes(),
      buildProvider: () => this.buildScanProvider(),
      getModel: () => getConfig().scanAiModel.trim() || getConfig().model,
    });
    this.diagnostics = vscode.languages.createDiagnosticCollection('dev-first-scan');
    this.aiStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 89);
    this.output = vscode.window.createOutputChannel('Dev-First Scanner');
    void this.duplication.ensureBuilt(this.duplicationToken);
    context.subscriptions.push(
      this.diagnostics,
      this.aiStatus,
      this.output,
      vscode.workspace.onDidChangeTextDocument((event) => this.clearFindings(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.clear(document)),
      this,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.findings.clear();
    this.aiFindings.clear();
    this.pairFindings.clear();
    this.diagnosticCache.clear();
    for (const entry of this.trees.values()) {
      entry.tree.delete();
    }
    this.trees.clear();
    this.duplicationToken.isCancellationRequested = true;
    this.aiScanner.dispose();
    this.crossFileAi.dispose();
    this.aiStatus.dispose();
    this.factsUpdated.dispose();
    this.duplication.dispose();
    this.treeSitter.dispose();
  }

  getFindings(uri: string): ScanFinding[] {
    return this.findings.get(uri) ?? [];
  }

  async getArchitectureFacts(): Promise<FileFacts[]> {
    await this.duplication.ensureBuilt(this.duplicationToken);
    return this.duplication.getFacts();
  }

  async getArchitectureCoverage(): Promise<import('./duplication').ArchitectureScanCoverage> {
    await this.duplication.ensureBuilt(this.duplicationToken);
    return this.duplication.getArchitectureCoverage();
  }

  async refreshKnowledge(): Promise<void> {
    try {
      const facts = await this.duplication.getFacts();
      if (facts.length === 0) {
        return;
      }
      this.factsUpdated.fire();
      if (getConfig().scanConventions) {
        const mined = mineConventions({ files: facts });
        if (mined.length > 0) {
          this.conventions = await this.conventionPhraser.phrase(mined);
          await this.writeConventions(this.conventions);
        }
      }
      await this.projectModel.ensureFresh(this.conventions);
    } catch {
      return;
    }
  }

  private async writeConventions(conventions: Convention[]): Promise<void> {
    const memory = await this.memory.read();
    const next = replaceMemorySection(
      memory,
      CONVENTIONS_HEADING,
      formatConventionsSection(conventions),
    );
    if (next !== undefined) {
      await this.memory.replace(next);
    }
  }

  async refresh(document: vscode.TextDocument): Promise<void> {
    // Kept as a compatibility no-op for callers from older extension versions.
    // Reviews only run through the explicit file-level AI action.
    void document;
  }

  private render(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const ai = this.aiFindings.get(key) ?? [];
    const pairs = this.pairFindings.get(key) ?? [];
    const visible = [...ai, ...pairs];
    const known = this.diagnosticCache.get(key);
    this.findings.set(key, visible);
    this.diagnostics.set(
      document.uri,
      visible.map((finding) => known?.get(finding) ?? toDiagnostic(finding)),
    );
  }

  async scanFile(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const key = document.uri.toString();
    const text = document.getText();
    const version = document.version;
    this.activeScans.set(key, (this.activeScans.get(key) ?? 0) + 1);
    this.aiScanner.cancel(key);
    this.crossFileAi.cancel(key);
    const fileName = path.basename(document.uri.fsPath);
    this.setScanStatus(`$(sync~spin) Scanning ${fileName}…`, 'Preparing file');
    try {
      const tree = await this.parseTree(document, version);
      if (document.version !== version) {
        this.setScanStatus('$(circle-slash) Scan cancelled', 'The file changed before the scan started.');
        return;
      }
      this.setScanStatus(`$(sync~spin) Scanning ${fileName}…`, 'Preparing file');
      this.findings.delete(key);
      this.aiFindings.delete(key);
      this.pairFindings.delete(key);
      this.diagnosticCache.set(key, new Map());
      this.render(document);
      this.setScanStatus(`$(sync~spin) Scanning ${fileName}…`, 'Building local candidate signals');
      let deterministicCandidates: ScanFinding[] = [];
      if (tree) {
        try {
          deterministicCandidates = [
            ...buildCandidateSignals(tree, document.languageId),
            ...this.compilerCandidateSignals(document),
            ...(await scanTextWithAst(
            text,
            document.languageId,
            RULE_PACKS,
            { includeHotspots: false },
            tree,
            )),
          ];
        } catch (error) {
          // Candidate generation is an optimization. A parser/rule failure
          // must not prevent the independent AI review from running.
          this.output.appendLine(
            `[${new Date().toLocaleTimeString()}] Candidate signals unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.output.appendLine(
        `[${new Date().toLocaleTimeString()}] Candidate signals: ${deterministicCandidates.length}`,
      );
      const aiResult = await this.runAiPass(document, version, text, deterministicCandidates, tree, {
        force: true,
        visibleLine: 0,
      });
      if (aiResult === 'cancelled' || document.version !== version) {
        this.setScanStatus('$(circle-slash) Scan cancelled', 'The file changed while it was being reviewed.');
        return;
      }
      this.setScanStatus(`$(sync~spin) Scanning ${fileName}…`, 'Checking related files');
      const relatedOk = await this.runPairPass(document, version, getConfig(), { force: true, all: true });
      if (!relatedOk) return;
      if (document.version !== version) {
        this.setScanStatus('$(circle-slash) Scan cancelled', 'The file changed while related files were checked.');
        return;
      }
      const count = this.findings.get(key)?.length ?? 0;
      this.setScanStatus(`$(check) Scan complete — ${count} finding${count === 1 ? '' : 's'}`, 'Review complete.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setScanStatus('$(error) Scan failed', message || 'The scanner returned an unknown error.');
    } finally {
      const remaining = (this.activeScans.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.activeScans.set(key, remaining);
      } else {
        this.activeScans.delete(key);
      }
    }
  }

  private setScanStatus(text: string, detail: string): void {
    this.aiStatus.text = text;
    this.aiStatus.tooltip = `Dev-First Scanner: ${detail}`;
    this.aiStatus.show();
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${detail}`);
  }

  private compilerCandidateSignals(document: vscode.TextDocument): ScanFinding[] {
    return vscode.languages
      .getDiagnostics(document.uri)
      .filter((diagnostic) => !String(diagnostic.source ?? '').toLowerCase().includes('dev-first'))
      .slice(0, 32)
      .map((diagnostic) => ({
        rule: {
          kind: 'analyzer',
          id: 'candidate-language-diagnostic',
          category: 'bug',
          severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
          run: () => [],
          message: diagnostic.message,
          why: `Reported by ${diagnostic.source || 'the language service'}; the AI must verify that it applies to the current code.`,
          fix: 'Resolve the reported language or type diagnostic if it represents a real issue.',
          confidence: 'low',
        },
        line: diagnostic.range.start.line,
        startChar: diagnostic.range.start.character,
        endChar: Math.max(diagnostic.range.start.character + 1, diagnostic.range.end.character),
      }));
  }

  private async runAiPass(
    document: vscode.TextDocument,
    version: number,
    text: string,
    deterministic: ScanFinding[],
    tree?: Tree,
    options: { force?: boolean; visibleLine?: number } = {},
  ): Promise<'complete' | 'cancelled'> {
    const key = document.uri.toString();
    try {
      const result = await this.aiScanner.scan(
        {
          uri: key,
          languageId: document.languageId,
          text,
          lineCount: document.lineCount,
        },
        deterministic,
        tree,
        {
          force: options.force,
          visibleLine: options.visibleLine ?? this.visibleLineFor(document),
          onProgress: (done, total) => this.setAiStatus(done, total, document),
          onStage: (stage) => this.setScanStatus(`$(sync~spin) Scanning ${path.basename(document.uri.fsPath)}…`, stage),
          onCoverage: (reviewed, total, mode) => {
            this.aiStatus.text = `Dev-First: AI ${mode} review ${reviewed}/${total}`;
            this.aiStatus.tooltip = `Dev-First Scanner: ${mode} review ${reviewed}/${total}`;
            this.aiStatus.show();
            this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${mode} review ${reviewed}/${total}`);
          },
          onPartial: (findings) => {
            if (document.version === version) {
              this.applyAiFindings(document, key, text, findings);
            }
          },
        },
      );
      if (result === undefined || document.version !== version) {
        return 'cancelled';
      }
      this.setScanStatus(`$(sync~spin) Scanning ${path.basename(document.uri.fsPath)}…`, 'Applying findings');
      this.applyAiFindings(document, key, text, result);
      return 'complete';
    } finally {
      // Leave the current status visible until the next scan or result.
    }
  }

  private applyAiFindings(
    document: vscode.TextDocument,
    key: string,
    text: string,
    findings: ScanFinding[],
  ): void {
    const lines = text.split('\n');
    const kept = findings.filter(
      (finding) => {
        const evidence = finding.rule.evidence ?? [];
        const supported = evidence.some((item) => evidenceIsValid(item.path, item.line, document, lines.length));
        return supported && !isSuppressed(lines, finding.line, finding.rule.id, AI_RULE_IDS);
      },
    );
    this.aiFindings.set(key, kept);
    this.render(document);
  }

  private setAiStatus(done: number, total: number, document: vscode.TextDocument): void {
    if (total <= 0 || done >= total) {
      return;
    }
    const text = `$(sync~spin) Reviewing ${path.basename(document.uri.fsPath)} ${Math.min(done, total)}/${total}…`;
    this.setScanStatus(text, `Reviewing region ${Math.min(done, total)}/${total}`);
  }

  private async runPairPass(
    document: vscode.TextDocument,
    version: number,
    config: DevFirstConfig,
    options: { force?: boolean; all?: boolean } = {},
  ): Promise<boolean> {
    const key = document.uri.toString();
    if (!config.scanCrossFile || !config.scanAiCrossFile) {
      return true;
    }
    try {
      const [facts, entries] = await Promise.all([
        this.duplication.getFacts(),
        this.duplication.getEntries(),
      ]);
      const candidates = buildPairCandidates({ openedFile: key, entries, facts });
      if (candidates.length === 0) {
        this.clearPairFindings(document, key);
        return true;
      }
      const result = await this.crossFileAi.judge(key, candidates, {
        force: options.force,
        maxPairs: Math.min(
          MAX_RELATED_PAIRS,
          options.all ? candidates.length : config.scanAiCrossFileMaxPairs,
        ),
      });
      if (this.disposed || document.version !== version) {
        return false;
      }
      this.applyPairFindings(document, key, result.findings, result.notice);
      return true;
    } catch {
      this.setScanStatus('$(error) Scan failed', 'Related-file review failed.');
      return false;
    }
  }

  private clearPairFindings(document: vscode.TextDocument, key: string): void {
    if (!this.pairFindings.has(key)) {
      return;
    }
    const previous = this.pairFindings.get(key) ?? [];
    const cache = this.diagnosticCache.get(key);
    for (const finding of previous) {
      cache?.delete(finding);
    }
    this.pairFindings.delete(key);
    this.render(document);
  }

  private applyPairFindings(
    document: vscode.TextDocument,
    key: string,
    findings: CrossFileFinding[],
    notice?: CrossFileFinding,
  ): void {
    const cache = this.diagnosticCache.get(key) ?? new Map<ScanFinding, vscode.Diagnostic>();
    const previous = this.pairFindings.get(key) ?? [];
    for (const finding of previous) {
      cache.delete(finding);
    }
    const kept: ScanFinding[] = [];
    for (const item of [...findings, ...(notice ? [notice] : [])]) {
      if (item.file !== key || item.line < 0 || item.line >= document.lineCount) {
        continue;
      }
      if (!item.evidence?.some((evidence) => evidence.path.trim() && evidence.line > 0)) {
        continue;
      }
      const finding: ScanFinding = {
        rule: crossFileRule(item),
        line: item.line,
        startChar: 0,
        endChar: document.lineAt(item.line).text.length,
      };
      const diagnostic = toDiagnostic(finding);
      diagnostic.source = 'Dev-First (cross-file)';
      diagnostic.code = item.ruleId;
      if (item.related.length > 0) {
        diagnostic.relatedInformation = item.related.slice(0, 10).map(
          (related) =>
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(
                vscode.Uri.parse(related.file),
                new vscode.Range(related.line, 0, related.line, 0),
              ),
              related.message,
            ),
        );
      }
      cache.set(finding, diagnostic);
      kept.push(finding);
    }
    this.pairFindings.set(key, kept);
    this.diagnosticCache.set(key, cache);
    this.render(document);
  }

  private visibleLineFor(document: vscode.TextDocument): number | undefined {
    const uri = document.uri.toString();
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === uri,
    );
    return editor?.selection.active.line;
  }

  private async buildScanProvider(): Promise<LLMProvider | undefined> {
    const active = await activeProvider(this.context);
    return active?.provider;
  }

  private async parseTree(document: vscode.TextDocument, version: number): Promise<Tree | undefined> {
    const key = document.uri.toString();
    const cached = this.trees.get(key);
    if (cached && cached.version === version) {
      return cached.tree;
    }
    const tree = await this.treeSitter.parse(document.getText(), document.languageId);
    if (document.version !== version) {
      tree?.delete();
      return undefined;
    }
    if (!tree) {
      if (cached) {
        cached.tree.delete();
        this.trees.delete(key);
      }
      return undefined;
    }
    if (cached) {
      cached.tree.delete();
    }
    this.trees.set(key, { version, tree });
    return tree;
  }

  private clear(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    // Replacing a preview editor can close its TextDocument even though the
    // file was not edited. Keep scan findings and in-flight work so returning
    // to the file shows the completed result instead of cancelling it.
    const cached = this.trees.get(key);
    if (cached && !this.activeScans.has(key)) {
      cached.tree.delete();
      this.trees.delete(key);
    }
  }

  private clearFindings(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const key = document.uri.toString();
    this.aiScanner.clear(key);
    this.crossFileAi.cancel(key);
    this.findings.delete(key);
    this.aiFindings.delete(key);
    this.pairFindings.delete(key);
    this.diagnosticCache.delete(key);
    this.diagnostics.delete(document.uri);
  }
}

export function filterFindingsByCategory(findings: ScanFinding[], disabled: string[]): ScanFinding[] {
  if (disabled.length === 0) {
    return findings;
  }
  const disabledSet = new Set(disabled);
  return findings.filter((finding) => !disabledSet.has(finding.rule.category));
}

function evidenceIsValid(
  evidencePath: string,
  line: number,
  document: vscode.TextDocument,
  currentLineCount: number,
): boolean {
  if (!evidencePath.trim() || !Number.isInteger(line) || line < 1) return false;
  let candidate = evidencePath;
  try {
    if (evidencePath.startsWith('file:')) candidate = vscode.Uri.parse(evidencePath).fsPath;
    else if (!path.isAbsolute(evidencePath)) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      candidate = root ? path.resolve(root, evidencePath) : evidencePath;
    }
  } catch {
    return false;
  }
  if (candidate === document.uri.fsPath || evidencePath === document.uri.toString()) {
    return line <= currentLineCount;
  }
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    const text = fs.readFileSync(candidate, 'utf8');
    return line <= text.split('\n').length;
  } catch {
    return false;
  }
}

function toDiagnostic(finding: ScanFinding): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(finding.line, finding.startChar, finding.line, finding.endChar),
    finding.rule.message,
    SEVERITIES[finding.rule.severity],
  );
  diagnostic.source = finding.rule.id.startsWith('ai-')
    ? 'Dev-First (AI)'
    : finding.rule.category === 'hotspot'
      ? 'Dev-First (hotspot)'
      : 'Dev-First';
  diagnostic.code = finding.rule.id;
  return diagnostic;
}

function crossFileRule(item: CrossFileFinding): ScanRule {
  return {
    kind: 'analyzer',
    run: () => [],
    id: item.ruleId,
    category: item.category,
    severity: item.severity,
    message: item.message,
    why: item.message,
    fix: 'Review the related implementation and align or simplify the relationship.',
  };
}
