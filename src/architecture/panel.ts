import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import type { FileFacts } from '../scan/duplication';
import type { ArchitectureScanCoverage } from '../scan/duplication';
import type { ChatOptions, LLMProvider, ToolCall, ToolDef } from '../llm/types';
import { buildMapDigest } from './mapDigest';
import { buildMermaidMap, mapPathsOf, parseStructuredMap } from './mapValidate';
import { buildLevelView } from './mapLevels';
import {
  ARCHITECTURE_MAP_KEY,
  StoredArchitectureMap,
  architectureFilesHash,
  isStale,
  readStoredMap,
  writeStoredMap,
  ArchitectureMapCoverage,
} from './mapStore';
import { generateArchitectureMap } from './mapGenerate';
import { buildStructuralMap } from './structuralMap';
import { summarizeFiles, summarizeModules } from './fileSummaries';

export interface ArchitecturePanelDeps {
  extensionUri: vscode.Uri;
  root: string;
  state: vscode.Memento;
  getFacts: () => Promise<FileFacts[]>;
  getCoverage: () => Promise<ArchitectureScanCoverage>;
  getActive: () => Promise<{ provider: LLMProvider; model: string } | undefined>;
  getReasoning?: () => ChatOptions['reasoning'] | Promise<ChatOptions['reasoning']>;
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

function relativeFile(root: string, value: string): string {
  let candidate = value.trim();
  if (/^file:/i.test(candidate)) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      candidate = candidate.replace(/^file:\/\//i, '');
    }
  }
  const absolute = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, '/')
    : value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function architectureDomain(file: string, fact?: FileFacts): string {
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
  const ignored = new Set(['src', 'app', 'lib', 'packages']);
  const lowerFile = file.toLowerCase();
  if (fact?.sql.length || /(^|\/)(db|database|prisma|migrations?|repositories?)(\/|$)/.test(lowerFile)) return 'Database';
  if (fact?.handlers.length || fact?.httpClients.length || /(^|\/)(api|server|routes?|controllers?|services?|middleware)(\/|$)/.test(lowerFile)) return 'Backend';
  if (/(^|\/)(functions?|lambda|workers?|jobs?|queues?)(\/|$)/.test(lowerFile)) return 'Functions';
  if (/(^|\/)(cloud|infra|infrastructure|deploy|terraform|\.github)(\/|$)/.test(lowerFile)) return 'Cloud';
  if (/\.(jsx?|tsx?|vue|svelte|astro|css|scss)$/.test(lowerFile) && /\.(tsx?|jsx?)$/.test(lowerFile)) return 'Frontend';
  const segment = parts.slice(0, -1).find((part) => !ignored.has(part.toLowerCase())) ?? 'Core';
  const value = segment.toLowerCase();
  if (/^(front|client|component|page|screen|view|ui)/.test(value)) return 'Frontend';
  if (/^(back|server|api|route|controller|service|middleware)/.test(value)) return 'Backend';
  if (/^(db|database|data|prisma|sql|migration|repository|repo)/.test(value)) return 'Database';
  if (/^(cloud|infra|infrastructure|deploy|terraform|aws|azure|gcp)/.test(value)) return 'Cloud';
  if (/^(function|functions|lambda|worker|jobs|queue)/.test(value)) return 'Functions';
  return segment;
}

function mergeArchitectureMaps(
  base: StoredArchitectureMap,
  detail: import('./mapValidate').StructuredMap,
  domain: string,
  root: string,
  model: string,
): StoredArchitectureMap {
  const prefix = domain.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const existing = new Set(base.structured.nodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  const nodes = detail.nodes.map((node) => {
    if (node.id === 'project' || node.id === 'root') {
      return undefined;
    }
    let id = `${prefix}_${node.id}`;
    while (existing.has(id)) id = `${id}_`;
    existing.add(id);
    idMap.set(node.id, id);
    return {
      ...node,
      id,
      group: node.group ? `${domain}/${node.group}` : domain,
    };
  }).filter((node): node is NonNullable<typeof node> => Boolean(node));
  const edges = detail.edges.flatMap((edge) => {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (!from || !to || from === to) return [];
    return [{ ...edge, from, to }];
  });
  const structured = {
    nodes: [...base.structured.nodes, ...nodes],
    edges: [...base.structured.edges, ...edges],
  };
  const filesHash = base.filesHash;
  return {
    ...base,
    model,
    generatedAt: Date.now(),
    filesHash,
    mermaid: buildMermaidMap(structured),
    paths: mapPathsOf(structured, (relative) => existsSync(path.join(root, relative))),
    structured,
  };
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
  private latestFacts: FileFacts[] = [];
  private latestActive: { provider: LLMProvider; model: string } | undefined;
  private latestTools: ToolDef[] = [];
  private readonly generatedScopes = new Set<string>();
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
        if (target.length > 1 && !this.generatedScopes.has(target.join('/'))) {
          void this.generateLazyScope(target);
        }
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
      this.postMap(stored, false);
      void this.refreshStaleFlag(stored);
      return;
    }
    const reason = (await this.hasProvider()) ? EMPTY_NOT_DRAWN : EMPTY_NO_MODEL;
    this.post({ type: 'empty', reason, project: this.projectName });
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
    this.latestActive = active;
    this.post({
      type: 'generating',
      progress: 'Reading files…',
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
      // Publish a verified scanner-based map before model enrichment. This
      // keeps architecture useful when a local model is slow, unavailable, or
      // returns malformed JSON.
      const structural = buildStructuralMap(facts, this.deps.root, this.projectName);
      this.latestFacts = facts;
      this.latestTools = tools;
      const baselineCoverage: ArchitectureMapCoverage = {
        ...scanCoverage,
        indexedFiles: facts.length,
        representedFiles: structural.representedFiles,
        unresolvedRelationships: structural.unresolvedRelationships,
      };
      const baseline: StoredArchitectureMap = {
        version: 3,
        workspaceRoot: path.resolve(this.deps.root),
        filesHash: architectureFilesHash(facts.map((fact) => fact.file)),
        mermaid: buildMermaidMap(structural.map),
        paths: mapPathsOf(structural.map, (relative) => existsSync(path.join(this.deps.root, relative))),
        structured: structural.map,
        model: active.model,
        generatedAt: Date.now(),
        coverage: baselineCoverage,
      };
      this.stored = baseline;
      this.currentStale = false;
      this.levelPath = [];
      try {
        await writeStoredMap(this.deps.state, baseline);
      } catch {}
      this.post({
        type: 'generating',
        progress: 'Generating the AI overview…',
        hasMap: true,
        project: this.projectName,
      });
      this.postMap(baseline, false);
      const raw = await generateArchitectureMap(digest, {
        provider: active.provider,
        model: active.model,
        reasoning: await this.deps.getReasoning?.(),
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
          type: 'generating',
          progress: 'Model enrichment unavailable; keeping the verified map.',
          hasMap: true,
          project: this.projectName,
        });
        this.postMap(baseline, false);
        return;
      }
      this.lastRaw = raw;
      const parsed = parseStructuredMap(raw);
      if (!parsed || parsed.nodes.length < 2) {
        this.post({
          type: 'generating',
          progress: 'Model returned an unusable structure; keeping the verified map.',
          hasMap: true,
          project: this.projectName,
        });
        this.postMap(baseline, false);
        return;
      }
      const indexedFiles = new Set(facts.map((fact) => relativeFile(this.deps.root, fact.file)));
      const validated = {
        ...parsed,
        nodes: parsed.nodes.map((node) => {
          if (!node.path) {
            return node;
          }
          const candidate = node.path.replace(/\\/g, '/').replace(/^\.\//, '');
          return existsSync(path.join(this.deps.root, candidate))
            ? { ...node, path: candidate }
            : { ...node, path: undefined };
        }),
        edges: parsed.edges.filter((edge) => {
          edge.evidence = edge.evidence?.filter((item) => {
            const relative = relativeFile(this.deps.root, item.path);
            if (!indexedFiles.has(relative) || item.line <= 0) {
              return false;
            }
            try {
              const source = readFileSync(path.join(this.deps.root, relative), 'utf8');
              return item.line <= source.split(/\r?\n/).length;
            } catch {
              return false;
            }
          });
          return Boolean(edge.evidence?.length);
        }),
      };
      const representedFiles = facts.filter((fact) => {
        const file = relativeFile(this.deps.root, fact.file);
        return validated.nodes.some((node) => {
          const nodePath = node.path && node.path.replace(/\\/g, '/').replace(/^\.\//, '');
          return nodePath && (nodePath === file || file.startsWith(`${nodePath}/`));
        });
      }).length;
      const coverage: ArchitectureMapCoverage = {
        ...scanCoverage,
        indexedFiles: facts.length,
        representedFiles,
        unresolvedRelationships: 0,
      };
      const map: StoredArchitectureMap = {
        version: 3,
        workspaceRoot: path.resolve(this.deps.root),
        filesHash: architectureFilesHash(facts.map((fact) => fact.file)),
        mermaid: buildMermaidMap(validated),
        paths: mapPathsOf(validated, (relative) => existsSync(path.join(this.deps.root, relative))),
        structured: validated,
        model: active.model,
        generatedAt: Date.now(),
        coverage,
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
      await this.generateArchitectureDomains(map, facts, active, tools, controller);
    } finally {
      this.generating = false;
      if (this.controller === controller) {
        this.controller = undefined;
      }
    }
  }

  private async generateArchitectureDomains(
    overview: StoredArchitectureMap,
    facts: FileFacts[],
    active: { provider: LLMProvider; model: string },
    tools: ToolDef[],
    controller: AbortController,
  ): Promise<void> {
    const domains = [...new Set(facts
      .map((fact) => architectureDomain(relativeFile(this.deps.root, fact.file), fact))
      .filter((domain) => domain !== 'root'))];
    for (let index = 0; index < domains.length; index++) {
      if (this.disposed || controller.signal.aborted) return;
      const domain = domains[index];
      const domainFacts = facts.filter((fact) => architectureDomain(relativeFile(this.deps.root, fact.file), fact) === domain);
      if (domainFacts.length === 0) continue;
      this.post({
        type: 'generating',
        progress: `Generating ${domain} (${index + 1}/${domains.length})…`,
        hasMap: true,
        project: this.projectName,
      });
      const summaries = await summarizeFiles(
        active.provider,
        active.model,
        this.deps.state,
        domainFacts.map((fact) => ({ path: relativeFile(this.deps.root, fact.file), fact })),
        controller.signal,
        (file) => this.post({ type: 'generating', progress: `${domain}: summarizing ${file}`, hasMap: true, project: this.projectName }),
        path.resolve(this.deps.root),
      );
      const moduleGroups = new Map<string, Array<{ path: string; summary: string }>>();
      for (const fact of domainFacts) {
        const file = relativeFile(this.deps.root, fact.file);
        const parts = file.split('/').filter(Boolean);
        const module = parts.length > 1 ? parts.slice(0, -1).join('/') : domain;
        const list = moduleGroups.get(module) ?? [];
        list.push({ path: file, summary: summaries[file] ?? 'No cached summary available.' });
        moduleGroups.set(module, list);
      }
      const moduleSummaries = await summarizeModules(
        active.provider,
        active.model,
        this.deps.state,
        [...moduleGroups.entries()].map(([key, files]) => ({ key, files })),
        controller.signal,
        (module) => this.post({ type: 'generating', progress: `${domain}: reducing ${module}`, hasMap: true, project: this.projectName }),
        path.resolve(this.deps.root),
      );
      const domainRaw = await generateArchitectureMap(buildMapDigest(domainFacts, this.deps.root, summaries, moduleSummaries), {
        provider: active.provider,
        model: active.model,
        reasoning: await this.deps.getReasoning?.(),
        tools,
        executeTool: this.deps.executeTool,
        signal: controller.signal,
        maxSteps: 12,
        onProgress: (text, done) => {
          if (!done && !this.disposed && !controller.signal.aborted) {
            this.post({ type: 'generating', progress: `${domain}: ${text}`, hasMap: true, project: this.projectName });
          }
        },
      });
      if (!domainRaw || this.disposed || controller.signal.aborted) continue;
      const parsed = parseStructuredMap(domainRaw);
      if (!parsed || parsed.nodes.length < 2) continue;
      const merged = mergeArchitectureMaps(this.stored ?? overview, parsed, domain, this.deps.root, active.model);
      this.stored = merged;
      try {
        await writeStoredMap(this.deps.state, merged);
      } catch {}
      this.postMap(merged, false);
      this.post({ type: 'generating', progress: `${domain} ready`, hasMap: true, project: this.projectName });
    }
  }

  private async generateLazyScope(scope: string[]): Promise<void> {
    const active = this.latestActive;
    const facts = this.latestFacts;
    if (!active || facts.length === 0 || this.disposed || !this.stored) return;
    const key = scope.join('/');
    this.generatedScopes.add(key);
    const domain = scope[0];
    const scopedFacts = facts.filter((fact) => {
      const file = relativeFile(this.deps.root, fact.file);
      const parts = file.split('/').filter(Boolean);
      return architectureDomain(file, fact) === domain && parts.includes(scope[scope.length - 1]);
    });
    if (scopedFacts.length === 0) return;
    const controller = new AbortController();
    this.post({ type: 'generating', progress: `Loading ${key}…`, hasMap: true, project: this.projectName });
    const raw = await generateArchitectureMap(buildMapDigest(scopedFacts, this.deps.root), {
      provider: active.provider,
      model: active.model,
      reasoning: await this.deps.getReasoning?.(),
      tools: this.latestTools,
      executeTool: this.deps.executeTool,
      signal: controller.signal,
      maxSteps: 12,
      onProgress: (text, done) => {
        if (!done && !this.disposed) {
          this.post({ type: 'generating', progress: `${key}: ${text}`, hasMap: true, project: this.projectName });
        }
      },
    });
    if (!raw || this.disposed || !this.stored) return;
    const parsed = parseStructuredMap(raw);
    if (!parsed || parsed.nodes.length < 2) return;
    const merged = mergeArchitectureMaps(this.stored, parsed, domain, this.deps.root, active.model);
    this.stored = merged;
    try {
      await writeStoredMap(this.deps.state, merged);
    } catch {}
    this.postMap(merged, false);
    this.post({ type: 'generating', progress: `${key} ready`, hasMap: true, project: this.projectName });
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
