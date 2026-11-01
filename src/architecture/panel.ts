import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
import * as path from 'path';
import type { FileFacts } from '../scan/duplication';
import type { ArchitectureScanCoverage } from '../scan/duplication';
import { buildMermaidMap, mapPathsOf } from './mapValidate';
import { buildLevelView } from './mapLevels';
import {
  ARCHITECTURE_MAP_KEY,
  ARCHITECTURE_MAP_VERSION,
  StoredArchitectureMap,
  architectureFactsHash,
  isStale,
  readStoredMap,
  writeStoredMap,
  ArchitectureMapCoverage,
} from './mapStore';
import { selectArchitectureFacts } from './structuralMap';
import { buildDeterministicMap } from './deterministicMap';

export interface ArchitecturePanelDeps {
  extensionUri: vscode.Uri;
  root: string;
  state: vscode.Memento;
  getFacts: () => Promise<FileFacts[]>;
  getCoverage: () => Promise<ArchitectureScanCoverage>;
}

interface ArchitectureMessage {
  type?: string;
  id?: string;
  path?: string;
  svg?: string;
  crumbs?: string[];
  targetPath?: string[];
}

export const EMPTY_NO_FACTS = 'no-facts';

export class ArchitecturePanel {
  static current: ArchitecturePanel | undefined;

  private stored: StoredArchitectureMap | undefined;
  private generating = false;
  private levelPath: string[] = [];
  private groupIndex = new Map<string, string[]>();
  private currentStale = false;
  private disposed = false;
  private readonly projectName: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: ArchitecturePanelDeps,
  ) {
    this.stored = this.readProjectMap();
    this.projectName = path.basename(deps.root) || 'this project';
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => this.dispose());
    panel.webview.onDidReceiveMessage((message: ArchitectureMessage) =>
      void this.handle(message),
    );
  }

  static async show(deps: ArchitecturePanelDeps): Promise<void> {
    if (ArchitecturePanel.current) {
      const currentRoot = path.resolve(ArchitecturePanel.current.deps.root);
      const requestedRoot = path.resolve(deps.root);
      if (currentRoot === requestedRoot) {
        ArchitecturePanel.current.panel.reveal(vscode.ViewColumn.Active);
        return;
      }
      // Do not carry a map from another workspace into this project.
      ArchitecturePanel.current.dispose();
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
    if (message.type === 'drillDown' && typeof message.id === 'string') {
      const target = this.groupIndex.get(message.id);
      if (target && this.stored) {
        this.levelPath = target;
        this.postMap(this.stored, this.currentStale);
      }
      return;
    }
    if (message.type === 'navigate' && Array.isArray(message.targetPath)) {
      if (this.stored) {
        this.levelPath = message.targetPath.filter(
          (segment): segment is string => typeof segment === 'string',
        );
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
    const stored = this.stored ?? this.readProjectMap();
    this.stored = stored;
    if (stored) {
      // Do not present a map from an earlier checkout as the current project.
      try {
        const facts = await this.deps.getFacts();
        if (isStale(stored, architectureFactsHash(facts))) {
          this.stored = undefined;
          this.levelPath = [];
          this.groupIndex.clear();
          this.post({
            type: 'generating',
            progress: 'Code changed — rebuilding the architecture map…',
            hasMap: false,
            project: this.projectName,
          });
          void this.runGenerate();
          return;
        }
      } catch {
        // If the index is temporarily unavailable, keep the verified stored
        // map rather than blocking the panel. A later reload will re-check it.
      }
      this.postMap(stored, false);
      return;
    }
    // No stored map: build the deterministic map immediately. No model is
    // needed; this is the same scanner-fact path used by Refresh.
    void this.runGenerate();
  }

  private readProjectMap(): StoredArchitectureMap | undefined {
    const stored = readStoredMap(this.deps.state);
    if (!stored) return undefined;
    if (stored.workspaceRoot === path.resolve(this.deps.root)) return stored;
    // There is one durable map slot, so discard a map from another/older
    // workspace instead of retaining stale project data in global state.
    void this.deps.state.update(ARCHITECTURE_MAP_KEY, undefined);
    return undefined;
  }

  private async runGenerate(): Promise<void> {
    if (this.disposed || this.generating) {
      return;
    }
    this.generating = true;
    const hasMap = Boolean(this.stored);
    this.post({
      type: 'generating',
      progress: 'Reading indexed files…',
      hasMap,
      project: this.projectName,
    });
    try {
      let facts: FileFacts[] = [];
      let scanCoverage: ArchitectureScanCoverage = {
        unsupportedSourceFiles: 0,
        parseFailures: 0,
        oversizedSourceFiles: 0,
        scanLimitReached: false,
      };
      try {
        facts = await this.deps.getFacts();
      } catch {
        facts = [];
      }
      try {
        scanCoverage = await this.deps.getCoverage();
      } catch {}
      if (this.disposed) {
        return;
      }
      if (facts.length === 0) {
        this.post({ type: 'empty', reason: EMPTY_NO_FACTS, project: this.projectName });
        return;
      }
      const selectedFacts = selectArchitectureFacts(facts, this.deps.root);
      const architectureFacts = selectedFacts.length > 0 ? selectedFacts : facts;
      this.post({
        type: 'generating',
        progress: 'Building the verified map…',
        hasMap,
        project: this.projectName,
      });
      const result = await buildDeterministicMap(architectureFacts, this.deps.root, this.projectName);
      if (this.disposed) {
        return;
      }
      const coverage: ArchitectureMapCoverage = {
        ...scanCoverage,
        indexedFiles: facts.length,
        representedFiles: result.representedFiles,
        unresolvedRelationships: result.unresolvedRelationships,
        isolatedFiles: result.isolatedFiles,
        unclassifiedFiles: result.unclassifiedFiles,
        excludedFiles: Math.max(0, facts.length - architectureFacts.length),
        fingerprint: result.fingerprint,
      };
      const map: StoredArchitectureMap = {
        version: ARCHITECTURE_MAP_VERSION,
        workspaceRoot: path.resolve(this.deps.root),
        filesHash: architectureFactsHash(facts),
        mermaid: buildMermaidMap(result.map),
        paths: mapPathsOf(result.map, (relative) => existsSync(path.join(this.deps.root, relative))),
        structured: result.map,
        model: 'scanner facts',
        generatedAt: Date.now(),
        coverage,
      };
      this.stored = map;
      this.currentStale = false;
      this.levelPath = [];
      this.groupIndex.clear();
      try {
        await writeStoredMap(this.deps.state, map);
      } catch {}
      if (!this.disposed) {
        this.postMap(map, false);
      }
    } finally {
      this.generating = false;
    }
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
      kind: view.kind,
      items: view.items,
      related: view.related,
      systemTargets: view.systemTargets,
      hiddenEdges: view.hiddenEdges,
      totalEdges: view.totalEdges,
      stale,
      generatedAt: map.generatedAt,
      model: map.model,
      coverage: map.coverage,
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
    #df-back, #df-refresh, #df-export, #df-zoom-in, #df-zoom-out, #df-zoom-fit {
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
    #df-refresh:disabled, #df-export:disabled, #df-back:disabled, #df-zoom-in:disabled, #df-zoom-out:disabled, #df-zoom-fit:disabled { opacity: 0.4; cursor: default; }
    #df-refresh:hover:not(:disabled), #df-export:hover:not(:disabled), #df-back:hover:not(:disabled), #df-zoom-in:hover:not(:disabled), #df-zoom-out:hover:not(:disabled), #df-zoom-fit:hover:not(:disabled) { background: var(--df-hover); }
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
    #df-diagram[hidden], #df-cards[hidden], #df-files[hidden], #df-side[hidden] { display: none; }
    #df-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
      gap: 10px;
      align-content: start;
      height: 100%;
      overflow: auto;
    }
    .df-card {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      padding: 12px;
      border: 1px solid var(--df-border);
      border-radius: var(--df-radius-lg);
      background: var(--df-surface);
      color: var(--vscode-foreground);
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .df-card:hover { background: var(--df-hover); border-color: var(--vscode-focusBorder); }
    .df-card-title { font-size: 13px; font-weight: 600; }
    .df-card-meta { color: var(--df-muted); font-size: 11px; }
    #df-files { display: flex; flex-direction: column; gap: 2px; height: 100%; overflow: auto; }
    .df-file-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid transparent;
      border-radius: var(--df-radius-md);
      cursor: pointer;
      color: var(--vscode-foreground);
    }
    .df-file-row:hover { background: var(--df-hover); }
    .df-file-row.df-selected { background: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder); }
    .df-file-name { display: block; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .df-file-path { display: block; color: var(--df-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .df-file-counts { color: var(--df-muted); font-size: 11px; white-space: nowrap; }
    .df-file-open {
      border: 1px solid var(--df-border);
      border-radius: var(--df-radius-sm);
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      cursor: pointer;
      font-size: 11px;
      padding: 3px 8px;
    }
    .df-badge { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; font-weight: 500; }
    #df-side { width: 300px; flex: 0 0 300px; border-left: 1px solid var(--df-border); padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 18px; }
    .df-side-head { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    .df-side-head strong { font-size: 14px; }
    .df-side-path { color: var(--df-muted); font-size: 11px; word-break: break-all; }
    .df-side-section { display: flex; flex-direction: column; gap: 6px; }
    .df-side-section h3 { margin: 0; color: var(--df-muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .df-related-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 8px; width: 100%; padding: 7px 8px; border: 1px solid transparent; border-radius: var(--df-radius-sm); background: transparent; color: var(--vscode-foreground); text-align: left; cursor: pointer; font: inherit; }
    .df-related-row:hover { background: var(--df-hover); border-color: var(--df-border); }
    .df-related-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .df-related-parent { grid-column: 1 / 2; color: var(--df-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .df-related-count { grid-column: 2 / 3; grid-row: 1 / 3; align-self: center; color: var(--df-muted); font-size: 11px; }
    .df-link-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 6px 8px; border: 1px solid transparent; border-radius: var(--df-radius-sm); background: transparent; color: var(--vscode-textLink-foreground); text-align: left; cursor: pointer; font: inherit; font-size: 12px; }
    .df-link-row:hover { background: var(--df-hover); border-color: var(--df-border); }
    .df-link-meta { color: var(--df-muted); font-size: 10px; }
    .df-system-link { cursor: default; color: var(--vscode-foreground); }
    .df-system-link:hover { background: transparent; border-color: transparent; }
    .df-system-target { display: flex; flex-direction: column; gap: 3px; padding-bottom: 8px; border-bottom: 1px solid var(--df-border); }
    .df-system-target:last-child { padding-bottom: 0; border-bottom: none; }
    .df-system-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 8px; }
    .df-system-name { font-size: 12px; font-weight: 600; }
    .df-system-count { color: var(--df-muted); font-size: 10px; white-space: nowrap; }
    .df-side-empty { color: var(--df-muted); font-size: 12px; line-height: 1.5; }
    .df-side-open { margin-top: 4px; }
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
    @media (max-width: 760px) { #df-side { width: 240px; flex-basis: 240px; } }
    @media (max-width: 620px) {
      #df-diagram-wrap { padding: 14px; }
      #df-hint { display: none; }
      #df-main { flex-direction: column; }
      #df-side { width: auto; flex: 0 0 auto; max-height: 45vh; border-left: none; border-top: 1px solid var(--df-border); }
    }
    @media (prefers-reduced-motion: reduce) { .codicon-modifier-spin { animation: none; } }
  </style>
</head>
<body>
  <header>
    <button id="df-back" type="button" title="Back" disabled>&#8592; Back</button>
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
    <section id="df-diagram-wrap">
      <div id="df-diagram"></div>
      <div id="df-cards" hidden></div>
      <div id="df-files" hidden></div>
    </section>
    <aside id="df-side" hidden></aside>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
