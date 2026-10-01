import * as vscode from 'vscode';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Tree } from '@vscode/tree-sitter-wasm/wasm/web-tree-sitter';
import { getConfig } from '../config';
import type { DevFirstConfig } from '../config';
import { activeProvider } from '../llm/activeProvider';
import type { LLMProvider } from '../llm/types';
import { matchGlob } from '../util/glob';
import { findingKey, ScanBaseline } from './baseline';
import { isSuppressed, scanTextWithAst } from './engine';
import { RULE_PACKS } from './rules';
import { TreeSitterService } from './treeSitter';
import { DuplicationIndex } from './duplication';
import type { DuplicationMatch, FileFacts } from './duplication';
import {
  findCircularImports,
  findCoverageAsymmetry,
  findDeadExports,
  findDeepImportChains,
  findDivergentConstants,
  findDuplicateHttpClients,
  findDuplicatedSecretsAcrossFiles,
  findDuplicateStateStores,
  findDuplicateTypeDefinitions,
  findEndpointMismatch,
  findEnumDrift,
  findGodModules,
  findInterfaceImplementationDrift,
  findListenerLeaks,
  findMissingSiblingAuth,
  findMissingSiblingValidation,
  findMixedAsyncPatterns,
  findNamingDrift,
  findOrphanedFiles,
  findOrphanedStorageKeys,
  findOrphanedTests,
  findPoolingInconsistency,
  findSharedMutableState,
  findShotgunSurgery,
  findSignatureDrift,
  findSqlTwinInconsistency,
  findStaleFeatureFlags,
  findTtlDrift,
  findUnboundedCaches,
  findUnstableDependencies,
} from './crossFile';
import type { CrossFileFinding, CrossFileIndex } from './crossFile';
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

const DEBOUNCE_MS = 500;
const DUPLICATION_MIN_STATEMENTS = 2;
const DUPLICATION_MAX_MATCHES = 3;
const GENERATED_SUFFIXES = ['.min.js', '.min.css'];
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);
const AI_RULE_IDS = new Set([
  'ai-bug',
  'ai-vulnerability',
  'ai-smell',
  'ai-hotspot',
  'ai-architecture',
]);
const CROSS_FILE_RULE_IDS = new Set([
  'xf-circular-imports',
  'xf-god-modules',
  'xf-deep-import-chains',
  'xf-unstable-dependencies',
  'xf-orphaned-files',
  'xf-dead-exports',
  'xf-orphaned-tests',
  'xf-coverage-asymmetry',
  'xf-stale-feature-flags',
  'xf-shotgun-surgery',
  'xf-signature-drift',
  'xf-duplicate-types',
  'xf-interface-implementation-drift',
  'xf-divergent-constants',
  'xf-mixed-async-patterns',
  'xf-duplicate-http-clients',
  'xf-naming-drift',
  'xf-missing-sibling-auth',
  'xf-missing-sibling-validation',
  'xf-sql-twin-inconsistency',
  'xf-duplicated-secrets',
  'xf-duplicate-state-stores',
  'xf-shared-mutable-state',
  'xf-enum-drift',
  'xf-endpoint-mismatch',
  'xf-unused-endpoint',
  'xf-unbounded-caches',
  'xf-listener-leaks',
  'xf-orphaned-storage-keys',
  'xf-pooling-inconsistency',
  'xf-ttl-drift',
  'xf-ai-pair',
  'xf-pair-cap',
]);
const CROSS_FILE_WHY: Record<string, string> = {
  'xf-circular-imports':
    'Circular imports make module initialization order fragile and can produce undefined values at runtime.',
  'xf-god-modules':
    'A module imported by almost everything becomes a bottleneck: every change ripples across the codebase.',
  'xf-deep-import-chains':
    'Long import chains mean a change at the top can reach deep into unrelated parts of the app.',
  'xf-unstable-dependencies':
    'A high-churn dependency pulled into stable modules spreads instability.',
  'xf-orphaned-files':
    'Nothing imports this file, so it is either dead code or loaded by a mechanism the index cannot see.',
  'xf-dead-exports': 'An export nothing imports is dead surface area that still needs maintenance.',
  'xf-orphaned-tests':
    'The source file this test targets is gone, so the test can no longer protect anything.',
  'xf-coverage-asymmetry': 'Siblings that evolve together usually deserve the same test coverage.',
  'xf-stale-feature-flags':
    'A flag referenced in one place is likely leftover from a finished rollout.',
  'xf-shotgun-surgery':
    'Files that change together across directories often hide a missing abstraction.',
  'xf-signature-drift':
    'The same function name with different parameters across files means callers cannot rely on one contract.',
  'xf-duplicate-types':
    'The same type name declared in several files drifts apart and forces conversions at the boundaries.',
  'xf-interface-implementation-drift':
    'An implementation that no longer satisfies its interface will fail at runtime where the types are erased.',
  'xf-divergent-constants':
    'One constant name with different values per file makes behavior depend on which module ran first.',
  'xf-mixed-async-patterns':
    'Mixing callbacks and promises in one file makes error handling and ordering hard to follow.',
  'xf-duplicate-http-clients':
    'Several HTTP clients with different configuration produce inconsistent retries, timeouts, and headers.',
  'xf-naming-drift':
    'The same concept named with different verbs makes the API hard to discover and remember.',
  'xf-missing-sibling-auth':
    'Sibling routes enforce authentication but this one does not, which usually exposes the endpoint.',
  'xf-missing-sibling-validation':
    'Sibling routes validate input but this one does not, so malformed data reaches the handler.',
  'xf-sql-twin-inconsistency':
    'A sibling builds SQL safely while this file concatenates input into the query, which enables injection.',
  'xf-duplicated-secrets':
    'The same secret literal appears in several files, so rotating it requires finding every copy.',
  'xf-duplicate-state-stores':
    'The same state stored in several places drifts out of sync and doubles the update surface.',
  'xf-shared-mutable-state':
    'Exported mutable state written from several modules makes behavior depend on import and execution order.',
  'xf-enum-drift':
    'The same enum or union name with different members in different files breaks exhaustive handling.',
  'xf-endpoint-mismatch':
    'A call site with no matching route handler usually means a typo, a stale path, or a missing endpoint.',
  'xf-unused-endpoint':
    'A route nothing calls is dead surface area or a path callers never found.',
  'xf-unbounded-caches':
    'A module-level cache with no eviction path grows for the lifetime of the process.',
  'xf-listener-leaks':
    'Listeners that are never removed keep their closures and targets alive and fire unexpectedly.',
  'xf-orphaned-storage-keys':
    'A storage key that is only written or only read is leftover state that nobody uses.',
  'xf-pooling-inconsistency':
    'Creating a client per call while siblings share one produces inconsistent configuration and connection churn.',
  'xf-ttl-drift':
    'The same TTL or limit constant with different values per file makes timeouts depend on the module that ran.',
  'xf-ai-pair':
    'The model compared two same-concept implementations and found them equivalent or drifted.',
  'xf-pair-cap':
    'More candidate pairs exist than the configured AI pair budget allows.',
};
const CROSS_FILE_FIX: Record<string, string> = {
  'xf-circular-imports': 'Break the cycle by extracting the shared piece into a third module.',
  'xf-god-modules': 'Split the module along its main responsibilities and import the smaller pieces.',
  'xf-deep-import-chains': 'Re-export from a closer module or flatten the layering.',
  'xf-unstable-dependencies': 'Stabilize the dependency or invert it behind a narrow interface.',
  'xf-orphaned-files': 'Delete the file or wire it back into an entry point.',
  'xf-dead-exports': 'Remove the export or use it.',
  'xf-orphaned-tests': 'Delete the test or restore the source file it covered.',
  'xf-coverage-asymmetry': 'Add a test next to the untested sibling.',
  'xf-stale-feature-flags': 'Remove the flag or roll it out consistently.',
  'xf-shotgun-surgery': 'Extract the logic these files keep changing together.',
  'xf-signature-drift': 'Pick one signature, move it to a shared module, and update every caller.',
  'xf-duplicate-types': 'Keep a single declaration in a shared module and import it everywhere.',
  'xf-interface-implementation-drift':
    'Implement the missing methods or remove the interface from the class.',
  'xf-divergent-constants': 'Import one shared constant instead of redefining it per file.',
  'xf-mixed-async-patterns': 'Standardize the file on promises with async/await.',
  'xf-duplicate-http-clients':
    'Share one configured client instance across the files that talk to the same service.',
  'xf-naming-drift': 'Pick one verb per concept and rename the siblings to match.',
  'xf-missing-sibling-auth': 'Apply the same authentication middleware the sibling routes use.',
  'xf-missing-sibling-validation': 'Validate the request body the way the sibling routes do.',
  'xf-sql-twin-inconsistency':
    'Pass values as bound parameters instead of concatenating them into the SQL string.',
  'xf-duplicated-secrets': 'Load the value from configuration and rotate it once in a single place.',
  'xf-duplicate-state-stores': 'Keep one source of truth and read it from the other places.',
  'xf-shared-mutable-state': 'Move the state behind a module with getter/setter functions.',
  'xf-enum-drift': 'Keep one enum or union declaration in a shared module and import it everywhere.',
  'xf-endpoint-mismatch': 'Fix the call path or add the missing route handler.',
  'xf-unused-endpoint': 'Remove the route or point the intended callers at it.',
  'xf-unbounded-caches': 'Add a max size or an eviction path (delete/clear with a TTL).',
  'xf-listener-leaks': 'Remove the listener in the same lifecycle that added it.',
  'xf-orphaned-storage-keys': 'Remove the key or add the missing read/write.',
  'xf-pooling-inconsistency': 'Create the client once at module level and reuse it.',
  'xf-ttl-drift': 'Import one shared TTL constant instead of redefining it per file.',
  'xf-ai-pair': 'Review the twin and either share one implementation or document the difference.',
  'xf-pair-cap': 'Raise devFirst.scanAiCrossFileMaxPairs or run Scan Whole File.',
};

const SEVERITIES: Record<ScanSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

export class ScanRunner implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly findings = new Map<string, ScanFinding[]>();
  private readonly allFindings = new Map<string, ScanFinding[]>();
  private readonly aiFindings = new Map<string, ScanFinding[]>();
  private readonly diagnosticCache = new Map<string, Map<ScanFinding, vscode.Diagnostic>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly trees = new Map<string, { version: number; tree: Tree }>();
  private readonly treeSitter: TreeSitterService;
  private readonly duplication: DuplicationIndex;
  private readonly baseline: ScanBaseline;
  private readonly aiScanner: AiScanner;
  private readonly crossFileAi: CrossFileAi;
  private readonly memory: MemoryStore;
  private readonly conventionPhraser: ConventionPhraser;
  private readonly projectModel: ProjectModel;
  private readonly aiStatus: vscode.StatusBarItem;
  private readonly pairFindings = new Map<string, ScanFinding[]>();
  private readonly duplicationToken = { isCancellationRequested: false };
  private readonly factsUpdated = new vscode.EventEmitter<void>();
  readonly onDidUpdateFacts: vscode.Event<void> = this.factsUpdated.event;
  private conventions: Convention[] = [];
  private shotgunFindings: CrossFileFinding[] = [];
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.treeSitter = new TreeSitterService(context);
    this.baseline = new ScanBaseline(context.workspaceState);
    this.aiScanner = new AiScanner({
      getConfig: () => getConfig(),
      buildProvider: () => this.buildScanProvider(),
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
    if (getConfig().scanDuplication || getConfig().scanCrossFile) {
      void this.duplication.ensureBuilt(this.duplicationToken);
    }
    if (getConfig().scanCrossFile) {
      this.refreshShotgun();
    }
    context.subscriptions.push(
      this.diagnostics,
      this.aiStatus,
      vscode.workspace.onDidOpenTextDocument((document) => void this.refresh(document)),
      vscode.workspace.onDidSaveTextDocument((document) => void this.refresh(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.schedule(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.clear(document)),
      this,
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.findings.clear();
    this.allFindings.clear();
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
    this.baseline.dispose();
    this.duplication.dispose();
    this.treeSitter.dispose();
  }

  async resetBaseline(): Promise<void> {
    await this.baseline.clear();
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === 'file') {
        await this.refresh(document);
      }
    }
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
    if (document.uri.scheme !== 'file') {
      return;
    }
    const config = getConfig();
    if (!config.scanEnabled) {
      this.diagnostics.clear();
      this.findings.clear();
      this.allFindings.clear();
      this.aiFindings.clear();
      this.pairFindings.clear();
      this.diagnosticCache.clear();
      this.aiScanner.cancelAll();
      this.crossFileAi.cancelAll();
      return;
    }
    const text = document.getText();
    if (
      Buffer.byteLength(text, 'utf8') > config.scanMaxFileKb * 1024 ||
      text.includes('\u0000') ||
      isIgnored(document.uri.fsPath, config.scanIgnore)
    ) {
      this.clear(document);
      return;
    }
    const version = document.version;
    const tree =
      config.scanAst || config.scanDuplication || config.scanCrossFile || config.scanAi
        ? await this.parseTree(document, version)
        : undefined;
    const findings = await scanTextWithAst(
      text,
      document.languageId,
      RULE_PACKS,
      { includeHotspots: config.scanHotspots },
      tree,
    );
    const diagnostics = new Map<ScanFinding, vscode.Diagnostic>();
    for (const finding of findings) {
      diagnostics.set(finding, toDiagnostic(finding));
    }
    if (config.scanDuplication && tree) {
      void this.duplication.ensureBuilt(this.duplicationToken);
      const duplicates = await this.collectDuplicates(document, text, tree);
      for (let index = 0; index < duplicates.findings.length; index++) {
        const finding = duplicates.findings[index];
        findings.push(finding);
        diagnostics.set(finding, duplicates.diagnostics[index]);
      }
    }
    if (config.scanCrossFile && tree) {
      void this.duplication.ensureBuilt(this.duplicationToken);
      const cross = await this.collectCrossFile(document, tree);
      for (let index = 0; index < cross.findings.length; index++) {
        const finding = cross.findings[index];
        findings.push(finding);
        diagnostics.set(finding, cross.diagnostics[index]);
      }
    }
    if (document.version !== version) {
      return;
    }
    const key = document.uri.toString();
    this.allFindings.set(key, findings);
    this.diagnosticCache.set(key, diagnostics);
    this.render(document, config);
    void this.runAiPass(document, version, text, findings, tree);
    void this.runPairPass(document, version, config);
  }

  private render(document: vscode.TextDocument, config: DevFirstConfig): void {
    const key = document.uri.toString();
    const deterministic = this.allFindings.get(key) ?? [];
    const ai = this.aiFindings.get(key) ?? [];
    const pairs = this.pairFindings.get(key) ?? [];
    const visible = this.applyScanFilters(document, [...deterministic, ...ai, ...pairs], config);
    const known = this.diagnosticCache.get(key);
    this.findings.set(key, visible);
    this.diagnostics.set(
      document.uri,
      visible.map((finding) => known?.get(finding) ?? toDiagnostic(finding)),
    );
  }

  async scanWholeFile(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const key = document.uri.toString();
    if (!this.allFindings.has(key)) {
      await this.refresh(document);
      return;
    }
    const text = document.getText();
    const version = document.version;
    const tree = await this.parseTree(document, version);
    if (document.version !== version) {
      return;
    }
    await this.runAiPass(document, version, text, this.allFindings.get(key) ?? [], tree, {
      force: true,
      visibleLine: 0,
    });
    await this.runPairPass(document, version, getConfig(), { force: true, all: true });
  }

  private async runAiPass(
    document: vscode.TextDocument,
    version: number,
    text: string,
    deterministic: ScanFinding[],
    tree?: Tree,
    options: { force?: boolean; visibleLine?: number } = {},
  ): Promise<void> {
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
          onProgress: (done, total) => this.setAiStatus(done, total),
          onPartial: (findings) => {
            if (document.version === version) {
              this.applyAiFindings(document, key, text, findings);
            }
          },
        },
      );
      if (result === undefined || document.version !== version) {
        return;
      }
      this.applyAiFindings(document, key, text, result);
    } finally {
      this.aiStatus.hide();
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
      (finding) => !isSuppressed(lines, finding.line, finding.rule.id, AI_RULE_IDS),
    );
    this.aiFindings.set(key, kept);
    this.render(document, getConfig());
  }

  private setAiStatus(done: number, total: number): void {
    if (total <= 0 || done >= total) {
      this.aiStatus.hide();
      return;
    }
    this.aiStatus.text = `Dev-First: AI scan ${Math.min(done, total)}/${total}`;
    this.aiStatus.show();
  }

  private async runPairPass(
    document: vscode.TextDocument,
    version: number,
    config: DevFirstConfig,
    options: { force?: boolean; all?: boolean } = {},
  ): Promise<void> {
    const key = document.uri.toString();
    if (!config.scanCrossFile || !config.scanAiCrossFile) {
      return;
    }
    try {
      const [facts, entries] = await Promise.all([
        this.duplication.getFacts(),
        this.duplication.getEntries(),
      ]);
      const candidates = buildPairCandidates({ openedFile: key, entries, facts });
      if (candidates.length === 0) {
        this.clearPairFindings(document, key);
        return;
      }
      const result = await this.crossFileAi.judge(key, candidates, {
        force: options.force,
        maxPairs: options.all ? candidates.length : config.scanAiCrossFileMaxPairs,
      });
      if (this.disposed || document.version !== version) {
        return;
      }
      this.applyPairFindings(document, key, result.findings, result.notice);
    } catch {
      // pair judgments are best effort; never break the main scan
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
    this.render(document, getConfig());
  }

  private applyPairFindings(
    document: vscode.TextDocument,
    key: string,
    findings: CrossFileFinding[],
    notice?: CrossFileFinding,
  ): void {
    const text = document.getText();
    const lines = text.split('\n');
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
      if (isSuppressed(lines, item.line, item.ruleId, CROSS_FILE_RULE_IDS)) {
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
    this.render(document, getConfig());
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

  private applyScanFilters(
    document: vscode.TextDocument,
    findings: ScanFinding[],
    config: DevFirstConfig,
  ): ScanFinding[] {
    const enabled = filterFindingsByCategory(findings, config.scanDisabledCategories);
    if (enabled.length === 0) {
      return enabled;
    }
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    const keys = enabled.map((finding) =>
      findingKey(finding.rule.id, relative, document.lineAt(finding.line).text),
    );
    if (!config.scanNewOnly) {
      this.baseline.record(keys);
      return enabled;
    }
    return enabled.filter((_finding, index) => !this.baseline.has(keys[index]));
  }

  private async collectDuplicates(
    document: vscode.TextDocument,
    text: string,
    tree: Tree,
  ): Promise<{ findings: ScanFinding[]; diagnostics: vscode.Diagnostic[] }> {
    const result: { findings: ScanFinding[]; diagnostics: vscode.Diagnostic[] } = {
      findings: [],
      diagnostics: [],
    };
    const key = document.uri.toString();
    try {
      await this.duplication.indexFile(key, text, document.languageId, tree);
      const matches = await this.duplication.findDuplicates(
        key,
        text,
        document.languageId,
        {
          minStatements: DUPLICATION_MIN_STATEMENTS,
          threshold: getConfig().scanDuplicationThreshold,
          maxPerFunction: DUPLICATION_MAX_MATCHES,
        },
        tree,
      );
      for (const match of matches) {
        if (match.line < 0 || match.line >= document.lineCount) {
          continue;
        }
        const endChar = document.lineAt(match.line).text.length;
        const finding: ScanFinding = {
          rule: duplicationRule(match),
          line: match.line,
          startChar: 0,
          endChar,
        };
        const diagnostic = toDiagnostic(finding);
        diagnostic.source = 'Dev-First (duplication)';
        diagnostic.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(
              vscode.Uri.parse(match.file),
              new vscode.Range(match.startLine, 0, match.startLine, 0),
            ),
            `Duplicate function in ${displayPath(match.file)}`,
          ),
        ];
        result.findings.push(finding);
        result.diagnostics.push(diagnostic);
      }
    } catch {
      // duplication is best effort; never break the main scan
    }
    return result;
  }

  private refreshShotgun(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    void findShotgunSurgery(root)
      .then((findings) => {
        if (this.disposed || findings.length === 0) {
          return;
        }
        this.shotgunFindings = findings.map((finding) => ({
          ...finding,
          file: pathToFileURL(path.join(root, finding.file)).toString(),
          related: finding.related.map((related) => ({
            ...related,
            file: pathToFileURL(path.join(root, related.file)).toString(),
          })),
        }));
        for (const editor of vscode.window.visibleTextEditors ?? []) {
          if (editor.document.uri.scheme === 'file') {
            void this.refresh(editor.document);
          }
        }
      })
      .catch(() => {
        // shotgun surgery is optional
      });
  }

  private async collectCrossFile(
    document: vscode.TextDocument,
    tree: Tree,
  ): Promise<{ findings: ScanFinding[]; diagnostics: vscode.Diagnostic[] }> {
    const result: { findings: ScanFinding[]; diagnostics: vscode.Diagnostic[] } = {
      findings: [],
      diagnostics: [],
    };
    const key = document.uri.toString();
    try {
      const text = document.getText();
      await this.duplication.indexFile(key, text, document.languageId, tree);
      const facts = await this.duplication.getFacts();
      const index: CrossFileIndex = { files: facts };
      const collected: CrossFileFinding[] = [];
      const queries: Array<() => CrossFileFinding[]> = [
        () => findCircularImports(index),
        () => findGodModules(index),
        () => findDeepImportChains(index),
        () => findUnstableDependencies(index),
        () => findOrphanedFiles(index),
        () => findDeadExports(index),
        () => findOrphanedTests(index),
        () => findCoverageAsymmetry(index),
        () => findStaleFeatureFlags(index),
        () => findSignatureDrift(index),
        () => findDuplicateTypeDefinitions(index),
        () => findInterfaceImplementationDrift(index),
        () => findDivergentConstants(index),
        () => findMixedAsyncPatterns(index),
        () => findDuplicateHttpClients(index),
        () => findNamingDrift(index),
        () => findMissingSiblingAuth(index),
        () => findMissingSiblingValidation(index),
        () => findSqlTwinInconsistency(index),
        () => findDuplicatedSecretsAcrossFiles(index),
        () => findDuplicateStateStores(index),
        () => findSharedMutableState(index),
        () => findEnumDrift(index),
        () => findEndpointMismatch(index),
        () => findUnboundedCaches(index),
        () => findListenerLeaks(index),
        () => findOrphanedStorageKeys(index),
        () => findPoolingInconsistency(index),
        () => findTtlDrift(index),
      ];
      for (const query of queries) {
        try {
          collected.push(...query());
        } catch {
          // per-query failures are swallowed
        }
      }
      collected.push(...this.shotgunFindings);
      const lines = text.split('\n');
      for (const item of collected) {
        if (item.file !== key || item.line < 0 || item.line >= document.lineCount) {
          continue;
        }
        if (isSuppressed(lines, item.line, item.ruleId, CROSS_FILE_RULE_IDS)) {
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
        result.findings.push(finding);
        result.diagnostics.push(diagnostic);
      }
    } catch {
      // cross-file is best effort; never break the main scan
    }
    return result;
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

  private schedule(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const key = document.uri.toString();
    this.aiScanner.cancel(key);
    this.crossFileAi.cancel(key);
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.refresh(document);
    }, DEBOUNCE_MS);
    this.timers.set(key, timer);
  }

  private clear(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    this.findings.delete(key);
    this.allFindings.delete(key);
    this.aiFindings.delete(key);
    this.pairFindings.delete(key);
    this.diagnosticCache.delete(key);
    this.aiScanner.cancel(key);
    this.crossFileAi.cancel(key);
    this.diagnostics.delete(document.uri);
    const cached = this.trees.get(key);
    if (cached) {
      cached.tree.delete();
      this.trees.delete(key);
    }
  }
}

export function filterFindingsByCategory(findings: ScanFinding[], disabled: string[]): ScanFinding[] {
  if (disabled.length === 0) {
    return findings;
  }
  const disabledSet = new Set(disabled);
  return findings.filter((finding) => !disabledSet.has(finding.rule.category));
}

function isIgnored(filePath: string, globs: string[]): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (LOCKFILES.has(name) || GENERATED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return globs.some((pattern) => matchGlob(filePath, pattern));
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

function duplicationRule(match: DuplicationMatch): ScanRule {
  const location = `${displayPath(match.file)}:${match.startLine + 1}`;
  const percent = Math.round(match.similarity * 100);
  return {
    kind: 'analyzer',
    run: () => [],
    id: 'duplication-cross-file',
    category: 'smell',
    severity: 'info',
    message: `Duplicates ${location} (${percent}% similar)`,
    why: `This function closely matches ${location}. Duplicated logic drifts apart and doubles the cost of every change.`,
    fix: 'Extract the shared logic into one helper and call it from both places.',
  };
}

function crossFileRule(item: CrossFileFinding): ScanRule {
  return {
    kind: 'analyzer',
    run: () => [],
    id: item.ruleId,
    category: item.category,
    severity: item.severity,
    message: item.message,
    why:
      CROSS_FILE_WHY[item.ruleId] ??
      'Cross-file structure affects how safely the code can change.',
    fix: CROSS_FILE_FIX[item.ruleId] ?? 'Review the related files and simplify the relationship.',
  };
}

function displayPath(uriString: string): string {
  try {
    return vscode.workspace.asRelativePath(vscode.Uri.parse(uriString), false);
  } catch {
    return uriString;
  }
}
