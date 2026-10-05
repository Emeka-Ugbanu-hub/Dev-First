import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import * as path from 'path';
import type { FileFacts } from '../scan/duplication';
import type { LLMProvider, ToolCall, ToolDef } from '../llm/types';
import { buildMapDigest } from './mapDigest';
import { buildMermaidMap, mapPathsOf, parseStructuredMap } from './mapValidate';
import { buildLevelView } from './mapLevels';
import {
  StoredArchitectureMap,
  architectureFilesHash,
  isStale,
  readStoredMap,
  writeStoredMap,
} from './mapStore';
import { generateArchitectureMap } from './mapGenerate';

export interface ArchitecturePanelDeps {
  extensionUri: vscode.Uri;
  root: string;
  state: vscode.Memento;
  getFacts: () => Promise<FileFacts[]>;
  getActive: () => Promise<{ provider: LLMProvider; model: string } | undefined>;
  getTools: () => Promise<ToolDef[]>;
  executeTool: (call: ToolCall) => Promise<string>;
}

interface ArchitectureMessage {
  type?: string;
  id?: string;
  path?: string;
  svg?: string;
  crumbs?: string[];
}

export const EMPTY_NO_MODEL = 'no-model';
export const EMPTY_NO_FACTS = 'no-facts';
export const EMPTY_NOT_DRAWN = 'not-drawn';

export class ArchitecturePanel {
  static current: ArchitecturePanel | undefined;

  private stored: StoredArchitectureMap | undefined;
  private controller: AbortController | undefined;
  private generating = false;
  private lastRaw = '';
  private levelPath: string[] = [];
  private groupIndex = new Map<string, string[]>();
  private currentStale = false;
  private disposed = false;
  private readonly projectName: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: ArchitecturePanelDeps,
  ) {
    this.stored = readStoredMap(deps.state);
    this.projectName = path.basename(deps.root) || 'this project';
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => this.dispose());
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
    ArchitecturePanel.current = new ArchitecturePanel(panel, deps);
  }

  reload(): void {
    if (!this.disposed) {
      void this.runGenerate();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controller?.abort();
    if (ArchitecturePanel.current === this) {
      ArchitecturePanel.current = undefined;
    }
  }

  private async handle(message: ArchitectureMessage): Promise<void> {
    if (this.disposed || !message || typeof message.type !== 'string') {
      return;
    }
    if (message.type === 'ready') {
      await this.postCurrentState();
      return;
    }
    if (message.type === 'generate' || message.type === 'reload') {
      void this.runGenerate();
      return;
    }
    if (message.type === 'openPath' && typeof message.path === 'string') {
      await this.openPath(message.path);
      return;
    }
    if (message.type === 'exportDiagram' && typeof message.svg === 'string') {
      await this.exportDiagram(message.svg);
      return;
    }
    if (message.type === 'showRaw') {
      this.post({ type: 'raw', text: this.lastRaw });
      return;
    }
    if (message.type === 'drillDown' && typeof message.id === 'string') {
      const target = this.groupIndex.get(message.id);
      if (target && this.stored) {
        this.levelPath = target;
        this.postMap(this.stored, this.currentStale);
      }
      return;
    }
    if (message.type === 'up' && Array.isArray(message.crumbs)) {
      if (this.stored) {
        this.levelPath = message.crumbs.filter(
          (segment): segment is string => typeof segment === 'string',
        );
        this.postMap(this.stored, this.currentStale);
      }
    }
  }

  private async postCurrentState(): Promise<void> {
    const stored = this.stored ?? readStoredMap(this.deps.state);
    this.stored = stored;
    if (stored) {
      this.postMap(stored, false);
      void this.refreshStaleFlag(stored);
      return;
    }
    const reason = (await this.hasProvider()) ? EMPTY_NOT_DRAWN : EMPTY_NO_MODEL;
    this.post({ type: 'empty', reason, project: this.projectName });
  }

  private async refreshStaleFlag(stored: StoredArchitectureMap): Promise<void> {
    let stale = false;
    try {
      const facts = await this.deps.getFacts();
      stale = isStale(stored, architectureFilesHash(facts.map((fact) => fact.file)));
    } catch {
      stale = false;
    }
    if (this.disposed || this.stored !== stored) {
      return;
    }
    this.postMap(stored, stale);
  }

  private async runGenerate(): Promise<void> {
    if (this.disposed || this.generating) {
      return;
    }
    const active = await this.getActive();
    if (!active) {
      this.post({ type: 'empty', reason: EMPTY_NO_MODEL, project: this.projectName });
      return;
    }
    this.generating = true;
    const controller = new AbortController();
    this.controller = controller;
    const hasMap = Boolean(this.stored);
    this.post({
      type: 'generating',
      progress: 'Reading files…',
      hasMap,
      project: this.projectName,
    });
    try {
      let facts: FileFacts[] = [];
      try {
        facts = await this.deps.getFacts();
      } catch {
        facts = [];
      }
      if (this.disposed || controller.signal.aborted) {
        return;
      }
      if (facts.length === 0) {
        this.post({ type: 'empty', reason: EMPTY_NO_FACTS, project: this.projectName });
        return;
      }
      const digest = buildMapDigest(facts, this.deps.root);
      let tools: ToolDef[] = [];
      try {
        tools = await this.deps.getTools();
      } catch {
        tools = [];
      }
      if (this.disposed || controller.signal.aborted) {
        return;
      }
      this.post({
        type: 'generating',
        progress: 'Building the map…',
        hasMap,
        project: this.projectName,
      });
      const raw = await generateArchitectureMap(digest, {
        provider: active.provider,
        model: active.model,
        tools,
        executeTool: this.deps.executeTool,
        signal: controller.signal,
        onProgress: (text, done) => {
          if (!done && !this.disposed && !controller.signal.aborted) {
            this.post({
              type: 'generating',
              progress: text,
              hasMap: Boolean(this.stored),
              project: this.projectName,
            });
          }
        },
      });
      if (this.disposed || controller.signal.aborted) {
        return;
      }
      if (!raw) {
        this.post({
          type: 'error',
          message: 'The architecture map could not be generated. Try again.',
          hasMap: Boolean(this.stored),
        });
        return;
      }
      this.lastRaw = raw;
      const parsed = parseStructuredMap(raw);
      if (!parsed) {
        this.post({
          type: 'error',
          message: 'The model did not return a usable structure. Try again.',
          hasMap: Boolean(this.stored),
        });
        return;
      }
      const map: StoredArchitectureMap = {
        version: 2,
        filesHash: architectureFilesHash(facts.map((fact) => fact.file)),
        mermaid: buildMermaidMap(parsed),
        paths: mapPathsOf(parsed, (relative) => existsSync(path.join(this.deps.root, relative))),
        structured: parsed,
        model: active.model,
        generatedAt: Date.now(),
      };
      this.stored = map;
      try {
        await writeStoredMap(this.deps.state, map);
      } catch {}
      if (this.disposed) {
        return;
      }
      this.levelPath = [];
      this.postMap(map, false);
    } finally {
      this.generating = false;
      if (this.controller === controller) {
        this.controller = undefined;
      }
    }
  }

  private async getActive(): Promise<{ provider: LLMProvider; model: string } | undefined> {
    try {
      return await this.deps.getActive();
    } catch {
      return undefined;
    }
  }

  private async hasProvider(): Promise<boolean> {
    return Boolean(await this.getActive());
  }

  private postMap(map: StoredArchitectureMap, stale: boolean): void {
    this.currentStale = stale;
    const view = buildLevelView(map.structured, this.levelPath, map.paths);
    this.groupIndex = new Map(Object.entries(view.groups));
    this.post({
      type: 'map',
      mermaid: view.mermaid,
      paths: view.paths,
      groups: view.groups,
      breadcrumbs: view.breadcrumbs,
      stale,
      generatedAt: map.generatedAt,
      model: map.model,
    });
  }

  private async openPath(relativePath: string): Promise<void> {
    const trimmed = relativePath.trim();
    if (!trimmed) {
      return;
    }
    const root = path.resolve(this.deps.root || '.');
    const target = path.resolve(root, trimmed);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return;
    }
    let directory = false;
    try {
      directory = statSync(target).isDirectory();
    } catch {
      void vscode.window.setStatusBarMessage('Dev-First: path no longer exists', 3000);
      return;
    }
    if (directory) {
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target));
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch {
      void vscode.window.setStatusBarMessage('Dev-First: could not open that file', 3000);
    }
  }

  private async exportDiagram(svg: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      filters: { 'SVG image': ['svg'] },
      saveLabel: 'Export architecture diagram',
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(svg, 'utf8'));
    void vscode.window.setStatusBarMessage('Dev-First: diagram exported', 3000);
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
    .codicon-export:before { content: "\\ebac"; }
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
    #df-refresh, #df-export, #df-zoom-in, #df-zoom-out, #df-zoom-fit {
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
    #df-refresh:disabled, #df-export:disabled { opacity: 0.4; cursor: default; }
    #df-refresh:hover:not(:disabled), #df-export:hover:not(:disabled), #df-zoom-in:hover, #df-zoom-out:hover, #df-zoom-fit:hover { background: var(--df-hover); }
    #df-refresh .codicon, #df-export .codicon { font-size: 12px; }
    #df-map-crumbs { display: flex; align-items: center; gap: 2px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    #df-map-crumbs button { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0 2px; font-size: 12px; }
    #df-map-crumbs button[disabled] { color: var(--vscode-foreground); cursor: default; }
    #df-hint {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--df-muted);
      font-size: 12px;
    }
    #df-status { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    #df-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 12px 0;
      padding: 8px 10px;
      border: 1px solid var(--vscode-inputValidation-errorBorder, var(--df-border));
      border-radius: var(--df-radius-md);
      background: var(--vscode-inputValidation-errorBackground, var(--df-surface));
      color: var(--vscode-foreground);
      font-size: 12px;
    }
    #df-banner[hidden] { display: none; }
    .df-error { color: var(--vscode-errorForeground); }
    #df-main { flex: 1; display: flex; min-height: 0; }
    #df-diagram-wrap { flex: 1; min-width: 0; overflow: hidden; padding: 24px; }
    #df-diagram { min-width: 100%; min-height: 100%; display: block; overflow: hidden; cursor: grab; }
    #df-diagram svg { display: block; max-width: none; height: auto; transform-origin: 0 0; }
    .df-state {
      margin: 48px auto;
      max-width: 480px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .df-state h2 { margin: 0; color: var(--vscode-foreground); font-size: 18px; font-weight: 600; }
    .df-state p { margin: 0; }
    .df-state-note { font-size: 12px; }
    .df-raw { max-height: 55vh; overflow: auto; padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; word-break: break-word; font-size: 11px; text-align: left; width: 100%; box-sizing: border-box; }
    .df-action {
      padding: 6px 14px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: var(--df-radius-sm);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-size: 12px;
    }
    .df-action:hover { background: var(--vscode-button-hoverBackground); }
    .df-progress {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .df-clickable { cursor: pointer; }
    .df-dim { opacity: 0.12; }
    .df-hi { stroke-width: 2.5px !important; }
    .df-clickable:hover > rect, .df-clickable:hover > path, .df-clickable:hover > polygon {
      stroke: var(--vscode-focusBorder) !important;
      stroke-width: 2px !important;
    }
    .edgePath path, .flowchart-link {
      stroke: var(--vscode-descriptionForeground) !important;
    }
    .df-fallback {
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: var(--df-radius-md);
      white-space: pre-wrap;
    }
    @media (max-width: 620px) { #df-diagram-wrap { padding: 14px; } #df-hint { display: none; } }
    @media (prefers-reduced-motion: reduce) { .codicon-modifier-spin { animation: none; } }
  </style>
</head>
<body>
  <header>
    <nav id="df-map-crumbs" aria-label="Architecture levels"></nav>
    <span id="df-hint" role="status"></span>
    <span id="df-status"></span>
    <button id="df-zoom-out" type="button" title="Zoom out">&#8722;</button>
    <button id="df-zoom-in" type="button" title="Zoom in">+</button>
    <button id="df-zoom-fit" type="button" title="Fit to view">Fit</button>
    <button id="df-refresh" type="button" title="Reload architecture">
      <span id="df-refresh-icon" class="codicon codicon-refresh" aria-hidden="true"></span>
    </button>
    <button id="df-export" type="button" title="Export diagram (SVG)">
      <span class="codicon codicon-export" aria-hidden="true"></span>
    </button>
  </header>
  <div id="df-banner" hidden></div>
  <main id="df-main">
    <section id="df-diagram-wrap"><div id="df-diagram"></div></section>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
