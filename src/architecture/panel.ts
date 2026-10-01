import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { LLMProvider } from '../llm/types';
import type { ArchitectureScanCoverage, FileFacts } from '../scan/duplication';
import {
  buildLevelSummary,
  inferLevelLabels,
  levelLabelsCache,
  levelSummaryHash,
} from './labels';
import type { LevelLabels } from './labels';
import {
  breadcrumbPath,
  buildArchitectureTree,
  findArchitectureNode,
  resolveNodeAfterRebuild,
} from './model';
import type { ArchitectureKind, ArchitectureNode } from './model';
import { analyzeArchitectureRelations } from './relations';
import type { ArchitectureRelation } from './relations';
import { classifyLevelChildren, orderLevel } from './flow';
import type { LevelRole } from './flow';

export interface ArchitectureLabelProvider {
  provider: LLMProvider;
  model: string;
}

export interface ArchitecturePanelDeps {
  extensionUri: vscode.Uri;
  getFacts: () => Promise<FileFacts[]>;
  getCoverage?: () => Promise<ArchitectureScanCoverage>;
  onDidUpdateFacts?: (listener: () => void) => { dispose(): void };
  getProvider?: () => Promise<ArchitectureLabelProvider | undefined>;
  labelsCache?: Map<string, LevelLabels | null>;
}

interface ArchitectureMessage {
  type?: string;
  id?: string;
  path?: string;
  line?: number;
}

interface ChildView {
  id: string;
  kind: ArchitectureKind;
  label: string;
  description: string;
  subtext?: string;
  usedBy: string[];
  dependsOn: string[];
  implementedBy: number;
  fileCount: number;
  file?: string;
}

export interface LevelNodeOverride {
  label?: string;
  subtext?: string;
}

interface DetailView {
  id: string;
  kind: ArchitectureKind;
  label: string;
  description: string;
  usedBy: string[];
  dependsOn: string[];
  implementedBy: number;
  files: string[];
}

const KIND_CLASS: Record<ArchitectureKind, string> = {
  project: 'df-project',
  domain: 'df-domain',
  subsystem: 'df-subsystem',
  component: 'df-component',
  implementation: 'df-implementation',
  file: 'df-file',
};

const KIND_COLORS: Record<ArchitectureKind, { fill: string; stroke: string; text: string }> = {
  project: {
    fill: 'var(--vscode-button-background)',
    stroke: 'var(--vscode-button-background)',
    text: 'var(--vscode-button-foreground)',
  },
  domain: {
    fill: 'var(--vscode-textBlockQuote-background)',
    stroke: 'var(--vscode-textLink-foreground)',
    text: 'var(--vscode-foreground)',
  },
  subsystem: {
    fill: 'var(--vscode-editorWidget-background)',
    stroke: 'var(--vscode-panel-border)',
    text: 'var(--vscode-foreground)',
  },
  component: {
    fill: 'var(--vscode-badge-background)',
    stroke: 'var(--vscode-badge-background)',
    text: 'var(--vscode-badge-foreground)',
  },
  implementation: {
    fill: 'var(--vscode-input-background)',
    stroke: 'var(--vscode-input-border)',
    text: 'var(--vscode-input-foreground)',
  },
  file: {
    fill: 'var(--vscode-editor-background)',
    stroke: 'var(--vscode-panel-border)',
    text: 'var(--vscode-descriptionForeground)',
  },
};

const CLASS_DEFS = (Object.keys(KIND_CLASS) as ArchitectureKind[]).map(
  (kind) =>
    `classDef ${KIND_CLASS[kind]} fill:#3c3c3c,stroke:#6e6e6e,color:#e7e7e7`,
);

function kindCss(): string {
  return (Object.keys(KIND_CLASS) as ArchitectureKind[])
    .map((kind) => {
      const selector = `g.${KIND_CLASS[kind]}`;
      const color = KIND_COLORS[kind];
      return `${selector} > rect, ${selector} > path, ${selector} > polygon { fill: ${color.fill} !important; stroke: ${color.stroke} !important; }
    ${selector} text, ${selector} .nodeLabel, ${selector} span { fill: ${color.text} !important; color: ${color.text} !important; }`;
    })
    .join('\n    ');
}

function mermaidText(label: string): string {
  return label.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
}

export const MAX_SUBTEXT_CHARS = 60;

export function truncateSubtext(value: string, max: number = MAX_SUBTEXT_CHARS): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function edgeVerbFor(label: string, fromRole: LevelRole, toRole: LevelRole): string {
  void fromRole;
  void toRole;
  return label;
}

export const AUTO_REFRESH_DEBOUNCE_MS = 2000;

const COULD_NOT_BUILD_INDEX = 'Dev-First: could not build the cross-file index.';
const NOTHING_INDEXED =
  'Dev-First: nothing indexed yet. Open a source file or run a scan, then reopen Architecture.';
const MISSING_NODE_HINT = 'That component no longer exists — showing';
const FILE_MISSING_MESSAGE = 'Dev-First: file no longer exists';
const FILE_MISSING_TIMEOUT = 3000;

export function levelRelations(
  node: ArchitectureNode,
  facts: FileFacts[],
): ArchitectureRelation[] {
  const nodeMap = new Map<string, string>();
  orderLevel(node.children, facts)
    .filter((child) => child.kind !== 'file')
    .forEach((child, index) => {
      const id = `n${index + 1}`;
      for (const file of child.files) {
        nodeMap.set(file, id);
      }
    });
  return analyzeArchitectureRelations(facts, nodeMap).relations;
}

function nodeShape(role: LevelRole, text: string): string {
  if (role === 'storage') {
    return `[("${text}")]`;
  }
  if (role === 'entry') {
    return `(["${text}"])`;
  }
  return `["${text}"]`;
}

export function mermaidForNode(
  node: ArchitectureNode,
  relations: ArchitectureRelation[] = [],
  facts: FileFacts[] = [],
  overrides?: Map<string, LevelNodeOverride>,
): string {
  const lines = ['flowchart TD', ...CLASS_DEFS];
  const ordered = orderLevel(node.children, facts);
  const concepts = ordered.filter((child) => child.kind !== 'file');
  const roles = classifyLevelChildren(node.children, facts);
  const archToId = new Map<string, string>();
  const idToArch = new Map<string, string>();
  concepts.forEach((child, index) => {
    const id = `n${index + 1}`;
    archToId.set(child.id, id);
    idToArch.set(id, child.id);
  });
  lines.push(`  n0["${mermaidText(node.label)}"]:::${KIND_CLASS[node.kind]}`);
  for (const child of concepts) {
    const id = archToId.get(child.id);
    if (!id) {
      continue;
    }
    const override = overrides?.get(child.id);
    const role = roles.get(child.id) ?? 'core';
    const count = ` (${child.files.length})`;
    const subtext = truncateSubtext(override?.subtext ?? child.description);
    const label = override?.label ?? child.label;
    const text = mermaidText(`${label}${count}${subtext ? `<br/>${subtext}` : ''}`);
    lines.push(`  ${id}${nodeShape(role, text)}:::${KIND_CLASS[child.kind]}`);
  }
  const entries = concepts.filter((child) => roles.get(child.id) === 'entry');
  for (const child of entries.length > 0 ? entries : concepts) {
    const id = archToId.get(child.id);
    if (id) {
      lines.push(`  n0 --> ${id}`);
    }
  }
  const ids = new Set(concepts.map((_child, index) => `n${index + 1}`));
  const edges = relations
    .filter(
      (relation) =>
        relation.fromId !== relation.toId &&
        ids.has(relation.fromId) &&
        ids.has(relation.toId),
    )
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        a.fromId.localeCompare(b.fromId) ||
        a.toId.localeCompare(b.toId),
    );
  for (const edge of edges) {
    const fromArch = idToArch.get(edge.fromId);
    const toArch = idToArch.get(edge.toId);
    const verb = edge.label;
    lines.push(`  ${edge.fromId} -. "${mermaidText(verb)}" .-> ${edge.toId}`);
  }
  return lines.join('\n');
}

function detailOf(node: ArchitectureNode): DetailView {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    description: node.description,
    usedBy: node.usedBy,
    dependsOn: node.dependsOn,
    implementedBy: node.implementedBy,
    files: node.files,
  };
}

function childOf(node: ArchitectureNode): ChildView {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    description: node.description,
    usedBy: node.usedBy,
    dependsOn: node.dependsOn,
    implementedBy: node.implementedBy,
    fileCount: node.files.length,
    file: node.kind === 'file' ? node.files[0] : undefined,
  };
}

export interface DebouncedRefresh {
  schedule(): void;
  dispose(): void;
}

export function createDebouncedRefresh(
  run: () => void,
  delayMs: number = AUTO_REFRESH_DEBOUNCE_MS,
): DebouncedRefresh {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, delayMs);
    },
    dispose(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

export interface ArchitectureSessionDeps {
  getFacts: () => Promise<FileFacts[]>;
  getCoverage?: () => Promise<ArchitectureScanCoverage>;
  post: (message: unknown) => void;
  isVisible: () => boolean;
  getProvider?: () => Promise<ArchitectureLabelProvider | undefined>;
  labelsCache?: Map<string, LevelLabels | null>;
}

export interface RefreshOptions {
  auto?: boolean;
}

export const LEVEL_SUBTEXT_PLACEHOLDER = '…';

export class ArchitectureSession {
  private root: ArchitectureNode | undefined;
  private facts: FileFacts[] = [];
  private scanCoverage: ArchitectureScanCoverage = {
    unsupportedSourceFiles: 0,
    parseFailures: 0,
    oversizedSourceFiles: 0,
    scanLimitReached: false,
  };
  private currentId = 'project';
  private revision = 0;
  private refreshing = false;
  private pendingRefresh: RefreshOptions | undefined;
  private pendingRender = false;
  private disposed = false;
  private opened = false;
  private providerMissing = false;
  private readonly labelsCache: Map<string, LevelLabels | null>;
  private readonly levelLabels = new Map<string, LevelLabels>();
  private readonly pendingLabels = new Set<string>();
  private readonly labelsAbort = new AbortController();

  constructor(private readonly deps: ArchitectureSessionDeps) {
    this.labelsCache = deps.labelsCache ?? levelLabelsCache;
  }

  get currentNodeId(): string {
    return this.currentId;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.labelsAbort.abort();
  }

  async load(): Promise<void> {
    let facts: FileFacts[];
    try {
      facts = await this.deps.getFacts();
    } catch {
      this.deps.post({ type: 'empty', message: COULD_NOT_BUILD_INDEX });
      return;
    }
    if (this.disposed) {
      return;
    }
    if (facts.length === 0) {
      this.deps.post({ type: 'empty', message: NOTHING_INDEXED });
      return;
    }
    this.facts = facts;
    this.scanCoverage = await this.deps.getCoverage?.() ?? this.scanCoverage;
    this.root = buildArchitectureTree(facts);
    this.revision++;
    this.currentId = resolveNodeAfterRebuild(this.currentId, this.root).id;
    const node = this.postLevel();
    if (node && this.opened) {
      void this.requestLevelLabels(node);
    }
  }

  async refresh(options: RefreshOptions = {}): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.refreshing) {
      this.pendingRefresh = options;
      return;
    }
    this.refreshing = true;
    this.deps.post({ type: 'refreshing' });
    let succeeded = false;
    try {
      await this.rebuild(options);
      succeeded = true;
    } catch {
      succeeded = false;
    } finally {
      this.refreshing = false;
      this.deps.post({
        type: 'refreshed',
        text: succeeded ? 'Updated just now' : 'Refresh failed',
      });
      const pending = this.pendingRefresh;
      this.pendingRefresh = undefined;
      if (pending) {
        void this.refresh(pending);
      }
    }
  }

  renderCurrent(): void {
    this.pendingRender = false;
    this.opened = true;
    const node = this.postLevel();
    if (node) {
      void this.requestLevelLabels(node);
    }
  }

  renderIfPending(): void {
    if (!this.pendingRender) {
      return;
    }
    this.renderCurrent();
  }

  navigate(id: string): void {
    if (!this.root) {
      return;
    }
    const node = findArchitectureNode(this.root, id);
    if (!node) {
      return;
    }
    this.currentId = node.id;
    const rendered = this.postLevel();
    if (rendered) {
      void this.requestLevelLabels(rendered);
    }
  }

  private async rebuild(options: RefreshOptions): Promise<void> {
    const facts = await this.deps.getFacts();
    if (this.disposed) {
      return;
    }
    const previousId = this.currentId;
    if (facts.length === 0) {
      this.facts = [];
      this.root = undefined;
      this.revision++;
      this.levelLabels.clear();
      this.pendingLabels.clear();
      this.deps.post({ type: 'empty', message: NOTHING_INDEXED });
      return;
    }
    this.facts = facts;
    this.scanCoverage = await this.deps.getCoverage?.() ?? this.scanCoverage;
    this.root = buildArchitectureTree(facts);
    this.revision++;
    this.levelLabels.clear();
    this.pendingLabels.clear();
    const node = resolveNodeAfterRebuild(previousId, this.root);
    const changed = node.id !== previousId;
    this.currentId = node.id;
    const visible = options.auto !== true || this.deps.isVisible();
    if (!visible) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    const rendered = this.postLevel();
    if (rendered && this.opened) {
      void this.requestLevelLabels(rendered);
    }
    if (changed) {
      this.deps.post({ type: 'hint', text: `${MISSING_NODE_HINT} ${node.label}` });
    }
  }

  private postLevel(): ArchitectureNode | undefined {
    if (!this.root) {
      return undefined;
    }
    const node = findArchitectureNode(this.root, this.currentId) ?? this.root;
    this.currentId = node.id;
    const crumbs = breadcrumbPath(this.root, node.id);
    const ordered = orderLevel(node.children, this.facts);
    const nodeMap = new Map<string, string>();
    ordered.filter((child) => child.kind !== 'file').forEach((child, index) => {
      for (const file of child.files) nodeMap.set(file, `n${index + 1}`);
    });
    const analysis = analyzeArchitectureRelations(this.facts, nodeMap);
    const applied = this.levelLabels.get(node.id);
    const placeholder = Boolean(this.deps.getProvider) && !this.providerMissing && !applied;
    const overrides = new Map<string, LevelNodeOverride>();
    for (const child of ordered) {
      if (child.kind === 'file') {
        continue;
      }
      const entry = applied?.nodes.find((item) => item.id === child.id);
      const subtext =
        entry?.subtext ?? (placeholder ? LEVEL_SUBTEXT_PLACEHOLDER : child.description);
      overrides.set(child.id, {
        ...(entry?.label ? { label: entry.label } : {}),
        subtext,
      });
    }
    const labels = new Map(
      ordered
        .filter((child) => child.kind !== 'file')
        .map((child, index) => [`n${index + 1}`, overrides.get(child.id)?.label ?? child.label]),
    );
    this.deps.post({
      type: 'level',
      node: detailOf(node),
      children: ordered.map((child) => {
        const view = childOf(child);
        const override = overrides.get(child.id);
        return override
          ? { ...view, label: override.label ?? view.label, subtext: override.subtext }
          : view;
      }),
      breadcrumbs: crumbs.map((crumb) => ({
        id: crumb.id,
        label: crumb.label,
        kind: crumb.kind,
      })),
      diagram: mermaidForNode(node, analysis.relations, this.facts, overrides),
      relations: analysis.relations.map((relation) => ({
        ...relation,
        fromLabel: labels.get(relation.fromId) ?? relation.fromId,
        toLabel: labels.get(relation.toId) ?? relation.toId,
      })),
      coverage: {
        indexedFiles: this.facts.length,
        representedFiles: this.root?.files.length ?? 0,
        unresolvedImports: analysis.unresolvedImports,
        unresolvedTauriCommands: analysis.unresolvedTauriCommands,
        unsupportedSourceFiles: this.scanCoverage.unsupportedSourceFiles,
        parseFailures: this.scanCoverage.parseFailures,
        oversizedSourceFiles: this.scanCoverage.oversizedSourceFiles,
        scanLimitReached: this.scanCoverage.scanLimitReached,
      },
    });
    return node;
  }

  private applyLevelLabels(node: ArchitectureNode, labels: LevelLabels): void {
    this.levelLabels.set(node.id, labels);
    if (node.id === this.currentId) {
      this.postLevel();
    }
  }

  private async requestLevelLabels(node: ArchitectureNode): Promise<void> {
    if (this.disposed || !this.deps.getProvider || node.children.length === 0) {
      return;
    }
    if (this.levelLabels.has(node.id)) {
      return;
    }
    const summary = buildLevelSummary(node, this.facts);
    const hash = levelSummaryHash(summary);
    if (this.pendingLabels.has(hash)) {
      return;
    }
    this.pendingLabels.add(hash);
    const cached = this.labelsCache.get(hash);
    if (cached) {
      this.pendingLabels.delete(hash);
      this.applyLevelLabels(node, cached);
      return;
    }
    if (this.labelsCache.has(hash)) {
      this.pendingLabels.delete(hash);
      return;
    }
    const revision = this.revision;
    let active: ArchitectureLabelProvider | undefined;
    try {
      active = await this.deps.getProvider();
    } catch {
      active = undefined;
    }
    if (this.disposed || revision !== this.revision) {
      this.pendingLabels.delete(hash);
      return;
    }
    if (!active) {
      this.providerMissing = true;
      this.pendingLabels.delete(hash);
      this.postLevel();
      return;
    }
    const labels = await inferLevelLabels(node, this.facts, {
      provider: active.provider,
      model: active.model,
      signal: this.labelsAbort.signal,
      cache: this.labelsCache,
    });
    this.pendingLabels.delete(hash);
    if (this.disposed || revision !== this.revision || !labels) {
      return;
    }
    this.applyLevelLabels(node, labels);
  }
}

export interface OpenArchitectureFileDeps {
  exists: (path: string) => Promise<boolean>;
  open: (path: string, line?: number) => Promise<void>;
  status: (text: string, timeout: number) => void;
}

export async function openArchitectureFile(
  path: string,
  deps: OpenArchitectureFileDeps,
  line = 0,
): Promise<void> {
  let exists = false;
  try {
    exists = await deps.exists(path);
  } catch {
    exists = false;
  }
  if (!exists) {
    deps.status(FILE_MISSING_MESSAGE, FILE_MISSING_TIMEOUT);
    return;
  }
  try {
    await deps.open(path, line);
  } catch {
    return;
  }
}

export class ArchitecturePanel {
  static current: ArchitecturePanel | undefined;

  private readonly session: ArchitectureSession;
  private readonly debounce: DebouncedRefresh;
  private readonly factsSubscription: { dispose(): void } | undefined;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: ArchitecturePanelDeps,
  ) {
    this.session = new ArchitectureSession({
      getFacts: () => deps.getFacts(),
      getCoverage: deps.getCoverage,
      post: (message) => this.post(message),
      isVisible: () => this.panel.visible,
      getProvider: deps.getProvider,
      labelsCache: deps.labelsCache,
    });
    this.debounce = createDebouncedRefresh(() => {
      void this.session.refresh({ auto: true });
    });
    this.factsSubscription = deps.onDidUpdateFacts?.(() => this.debounce.schedule());
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => this.dispose());
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        this.session.renderIfPending();
      }
    });
    panel.webview.onDidReceiveMessage((message: ArchitectureMessage) =>
      void this.handle(message),
    );
  }

  static async show(deps: ArchitecturePanelDeps): Promise<void> {
    if (ArchitecturePanel.current) {
      ArchitecturePanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'devFirst.architecture',
      'Dev-First: Architecture',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(deps.extensionUri, 'dist'),
          vscode.Uri.joinPath(deps.extensionUri, 'media'),
        ],
      },
    );
    const instance = new ArchitecturePanel(panel, deps);
    ArchitecturePanel.current = instance;
    await instance.load();
  }

  refresh(): Promise<void> {
    return this.session.refresh();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.debounce.dispose();
    this.factsSubscription?.dispose();
    this.session.dispose();
    if (ArchitecturePanel.current === this) {
      ArchitecturePanel.current = undefined;
    }
  }

  private async load(): Promise<void> {
    await this.session.load();
  }

  private async handle(message: ArchitectureMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (message.type === 'ready') {
      this.session.renderCurrent();
      return;
    }
    if (message.type === 'refresh') {
      await this.session.refresh();
      return;
    }
    if (message.type === 'drillDown' || message.type === 'navigate') {
      if (typeof message.id === 'string') {
        this.session.navigate(message.id);
      }
      return;
    }
    if (message.type === 'openFile' && typeof message.path === 'string') {
      await this.openFile(message.path, message.line);
    }
  }

  private async openFile(path: string, line = 0): Promise<void> {
    await openArchitectureFile(path, {
      exists: async (value) => {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.parse(value));
          return true;
        } catch {
          return false;
        }
      },
      open: async (value, targetLine = 0) => {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(value));
        await vscode.window.showTextDocument(document, {
          preview: false,
          selection: new vscode.Range(Math.max(0, targetLine), 0, Math.max(0, targetLine), 0),
        });
      },
      status: (text, timeout) => {
        void vscode.window.setStatusBarMessage(text, timeout);
      },
    }, line);
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'architecturePanel.js'),
    );
    const fontUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview', 'webview.ttf'),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dev-First: Architecture</title>
  <style>
    @font-face {
      font-family: 'codicon';
      src: url(${fontUri}) format('truetype');
    }
    .codicon {
      font: normal normal normal 16px/1 codicon;
      display: inline-block;
      text-align: center;
      text-transform: none;
      text-decoration: none;
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    .codicon-refresh:before { content: "\\eb37"; }
    .codicon-modifier-spin { animation: df-spin 1.5s linear infinite; }
    @keyframes df-spin { to { transform: rotate(360deg); } }
    :root {
      color-scheme: light dark;
      --df-radius-sm: 4px;
      --df-radius-md: 6px;
      --df-radius-lg: 8px;
      --df-surface: var(--vscode-editorWidget-background);
      --df-border: var(--vscode-panel-border);
      --df-hover: var(--vscode-list-hoverBackground);
      --df-muted: var(--vscode-descriptionForeground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    #df-back, #df-refresh {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: var(--df-radius-sm);
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      cursor: pointer;
      font-size: 12px;
    }
    #df-back:disabled, #df-refresh:disabled { opacity: 0.4; cursor: default; }
    #df-refresh:hover:not(:disabled) { background: var(--df-hover); }
    #df-refresh .codicon { font-size: 12px; }
    #df-crumbs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .df-crumb {
      border: none;
      background: transparent;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: var(--df-radius-sm);
      font-size: 12px;
    }
    .df-crumb.current { color: var(--vscode-foreground); cursor: default; font-weight: 600; }
    .df-crumb-sep { color: var(--vscode-descriptionForeground); font-size: 12px; }
    #df-hint {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--df-muted);
      font-size: 12px;
    }
    #df-status { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    #df-main { flex: 1; display: flex; min-height: 0; }
    #df-diagram-wrap { flex: 1; min-width: 0; overflow: auto; padding: 24px; }
    #df-diagram { min-width: 100%; display: flex; justify-content: center; align-items: flex-start; }
    #df-diagram svg { max-width: none; height: auto; }
    .df-overview { width: 100%; max-width: 1040px; margin: 0 auto; }
    .df-overview-root { display: flex; align-items: center; gap: 10px; min-height: 48px; margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--vscode-focusBorder); border-radius: var(--df-radius-lg); background: var(--vscode-editorWidget-background); }
    .df-overview-root strong { font-size: 14px; }
    .df-overview-root > span:last-child { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .df-overview-kind { flex: none; color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
    .df-overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 145px), 1fr)); gap: 8px; }
    .df-overview-item { min-width: 0; min-height: 58px; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 8px 10px; border: 1px solid var(--df-border); border-radius: var(--df-radius-lg); background: var(--df-surface); color: var(--vscode-foreground); text-align: left; cursor: pointer; }
    .df-files-only { width: 100%; max-width: 720px; margin: 0 auto; display: flex; align-items: center; gap: 8px; padding: 12px; border: 1px dashed var(--df-border); border-radius: var(--df-radius-lg); background: var(--df-surface); }
    .df-files-only strong { font-size: 13px; }
    .df-files-only > span:last-child { margin-left: auto; color: var(--df-muted); font-size: 12px; }
    .df-overview-item:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
    .df-overview-item strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
    .df-overview-meta { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 10px; }
    @media (max-width: 900px) { .df-overview-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 125px), 1fr)); } }
    @media (max-width: 620px) { #df-main { flex-direction: column; } aside { width: 100%; max-height: 38vh; border-left: 0; border-top: 1px solid var(--vscode-panel-border); } #df-diagram-wrap { padding: 14px; } #df-hint { display: none; } }
    @media (prefers-reduced-motion: reduce) { .codicon-modifier-spin { animation: none; } }
    .df-clickable { cursor: pointer; }
    .df-clickable:hover > rect, .df-clickable:hover > path, .df-clickable:hover > polygon {
      stroke: var(--vscode-focusBorder) !important;
      stroke-width: 2px !important;
    }
    .edgePath path, .flowchart-link {
      stroke: var(--vscode-descriptionForeground) !important;
    }
    ${kindCss()}
    .df-fallback {
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: var(--df-radius-md);
      white-space: pre-wrap;
    }
    aside {
      width: 320px;
      flex: none;
      border-left: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
      padding: 16px;
      overflow: auto;
    }
    .df-kind {
      display: inline-block;
      padding: 2px 6px;
      border-radius: var(--df-radius-sm);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .df-title { margin: 8px 0 4px; font-size: 15px; font-weight: 600; }
    .df-description { margin: 0 0 16px; color: var(--vscode-descriptionForeground); }
    .df-section { margin-bottom: 16px; }
    .df-section h3 {
      margin: 0 0 6px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    .df-list { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px; }
    .df-chip {
      padding: 2px 6px;
      border-radius: var(--df-radius-sm);
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--vscode-panel-border);
      font-size: 12px;
    }
    .df-empty { color: var(--vscode-descriptionForeground); font-style: italic; }
    .df-files { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
    .df-relation { padding: 5px 0; border-bottom: 1px solid var(--df-border); }
    .df-relation > span { display: block; margin-bottom: 3px; line-height: 1.4; }
    .df-file {
      display: block;
      width: 100%;
      text-align: left;
      border: none;
      background: transparent;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      padding: 3px 4px;
      border-radius: var(--df-radius-sm);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .df-file:hover { background: var(--vscode-list-hoverBackground); }
    #df-empty { margin: 48px auto; max-width: 480px; color: var(--vscode-descriptionForeground); text-align: center; }
  </style>
</head>
<body>
  <header>
    <button id="df-back" type="button" disabled>&#8592; Back</button>
    <nav id="df-crumbs" aria-label="Breadcrumbs"></nav>
    <span id="df-hint" role="status"></span>
    <span id="df-status"></span>
    <button id="df-refresh" type="button" title="Refresh architecture">
      <span id="df-refresh-icon" class="codicon codicon-refresh" aria-hidden="true"></span>
      Refresh
    </button>
  </header>
  <main id="df-main">
    <section id="df-diagram-wrap"><div id="df-diagram"></div></section>
    <aside id="df-detail"></aside>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
