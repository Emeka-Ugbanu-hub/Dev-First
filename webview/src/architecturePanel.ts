import mermaid from 'mermaid';

interface MapMessage {
  type: 'map';
  mermaid: string;
  paths: Record<string, string>;
  groups?: Record<string, string[]>;
  breadcrumbs?: Array<{ label: string; path: string[] }>;
  stale: boolean;
  generatedAt: number;
  model: string;
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

type IncomingMessage = MapMessage | EmptyMessage | GeneratingMessage | ErrorMessage | { type: 'raw'; text?: string };

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

const refreshButton = document.getElementById('df-refresh') as HTMLButtonElement | null;
const exportButton = document.getElementById('df-export') as HTMLButtonElement | null;
const refreshIcon = document.getElementById('df-refresh-icon');
const hint = document.getElementById('df-hint');
const status = document.getElementById('df-status');
const banner = document.getElementById('df-banner');
const diagram = document.getElementById('df-diagram');

let paths: Record<string, string> = {};
let hasMap = false;
let lastError: ErrorMessage | undefined;
let groups: Record<string, string[]> = {};
let crumbs: Array<{ label: string; path: string[] }> = [];
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
      nodeSpacing: 70,
      rankSpacing: 90,
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

function wireNodes(): void {
  if (!diagram) {
    return;
  }
  diagram.querySelectorAll<SVGGElement>('g.node').forEach((element) => {
    const id = nodeIdFor(element);
    const group = id ? groups[id] : undefined;
    if (group) {
      element.classList.add('df-clickable');
      element.addEventListener('click', () => post({ type: 'drillDown', id }));
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
  viewScale = Math.max(0.1, Math.min(container.width / baseWidth, container.height / baseHeight, 1.25));
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
  hasMap = true;
  renderCrumbs();
  progressLines = [];
  hideBanner();
  setRefreshing(false);
  setHint(message.stale ? 'code changed — reload to update' : '');
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
}

function renderEmpty(message: EmptyMessage): void {
  projectName = message.project ?? projectName;
  paths = {};
  hasMap = false;
  lastMermaid = '';
  progressLines = [];
  renderToken++;
  hideBanner();
  setRefreshing(false);
  setHint('');
  setStatus('');
  if (!diagram) {
    return;
  }
  const note =
    message.reason === 'no-model'
      ? '<p class="df-state-note">Connect a model to draw the architecture</p>'
      : message.reason === 'no-facts'
        ? '<p class="df-state-note">Nothing indexed yet. Open or scan a source file, then try again.</p><button id="df-generate" class="df-action" type="button">Generate</button>'
        : '<button id="df-generate" class="df-action" type="button">Generate</button>';
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
  if (message.hasMap && hasMap && diagram?.querySelector('svg')) {
    setStatus(line);
    return;
  }
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
  if (message.hasMap && hasMap && diagram?.querySelector('svg')) {
    setStatus('');
    showBanner(message.message);
    return;
  }
  hasMap = false;
  setHint('');
  setStatus('');
  if (!diagram) {
    return;
  }
  diagram.innerHTML = `<div class="df-state"><h2>${escapeHtml(projectName)}</h2><p class="df-error">${escapeHtml(message.message)}</p><button id="df-retry" class="df-action" type="button">Retry</button> <button id="df-raw" class="df-action" type="button">Show raw output</button></div>`;
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
  if (message.type === 'raw') {
    if (diagram) {
      diagram.innerHTML = `<div class="df-state"><h2>${escapeHtml(projectName)}</h2><p class="df-state-note">Raw model output</p><pre class="df-raw">${escapeHtml(message.text || 'No raw output available.')}</pre><button id="df-raw-back" class="df-action" type="button">Back</button></div>`;
    }
  }
});

diagram?.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('#df-generate, #df-retry')) {
    post({ type: 'generate' });
    return;
  }
  if (target?.closest('#df-raw')) {
    post({ type: 'showRaw' });
    return;
  }
  if (target?.closest('#df-raw-back')) {
    if (lastError) {
      renderError(lastError);
    }
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
    post({ type: 'up', crumbs: crumb.path });
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
