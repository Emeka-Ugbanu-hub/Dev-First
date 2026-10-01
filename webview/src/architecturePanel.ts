import mermaid from 'mermaid';
import {
  activationFor,
  conceptChildren,
  fileChildren,
  shouldRenderDiagram,
} from './architectureView';
import type { ArchitectureChild } from './architectureView';

type ChildView = ArchitectureChild;

interface DetailView {
  id: string;
  kind: string;
  label: string;
  description: string;
  usedBy: string[];
  dependsOn: string[];
  implementedBy: number;
  files: string[];
}

interface LevelMessage {
  type: 'level';
  node: DetailView;
  children: ChildView[];
  breadcrumbs: Array<{ id: string; label: string; kind: string }>;
  diagram: string;
  relations: Array<{
    label: string;
    fromLabel: string;
    toLabel: string;
    weight: number;
    evidenceTotal?: number;
    evidence: Array<{ fromFile: string; toFile: string; sourceFile: string; line: number; kind: string; role: string; symbol?: string; count?: number }>;
  }>;
  coverage: {
    indexedFiles: number;
    representedFiles: number;
    unresolvedImports: number;
    unresolvedTauriCommands: number;
    unsupportedSourceFiles: number;
    parseFailures: number;
    oversizedSourceFiles: number;
    scanLimitReached: boolean;
  };
}

interface EmptyMessage {
  type: 'empty';
  message: string;
}

interface RefreshingMessage {
  type: 'refreshing';
}

interface RefreshedMessage {
  type: 'refreshed';
  text?: string;
}

interface HintMessage {
  type: 'hint';
  text: string;
}

type IncomingMessage =
  | LevelMessage
  | EmptyMessage
  | RefreshingMessage
  | RefreshedMessage
  | HintMessage;

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const backButton = document.getElementById('df-back') as HTMLButtonElement | null;
const refreshButton = document.getElementById('df-refresh') as HTMLButtonElement | null;
const refreshIcon = document.getElementById('df-refresh-icon');
const crumbs = document.getElementById('df-crumbs');
const hint = document.getElementById('df-hint');
const diagram = document.getElementById('df-diagram');
const detail = document.getElementById('df-detail');
const status = document.getElementById('df-status');

let childIndex = new Map<string, ChildView>();
let breadcrumbTrail: Array<{ id: string; label: string }> = [];
let renderToken = 0;
let lastDark: boolean | undefined;
let statusTimer: number | undefined;

function setStatus(text: string, clearAfterMs?: number): void {
  if (!status) {
    return;
  }
  if (statusTimer !== undefined) {
    window.clearTimeout(statusTimer);
    statusTimer = undefined;
  }
  status.textContent = text;
  if (clearAfterMs !== undefined) {
    statusTimer = window.setTimeout(() => {
      statusTimer = undefined;
      if (status) {
        status.textContent = '';
      }
    }, clearAfterMs);
  }
}

function clearRenderingStatus(): void {
  if (status && status.textContent === 'Rendering…') {
    setStatus('');
  }
}

function setRefreshing(active: boolean): void {
  if (active) {
    setStatus('Refreshing…');
  }
  refreshIcon?.classList.toggle('codicon-modifier-spin', active);
  if (refreshButton) {
    refreshButton.disabled = active;
  }
}

function setHint(text: string): void {
  if (hint) {
    hint.textContent = text;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortName(path: string): string {
  const clean = path.replace(/^file:\/\//, '');
  const parts = clean.split('/');
  return decodeURIComponent(parts[parts.length - 1] || clean);
}

function post(message: unknown): void {
  vscode.postMessage(message);
}

function ensureInit(): void {
  const dark =
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast');
  if (lastDark === dark) {
    return;
  }
  lastDark = dark;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'var(--vscode-font-family)',
    flowchart: {
      htmlLabels: false,
      useMaxWidth: false,
      nodeSpacing: 70,
      rankSpacing: 90,
      padding: 18,
      curve: 'basis',
    },
  });
}

function activate(child: ChildView): void {
  post(activationFor(child));
}

function wireNodes(): void {
  if (!diagram) {
    return;
  }
  const nodes = diagram.querySelectorAll<SVGGElement>('g.node');
  nodes.forEach((element) => {
    const match = /n(\d+)-\d+$/.exec(element.id);
    const key = match ? `n${match[1]}` : element.getAttribute('data-id')?.split('-')[0];
    const child = key ? childIndex.get(key) : undefined;
    if (!child) {
      return;
    }
    element.classList.add('df-clickable');
    element.addEventListener('click', () => activate(child));
  });
}

function renderOverview(node: DetailView, children: ChildView[]): void {
  if (!diagram) return;
  diagram.innerHTML = `
    <div class="df-overview">
      <div class="df-overview-root">
        <span class="df-overview-kind">${escapeHtml(node.kind)}</span>
        <strong>${escapeHtml(node.label)}</strong>
        <span>${children.length} direct items</span>
      </div>
      <div class="df-overview-grid" aria-label="Architecture map items">
        ${children.map((child, index) => {
          const name = child.kind === 'file' && child.file ? shortName(child.file) : child.label;
          const meta = child.kind === 'file' ? child.file ?? '' : `${child.fileCount} files`;
          return `<button type="button" class="df-overview-item ${escapeHtml(child.kind)}" data-node-key="n${index + 1}" title="${escapeHtml(meta)}">
            <span class="df-overview-kind">${escapeHtml(child.kind)}</span>
            <strong>${escapeHtml(name)}</strong>
            ${meta ? `<span class="df-overview-meta">${escapeHtml(meta)}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
    </div>`;
  diagram.querySelectorAll<HTMLButtonElement>('[data-node-key]').forEach((button) => {
    const child = childIndex.get(button.dataset.nodeKey ?? '');
    if (child) button.addEventListener('click', () => activate(child));
  });
}

function renderBreadcrumbs(): void {
  if (!crumbs) {
    return;
  }
  crumbs.innerHTML = '';
  breadcrumbTrail.forEach((crumb, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'df-crumb-sep';
      separator.textContent = '/';
      crumbs.appendChild(separator);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = index === breadcrumbTrail.length - 1 ? 'df-crumb current' : 'df-crumb';
    button.textContent = crumb.label;
    if (index < breadcrumbTrail.length - 1) {
      button.addEventListener('click', () => post({ type: 'navigate', id: crumb.id }));
    }
    crumbs.appendChild(button);
  });
  if (backButton) {
    backButton.disabled = breadcrumbTrail.length < 2;
  }
}

function chipList(values: string[]): string {
  if (values.length === 0) {
    return '<span class="df-empty">none</span>';
  }
  return `<ul class="df-list">${values
    .map((value) => `<li class="df-chip">${escapeHtml(value)}</li>`)
    .join('')}</ul>`;
}

function renderDetail(node: DetailView, levelFiles: ChildView[], message: LevelMessage, hideFiles = false): void {
  if (!detail) {
    return;
  }
  const listed = (
    levelFiles.length > 0
      ? levelFiles.map((child) => child.file ?? '')
      : node.files
  )
    .filter((path) => path.length > 0);
  const heading = listed.length === 1 ? '1 file' : `${listed.length} files`;
  detail.innerHTML = `
    <span class="df-kind">${escapeHtml(node.kind)}</span>
    <h2 class="df-title">${escapeHtml(node.label)}</h2>
    <p class="df-description">${escapeHtml(node.description)}</p>
    <div class="df-section">
      <h3>Implemented by ${node.implementedBy} file${node.implementedBy === 1 ? '' : 's'}</h3>
    </div>
    <div class="df-section">
      <h3>Used by</h3>
      ${chipList(node.usedBy)}
    </div>
    <div class="df-section">
      <h3>Depends on</h3>
      ${chipList(node.dependsOn)}
    </div>
    <div class="df-section">
      <h3>Verified relationships (${message.relations.length})</h3>
      ${message.relations.length === 0 ? '<span class="df-empty">No verified cross-group relationships at this level.</span>' : `
        <ul class="df-list">
          ${message.relations.map((relation) => `
            <li class="df-relation">
              <span>${escapeHtml(relation.fromLabel)} ${escapeHtml(relation.label)} ${escapeHtml(relation.toLabel)}</span>
              <ul class="df-files">${relation.evidence.map((evidence) => `
                <li><button type="button" class="df-file" data-path="${escapeHtml(evidence.sourceFile)}" data-line="${evidence.line}" title="${escapeHtml(evidence.sourceFile)}:${evidence.line + 1}">${escapeHtml(evidence.role)} · ${escapeHtml(shortName(evidence.sourceFile))}:${evidence.line + 1}${evidence.symbol ? ` · ${escapeHtml(evidence.symbol)}` : ''}${evidence.count && evidence.count > 1 ? ` ×${evidence.count}` : ''}</button></li>
              `).join('')}${relation.evidenceTotal && relation.evidenceTotal > relation.evidence.length ? `<li class="df-more">…and ${relation.evidenceTotal - relation.evidence.length} more</li>` : ''}</ul>
            </li>
          `).join('')}
        </ul>
      `}
    </div>
    <div class="df-section">
      <h3>Analysis coverage</h3>
      <p class="df-description">${message.coverage.representedFiles} of ${message.coverage.indexedFiles} indexed files are represented in this project map.</p>
      <p class="df-description">${message.coverage.unresolvedImports} unresolved local or Rust imports; ${message.coverage.unresolvedTauriCommands} unverified Tauri command calls.</p>
      <p class="df-description">${message.coverage.unsupportedSourceFiles} files use unsupported languages; ${message.coverage.parseFailures} files could not be parsed; ${message.coverage.oversizedSourceFiles} files exceeded the scan size limit.${message.coverage.scanLimitReached ? ' The file scan reached its 2,000-file cap.' : ''}</p>
    </div>
    ${hideFiles ? '' : `<div class="df-section">
      <h3>${heading}</h3>
      <ul class="df-files">
        ${listed
          .map(
            (path) =>
              `<li><button type="button" class="df-file" data-path="${escapeHtml(
                path,
              )}" title="${escapeHtml(path)}">${escapeHtml(shortName(path))}</button></li>`,
          )
          .join('')}
      </ul>
    </div>`}`;
  detail.querySelectorAll<HTMLButtonElement>('button.df-file').forEach((button) => {
    button.addEventListener('click', () =>
      post({
        type: 'openFile',
        path: button.dataset.path ?? '',
        line: Number(button.dataset.line ?? 0),
      }),
    );
  });
}

function displayFolder(path: string): string {
  const clean = path.replace(/^file:\/\//, '');
  const parts = clean.split('/').filter(Boolean);
  parts.pop();
  return decodeURIComponent(parts.slice(-2).join('/'));
}

function renderFileLevel(node: DetailView, files: ChildView[]): void {
  if (!diagram) {
    return;
  }
  const cards = files
    .map((child) => {
      const path = child.file ?? '';
      const name = path ? shortName(path) : child.label;
      const folder = path ? displayFolder(path) : '';
      return `<button type="button" class="df-file-card" data-path="${escapeHtml(path)}" title="${escapeHtml(path)}">
        <span class="df-file-card-name">${escapeHtml(name)}</span>
        ${folder ? `<span class="df-file-card-path">${escapeHtml(folder)}</span>` : ''}
      </button>`;
    })
    .join('');
  diagram.innerHTML = `
    <div class="df-file-grid">
      <div class="df-file-grid-header">
        <span class="df-overview-kind">${escapeHtml(node.kind)}</span>
        <strong>${escapeHtml(node.label)}</strong>
        <span>${files.length === 1 ? '1 file' : `${files.length} files`}</span>
      </div>
      <div class="df-file-grid-cards">${cards}</div>
    </div>`;
  diagram.querySelectorAll<HTMLButtonElement>('button.df-file-card').forEach((button) => {
    button.addEventListener('click', () =>
      post({ type: 'openFile', path: button.dataset.path ?? '', line: 0 }),
    );
  });
}

async function render(message: LevelMessage): Promise<void> {
  const token = ++renderToken;
  setHint('');
  breadcrumbTrail = message.breadcrumbs;
  renderBreadcrumbs();
  const concepts = conceptChildren(message.children);
  const files = fileChildren(message.children);
  const filesOnly = !shouldRenderDiagram(message.children);
  renderDetail(message.node, files, message, filesOnly);
  childIndex = new Map(concepts.map((child, index) => [`n${index + 1}`, child]));
  if (filesOnly) {
    renderFileLevel(message.node, files);
    clearRenderingStatus();
    return;
  }
  if (concepts.length > 12) {
    renderOverview(message.node, concepts);
    clearRenderingStatus();
    return;
  }
  setStatus('Rendering…');
  ensureInit();
  try {
    const id = `df-architecture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { svg } = await mermaid.render(id, message.diagram);
    if (token !== renderToken || !diagram) {
      return;
    }
    diagram.innerHTML = svg;
    wireNodes();
    clearRenderingStatus();
  } catch {
    if (token !== renderToken || !diagram) {
      return;
    }
    diagram.innerHTML = `<pre class="df-fallback">${escapeHtml(message.diagram)}</pre>`;
    setStatus('Diagram unavailable');
  }
}

function renderEmpty(message: EmptyMessage): void {
  setHint('');
  if (detail) {
    detail.innerHTML = '';
  }
  if (diagram) {
    diagram.innerHTML = `<p id="df-empty">${escapeHtml(message.message)}</p>`;
  }
  setStatus('');
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as IncomingMessage | undefined;
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'level') {
    void render(message);
    return;
  }
  if (message.type === 'empty') {
    renderEmpty(message);
    return;
  }
  if (message.type === 'refreshing') {
    setRefreshing(true);
    return;
  }
  if (message.type === 'refreshed') {
    setRefreshing(false);
    setStatus(message.text ?? 'Updated just now', 3000);
    return;
  }
  if (message.type === 'hint') {
    setHint(message.text);
  }
});

if (backButton) {
  backButton.addEventListener('click', () => {
    if (breadcrumbTrail.length > 1) {
      post({ type: 'navigate', id: breadcrumbTrail[breadcrumbTrail.length - 2].id });
    }
  });
}

if (refreshButton) {
  refreshButton.addEventListener('click', () => {
    setRefreshing(true);
    post({ type: 'refresh' });
  });
}

post({ type: 'ready' });
