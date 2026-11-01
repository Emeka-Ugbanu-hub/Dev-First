import mermaid from 'mermaid';

const MIN_READABLE_SCALE = 0.8;

interface LevelLink {
  label: string;
  path?: string;
  groupPath?: string[];
  route?: boolean;
  system?: boolean;
  labels: string[];
  count: number;
}

interface LevelGroupItem {
  kind: 'group';
  id: string;
  label: string;
  path: string[];
  fileCount: number;
  routeCount: number;
}

interface LevelFileItem {
  kind: 'file';
  id: string;
  label: string;
  path?: string;
  route: boolean;
  inCount: number;
  outCount: number;
  uses: LevelLink[];
  usedBy: LevelLink[];
}

type LevelItem = LevelGroupItem | LevelFileItem;

interface LevelRelated {
  label: string;
  path: string[];
  count: number;
  labels: string[];
}

interface LevelSystemFile {
  label: string;
  path: string;
  labels: string[];
  count: number;
}

interface LevelSystemTarget {
  label: string;
  path: string[];
  count: number;
  files: LevelSystemFile[];
}

interface MapMessage {
  type: 'map';
  mermaid: string;
  paths: Record<string, string>;
  groups?: Record<string, string[]>;
  breadcrumbs?: Array<{ label: string; path: string[] }>;
  kind?: 'project' | 'layer' | 'files';
  items?: LevelItem[];
  related?: LevelRelated[];
  systemTargets?: LevelSystemTarget[];
  stale: boolean;
  generatedAt: number;
  model: string;
  coverage?: {
    indexedFiles: number;
    representedFiles: number;
    unsupportedSourceFiles: number;
    parseFailures: number;
    oversizedSourceFiles: number;
    scanLimitReached: boolean;
    unresolvedRelationships: number;
    isolatedFiles?: number;
    unclassifiedFiles?: number;
    excludedFiles?: number;
    fingerprint?: string;
  };
  hiddenEdges?: number;
  totalEdges?: number;
}

interface EmptyMessage {
  type: 'empty';
  reason: string;
  project?: string;
}

interface GeneratingMessage {
  type: 'generating';
  progress: string;
  hasMap?: boolean;
  project?: string;
}

interface ErrorMessage {
  type: 'error';
  message: string;
  hasMap: boolean;
}

type IncomingMessage = MapMessage | EmptyMessage | GeneratingMessage | ErrorMessage;

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const refreshButton = document.getElementById('df-refresh') as HTMLButtonElement | null;
const exportButton = document.getElementById('df-export') as HTMLButtonElement | null;
const refreshIcon = document.getElementById('df-refresh-icon');
const hint = document.getElementById('df-hint');
const status = document.getElementById('df-status');
const banner = document.getElementById('df-banner');
const diagram = document.getElementById('df-diagram');
const cards = document.getElementById('df-cards');
const files = document.getElementById('df-files');
const side = document.getElementById('df-side');
const backButton = document.getElementById('df-back') as HTMLButtonElement | null;
const zoomInButton = document.getElementById('df-zoom-in') as HTMLButtonElement | null;
const zoomOutButton = document.getElementById('df-zoom-out') as HTMLButtonElement | null;
const zoomFitButton = document.getElementById('df-zoom-fit') as HTMLButtonElement | null;

let paths: Record<string, string> = {};
let hasMap = false;
let lastError: ErrorMessage | undefined;
let groups: Record<string, string[]> = {};
let crumbs: Array<{ label: string; path: string[] }> = [];
let levelKind: 'project' | 'layer' | 'files' = 'project';
let items: LevelItem[] = [];
let related: LevelRelated[] = [];
let systemTargets: LevelSystemTarget[] = [];
let selectedFileId: string | undefined;
let currentPath: string[] = [];
let backStack: string[][] = [];
let viewScale = 1;
let viewX = 0;
let viewY = 0;
let lastMermaid = '';
let projectName = 'this project';
let progressLines: string[] = [];
let renderToken = 0;
let lastDark: boolean | undefined;
let statusTimer: number | undefined;

function post(message: unknown): void {
  vscode.postMessage(message);
}

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

function hideBanner(): void {
  if (!banner) {
    return;
  }
  banner.hidden = true;
  banner.innerHTML = '';
}

function showBanner(message: string): void {
  if (!banner) {
    return;
  }
  banner.innerHTML = `<span class="df-error">${escapeHtml(message)}</span><button id="df-retry" class="df-action" type="button">Retry</button>`;
  banner.hidden = false;
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
      nodeSpacing: 90,
      rankSpacing: 130,
      padding: 18,
      curve: 'basis',
    },
  });
}

function nodeIdFor(element: SVGGElement): string | undefined {
  const raw = element.id || element.getAttribute('data-id') || '';
  const match = /flowchart-(.+?)-\d+$/.exec(raw);
  const candidate = match?.[1] ?? raw.replace(/^flowchart-/, '');
  return candidate || undefined;
}

function clearHighlight(): void {
  if (!diagram) {
    return;
  }
  diagram.querySelectorAll('.df-dim, .df-hi').forEach((element) => {
    element.classList.remove('df-dim', 'df-hi');
  });
}

function highlightEdges(nodeId: string): void {
  if (!diagram || !nodeId) {
    return;
  }
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[-_])${escaped}([-_]|$)`);
  diagram.querySelectorAll<SVGPathElement>('path.flowchart-link').forEach((path) => {
    const id = path.id ?? '';
    const connected = /^L[-_]/.test(id) && pattern.test(id.slice(2));
    path.classList.toggle('df-dim', !connected);
    path.classList.toggle('df-hi', connected);
  });
  diagram.querySelectorAll<SVGGElement>('g.node').forEach((element) => {
    const id = nodeIdFor(element);
    element.classList.toggle('df-dim', Boolean(id) && id !== nodeId);
  });
}

function wireNodes(): void {
  if (!diagram) {
    return;
  }
  diagram.querySelectorAll<SVGGElement>('g.node').forEach((element) => {
    const id = nodeIdFor(element);
    if (id) {
      element.addEventListener('mouseenter', () => highlightEdges(id));
      element.addEventListener('mouseleave', clearHighlight);
    }
    const group = id ? groups[id] : undefined;
    if (group) {
      element.classList.add('df-clickable');
      element.addEventListener('click', () => {
        backStack.push(currentPath);
        updateBackButton();
        post({ type: 'drillDown', id });
      });
      return;
    }
    const target = id ? paths[id] : undefined;
    if (!target) {
      return;
    }
    element.classList.add('df-clickable');
    element.addEventListener('click', () => post({ type: 'openPath', path: target }));
  });
}

function renderCrumbs(): void {
  const nav = document.getElementById('df-map-crumbs');
  if (!nav) {
    return;
  }
  nav.innerHTML = crumbs
    .map((crumb, index) => {
      const last = index === crumbs.length - 1;
      return `<button type="button" data-index="${index}"${last ? ' disabled' : ''}>${escapeHtml(crumb.label)}</button>`;
    })
    .join('<span>/</span>');
}

function updateBackButton(): void {
  if (backButton) {
    backButton.disabled = backStack.length === 0;
  }
}

function goBack(): void {
  const previous = backStack.pop();
  if (!previous) {
    updateBackButton();
    return;
  }
  updateBackButton();
  post({ type: 'navigate', targetPath: previous });
}

function goTo(target: string[]): void {
  if (target.join('/') === currentPath.join('/')) {
    return;
  }
  backStack.push(currentPath);
  updateBackButton();
  post({ type: 'navigate', targetPath: target });
}

function setStateMode(): void {
  if (diagram) diagram.hidden = false;
  if (cards) cards.hidden = true;
  if (files) files.hidden = true;
  if (side) side.hidden = true;
  for (const button of [zoomInButton, zoomOutButton, zoomFitButton, exportButton]) {
    if (button) button.disabled = true;
  }
}

function setGraphMode(): void {
  if (diagram) diagram.hidden = false;
  if (cards) cards.hidden = true;
  if (files) files.hidden = true;
  if (side) side.hidden = true;
  for (const button of [zoomInButton, zoomOutButton, zoomFitButton]) {
    if (button) button.disabled = false;
  }
  if (exportButton) exportButton.disabled = false;
}

function setCardsMode(): void {
  if (diagram) {
    diagram.hidden = true;
    diagram.innerHTML = '';
  }
  if (cards) cards.hidden = false;
  if (files) files.hidden = true;
  if (side) side.hidden = false;
  for (const button of [zoomInButton, zoomOutButton, zoomFitButton]) {
    if (button) button.disabled = true;
  }
  if (exportButton) exportButton.disabled = true;
}

function setFilesMode(): void {
  if (diagram) {
    diagram.hidden = true;
    diagram.innerHTML = '';
  }
  if (cards) cards.hidden = true;
  if (files) files.hidden = false;
  if (side) side.hidden = false;
  for (const button of [zoomInButton, zoomOutButton, zoomFitButton]) {
    if (button) button.disabled = true;
  }
  if (exportButton) exportButton.disabled = true;
}

function renderCards(): void {
  if (!cards) {
    return;
  }
  cards.innerHTML = items
    .filter((item): item is LevelGroupItem => item.kind === 'group')
    .map((item) => {
      const meta = item.routeCount > 0 && item.fileCount === 0
        ? `${item.routeCount} routes`
        : `${item.fileCount} files${item.routeCount > 0 ? ` · ${item.routeCount} routes` : ''}`;
      return `<button type="button" class="df-card" data-nav-path="${escapeHtml(item.path.join('/'))}">
        <span class="df-card-title">${escapeHtml(item.label)}</span>
        <span class="df-card-meta">${escapeHtml(meta)}</span>
      </button>`;
    })
    .join('');
}

function renderFiles(): void {
  if (!files) {
    return;
  }
  files.innerHTML = items
    .filter((item): item is LevelFileItem => item.kind === 'file')
    .map((item) => {
      const selected = item.id === selectedFileId ? ' df-selected' : '';
      const open = item.path
        ? `<button type="button" class="df-file-open" data-open-path="${escapeHtml(item.path)}">Open</button>`
        : '<span></span>';
      return `<div class="df-file-row${selected}" data-file-id="${escapeHtml(item.id)}">
        <span>
          <span class="df-file-name">${escapeHtml(item.label)}${item.route ? '<span class="df-badge">route</span>' : ''}</span>
          <span class="df-file-path">${escapeHtml(item.path ?? '')}</span>
        </span>
        <span class="df-file-counts">${item.inCount} in · ${item.outCount} out</span>
        ${open}
      </div>`;
    })
    .join('');
}

function linkRow(link: LevelLink): string {
  const meta = `${link.labels.join(', ')}${link.count > 1 ? ` · ${link.count}` : ''}`;
  if (link.system) {
    return `<div class="df-link-row df-system-link">
      <span>${escapeHtml(link.label)} (system)</span>
      <span class="df-link-meta">${escapeHtml(meta)}</span>
    </div>`;
  }
  if (link.path) {
    return `<button type="button" class="df-link-row" data-open-path="${escapeHtml(link.path)}">
      <span>${escapeHtml(link.label)}${link.route ? ' (route)' : ''}</span>
      <span class="df-link-meta">${escapeHtml(meta)}</span>
    </button>`;
  }
  if (link.groupPath) {
    return `<button type="button" class="df-link-row" data-nav-path="${escapeHtml(link.groupPath.join('/'))}">
      <span>${escapeHtml(link.label)}</span>
      <span class="df-link-meta">${escapeHtml(meta)}</span>
    </button>`;
  }
  return '';
}

function relatedRows(): string {
  return related
    .map((entry) => `<button type="button" class="df-related-row" data-nav-path="${escapeHtml(entry.path.join('/'))}">
      <span class="df-related-name">${escapeHtml(entry.label)}</span>
      <span class="df-related-parent">${escapeHtml(entry.path.slice(0, -1).join(' / '))}</span>
      <span class="df-related-count">${entry.count} ${entry.count === 1 ? 'link' : 'links'}</span>
    </button>`)
    .join('');
}

function systemRows(): string {
  return systemTargets
    .map((target) => `<div class="df-system-target">
      <div class="df-system-head">
        <span class="df-system-name">${escapeHtml(target.label)}</span>
        <span class="df-system-count">${target.count} ${target.count === 1 ? 'link' : 'links'}</span>
      </div>
      ${target.files.map((file) => `<button type="button" class="df-link-row" data-open-path="${escapeHtml(file.path)}">
        <span>${escapeHtml(file.label)}</span>
        <span class="df-link-meta">${escapeHtml(file.labels.join(', '))}</span>
      </button>`).join('')}
    </div>`)
    .join('');
}

function renderSide(): void {
  if (!side) {
    return;
  }
  if (levelKind === 'project') {
    side.hidden = true;
    side.innerHTML = '';
    return;
  }
  const selected = items.find(
    (item): item is LevelFileItem => item.kind === 'file' && item.id === selectedFileId,
  );
  const parts: string[] = [];
  if (selected) {
    parts.push(`<div class="df-side-head">
      <strong>${escapeHtml(selected.label)}</strong>
      <span class="df-side-path">${escapeHtml(selected.path ?? '')}</span>
      ${selected.path ? `<button type="button" class="df-action df-side-open" data-open-path="${escapeHtml(selected.path)}">Open file</button>` : ''}
    </div>`);
    parts.push(`<div class="df-side-section"><h3>Uses</h3>${
      selected.uses.length > 0
        ? selected.uses.map(linkRow).join('')
        : '<div class="df-side-empty">No outgoing relationships.</div>'
    }</div>`);
    parts.push(`<div class="df-side-section"><h3>Used by</h3>${
      selected.usedBy.length > 0
        ? selected.usedBy.map(linkRow).join('')
        : '<div class="df-side-empty">Nothing imports or calls this file.</div>'
    }</div>`);
  } else if (levelKind === 'files') {
    parts.push('<div class="df-side-empty">Select a file to see what it uses and what uses it.</div>');
  }
  if (related.length > 0) {
    parts.push(`<div class="df-side-section"><h3>Related groups</h3>${relatedRows()}</div>`);
  } else if (levelKind === 'layer') {
    parts.push('<div class="df-side-empty">No external relationships from this level.</div>');
  }
  if (systemTargets.length > 0) {
    parts.push(`<div class="df-side-section"><h3>System targets</h3>${systemRows()}</div>`);
  }
  side.innerHTML = parts.join('');
  side.hidden = false;
}

function applyTransform(): void {
  const svg = diagram?.querySelector('svg') as SVGSVGElement | null;
  if (svg) {
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translate(${viewX}px, ${viewY}px) scale(${viewScale})`;
  }
}

function fitDiagram(): void {
  if (!diagram) {
    return;
  }
  const svg = diagram.querySelector('svg') as SVGSVGElement | null;
  if (!svg) {
    return;
  }
  const base = svg.getBoundingClientRect();
  const container = diagram.getBoundingClientRect();
  const baseWidth = base.width / viewScale;
  const baseHeight = base.height / viewScale;
  if (baseWidth <= 0 || baseHeight <= 0 || container.width <= 0) {
    return;
  }
  // Fit only when the graph is already readable. For dense maps, keep a
  // minimum scale and let the user pan instead of reducing labels to pixels.
  viewScale = Math.max(MIN_READABLE_SCALE, Math.min(container.width / baseWidth, container.height / baseHeight, 1.25));
  viewX = Math.max(0, (container.width - baseWidth * viewScale) / 2);
  viewY = Math.max(0, (container.height - baseHeight * viewScale) / 2);
  applyTransform();
}

function zoomBy(factor: number, clientX?: number, clientY?: number): void {
  if (!diagram) {
    return;
  }
  const container = diagram.getBoundingClientRect();
  const centerX = (clientX ?? container.left + container.width / 2) - container.left;
  const centerY = (clientY ?? container.top + container.height / 2) - container.top;
  const next = Math.min(Math.max(viewScale * factor, 0.1), 4);
  const ratio = next / viewScale;
  viewX = centerX - (centerX - viewX) * ratio;
  viewY = centerY - (centerY - viewY) * ratio;
  viewScale = next;
  applyTransform();
}

async function renderMap(message: MapMessage): Promise<void> {
  paths = message.paths ?? {};
  groups = message.groups ?? {};
  crumbs = message.breadcrumbs ?? [];
  levelKind = message.kind ?? 'project';
  items = message.items ?? [];
  related = message.related ?? [];
  systemTargets = message.systemTargets ?? [];
  if (!items.some((item) => item.kind === 'file' && item.id === selectedFileId)) {
    selectedFileId = undefined;
  }
  currentPath = crumbs[crumbs.length - 1]?.path ?? [];
  hasMap = true;
  renderCrumbs();
  updateBackButton();
  progressLines = [];
  hideBanner();
  setRefreshing(false);
  const missing = message.coverage
    ? Math.max(0, message.coverage.excludedFiles ?? message.coverage.indexedFiles - message.coverage.representedFiles)
    : 0;
  const coverageNotes: string[] = [];
  if (message.coverage?.fingerprint) coverageNotes.push(message.coverage.fingerprint);
  if (missing > 0) coverageNotes.push(`${missing} test/support files excluded`);
  if (message.coverage && message.coverage.unsupportedSourceFiles > 0) {
    coverageNotes.push(`${message.coverage.unsupportedSourceFiles} unsupported`);
  }
  if (message.coverage && message.coverage.parseFailures > 0) {
    coverageNotes.push(`${message.coverage.parseFailures} parse failures`);
  }
  if (message.coverage?.scanLimitReached) coverageNotes.push('scan limit reached');
  if (levelKind === 'project' && (message.hiddenEdges ?? 0) > 0) {
    coverageNotes.push(`${message.hiddenEdges} of ${message.totalEdges ?? 0} relationships hidden`);
  }
  if ((message.coverage?.isolatedFiles ?? 0) > 0) {
    coverageNotes.push(`${message.coverage?.isolatedFiles} files with no links`);
  }
  if ((message.coverage?.unclassifiedFiles ?? 0) > 0) {
    coverageNotes.push(`${message.coverage?.unclassifiedFiles} files need placement`);
  }
  const coverageHint = coverageNotes.join(' · ');
  setHint(message.stale ? 'code changed — reload to update' : coverageHint);

  if (levelKind === 'project') {
    setGraphMode();
    if (!diagram) {
      return;
    }
    if (message.mermaid === lastMermaid) {
      setStatus('');
      return;
    }
    lastMermaid = message.mermaid;
    const token = ++renderToken;
    setStatus('Rendering…');
    ensureInit();
    try {
      const id = `df-architecture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { svg } = await mermaid.render(id, message.mermaid);
      if (token !== renderToken || !diagram) {
        return;
      }
      diagram.innerHTML = svg;
      wireNodes();
      viewScale = 1;
      viewX = 0;
      viewY = 0;
      applyTransform();
      requestAnimationFrame(() => fitDiagram());
      clearRenderingStatus();
    } catch {
      if (token !== renderToken || !diagram) {
        return;
      }
      diagram.innerHTML = `<pre class="df-fallback">${escapeHtml(message.mermaid)}</pre>`;
      setStatus('Diagram unavailable');
    }
    return;
  }

  lastMermaid = '';
  renderToken++;
  if (levelKind === 'layer') {
    setCardsMode();
    renderCards();
  } else {
    setFilesMode();
    renderFiles();
  }
  renderSide();
  setStatus('');
}

function renderEmpty(message: EmptyMessage): void {
  projectName = message.project ?? projectName;
  paths = {};
  hasMap = false;
  lastMermaid = '';
  progressLines = [];
  renderToken++;
  items = [];
  related = [];
  systemTargets = [];
  selectedFileId = undefined;
  levelKind = 'project';
  currentPath = [];
  backStack = [];
  updateBackButton();
  hideBanner();
  setRefreshing(false);
  setHint('');
  setStatus('');
  setStateMode();
  if (!diagram) {
    return;
  }
  const note =
    message.reason === 'no-facts'
      ? '<p class="df-state-note">Nothing indexed yet. Open or scan a source file, then retry.</p><button id="df-generate" class="df-action" type="button">Retry</button>'
      : '<p class="df-state-note">The verified map is ready to rebuild.</p><button id="df-generate" class="df-action" type="button">Retry</button>';
  diagram.innerHTML = `<div class="df-state"><h2>${escapeHtml(projectName)}</h2><p>Draw this codebase</p>${note}</div>`;
}

function renderGenerating(message: GeneratingMessage): void {
  projectName = message.project ?? projectName;
  hideBanner();
  setRefreshing(true);
  const line = message.progress.trim();
  if (line && progressLines[progressLines.length - 1] !== line) {
    progressLines.push(line);
    if (progressLines.length > 6) {
      progressLines.shift();
    }
  }
  if (message.hasMap && hasMap) {
    setStatus(line);
    return;
  }
  setStateMode();
  backStack = [];
  updateBackButton();
  if (!diagram) {
    return;
  }
  setStatus('');
  diagram.innerHTML = `<div class="df-state"><h2>${escapeHtml(projectName)}</h2><p class="df-state-note">Building the architecture map…</p><ul class="df-progress">${progressLines
    .map((entry) => `<li>${escapeHtml(entry)}</li>`)
    .join('')}</ul></div>`;
}

function renderError(message: ErrorMessage): void {
  setRefreshing(false);
  if (message.hasMap && hasMap) {
    setStatus('');
    showBanner(message.message);
    return;
  }
  hasMap = false;
  setHint('');
  setStatus('');
  setStateMode();
  backStack = [];
  updateBackButton();
  if (!diagram) {
    return;
  }
  diagram.innerHTML = `<div class="df-state"><h2>${escapeHtml(projectName)}</h2><p class="df-error">${escapeHtml(message.message)}</p><button id="df-retry" class="df-action" type="button">Retry</button></div>`;
  lastError = message;
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as IncomingMessage | undefined;
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'map') {
    void renderMap(message);
    return;
  }
  if (message.type === 'empty') {
    renderEmpty(message);
    return;
  }
  if (message.type === 'generating') {
    renderGenerating(message);
    return;
  }
  if (message.type === 'error') {
    renderError(message);
    return;
  }
});

diagram?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('#df-generate, #df-retry')) {
    post({ type: 'generate' });
    return;
  }
});

function navPathFrom(element: HTMLElement): string[] | undefined {
  const raw = element.closest<HTMLElement>('[data-nav-path]')?.getAttribute('data-nav-path');
  if (raw === null || raw === undefined) {
    return undefined;
  }
  return raw ? raw.split('/') : [];
}

backButton?.addEventListener('click', goBack);

cards?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const path = target ? navPathFrom(target) : undefined;
  if (path) {
    goTo(path);
  }
});

files?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const open = target?.closest<HTMLElement>('[data-open-path]');
  if (open) {
    const path = open.getAttribute('data-open-path');
    if (path) post({ type: 'openPath', path });
    return;
  }
  const row = target?.closest<HTMLElement>('[data-file-id]');
  if (!row) {
    return;
  }
  selectedFileId = row.getAttribute('data-file-id') ?? undefined;
  files?.querySelectorAll<HTMLElement>('.df-file-row').forEach((element) => {
    element.classList.toggle('df-selected', element === row);
  });
  renderSide();
});

side?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }
  const open = target.closest<HTMLElement>('[data-open-path]');
  if (open) {
    const path = open.getAttribute('data-open-path');
    if (path) post({ type: 'openPath', path });
    return;
  }
  const path = navPathFrom(target);
  if (path) {
    goTo(path);
  }
});

banner?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('#df-retry')) {
    hideBanner();
    post({ type: 'reload' });
  }
});

if (refreshButton) {
  refreshButton.addEventListener('click', () => {
    hideBanner();
    setRefreshing(true);
    backStack = [];
    updateBackButton();
    post({ type: 'reload' });
  });
}

if (exportButton) {
  exportButton.addEventListener('click', () => {
    const svg = diagram?.querySelector('svg');
    if (!svg) {
      setStatus('Nothing to export', 3000);
      return;
    }
    const markup = new XMLSerializer().serializeToString(svg);
    post({ type: 'exportDiagram', svg: markup });
  });
}

document.getElementById('df-zoom-in')?.addEventListener('click', () => zoomBy(1.2));
document.getElementById('df-zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.2));
document.getElementById('df-zoom-fit')?.addEventListener('click', () => fitDiagram());

document.getElementById('df-map-crumbs')?.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement | null)?.closest('button');
  if (!button) {
    return;
  }
  const index = Number(button.getAttribute('data-index'));
  const crumb = crumbs[index];
  if (crumb) {
    goTo(crumb.path);
  }
});

diagram?.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 0.9, event.clientX, event.clientY);
  },
  { passive: false },
);

let dragging = false;
let dragX = 0;
let dragY = 0;
diagram?.addEventListener('pointerdown', (event) => {
  if ((event.target as HTMLElement | null)?.closest('g.node')) {
    return;
  }
  dragging = true;
  dragX = event.clientX;
  dragY = event.clientY;
});
window.addEventListener('pointermove', (event) => {
  if (!dragging) {
    return;
  }
  viewX += event.clientX - dragX;
  viewY += event.clientY - dragY;
  dragX = event.clientX;
  dragY = event.clientY;
  applyTransform();
});
window.addEventListener('pointerup', () => {
  dragging = false;
});

post({ type: 'ready' });
