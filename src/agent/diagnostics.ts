import * as vscode from 'vscode';

const MAX_PER_FILE = 20;
const MAX_TOTAL = 40;
const SETTLE_MS = 1500;
const POLL_MS = 200;

export interface FileDiagnostic {
  path: string;
  absolute: string;
  line: number;
  character: number;
  severity: 'error' | 'warning';
  source?: string;
  message: string;
}

export async function collectFileDiagnostics(paths: string[]): Promise<FileDiagnostic[]> {
  if (paths.length === 0) {
    return [];
  }
  const unique = [...new Set(paths)];

  for (const filePath of unique) {
    try {
      await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch {
      // file may be deleted or unreadable — ignore
    }
  }

  const start = Date.now();
  let last = '';
  let current = diagnosticsLines(unique);
  while (Date.now() - start < SETTLE_MS) {
    await delay(POLL_MS);
    current = diagnosticsLines(unique);
    if (current.join('\n') === last) {
      break;
    }
    last = current.join('\n');
  }
  return current;
}

export function diagnosticLines(items: FileDiagnostic[]): string[] {
  const lines: string[] = [];
  let total = 0;
  const perFile = new Map<string, number>();
  for (const diagnostic of items) {
    if (total >= MAX_TOTAL) {
      break;
    }
    const shown = perFile.get(diagnostic.path) ?? 0;
    if (shown >= MAX_PER_FILE) {
      continue;
    }
    perFile.set(diagnostic.path, shown + 1);
    const severity = `[${diagnostic.severity}]`;
    const source = diagnostic.source ? ` (${diagnostic.source})` : '';
    lines.push(
      `${diagnostic.path}:${diagnostic.line}:${diagnostic.character} ${severity}${source} ${diagnostic.message}`,
    );
    total++;
  }
  return lines;
}

export async function collectDiagnostics(paths: string[]): Promise<string> {
  return formatDiagnostics(await collectFileDiagnostics(paths));
}

export function formatDiagnostics(items: FileDiagnostic[]): string {
  const lines: string[] = [];
  const grouped = new Map<string, FileDiagnostic[]>();
  for (const diagnostic of items) {
    const list = grouped.get(diagnostic.path);
    if (list) {
      list.push(diagnostic);
    } else {
      grouped.set(diagnostic.path, [diagnostic]);
    }
  }
  let total = 0;
  for (const [filePath, list] of grouped) {
    if (total >= MAX_TOTAL) {
      break;
    }
    const shown = list.slice(0, MAX_PER_FILE);
    for (const diagnostic of shown) {
      if (total >= MAX_TOTAL) {
        break;
      }
      const severity = `[${diagnostic.severity}]`;
      const source = diagnostic.source ? ` (${diagnostic.source})` : '';
      lines.push(`${filePath}:${diagnostic.line}:${diagnostic.character} ${severity}${source} ${diagnostic.message}`);
      total++;
    }
    const hidden = list.length - shown.length;
    if (hidden > 0) {
      lines.push(`${filePath}: ... ${hidden} more diagnostic${hidden === 1 ? '' : 's'}`);
    }
  }
  return lines.join('\n');
}

export function diagnosticsSection(diagnostics: string): string {
  if (!diagnostics.trim()) {
    return '';
  }
  return `\n\nDiagnostics for the files you touched:\n${diagnostics}`;
}

function diagnosticsLines(paths: string[]): FileDiagnostic[] {
  const items: FileDiagnostic[] = [];
  for (const filePath of paths) {
    let diagnostics: vscode.Diagnostic[];
    try {
      diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(filePath));
    } catch {
      continue;
    }
    const relative = relativePath(filePath);
    for (const diagnostic of diagnostics) {
      if (
        diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
        diagnostic.severity !== vscode.DiagnosticSeverity.Warning
      ) {
        continue;
      }
      items.push({
        path: relative,
        absolute: filePath,
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
        severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        ...(diagnostic.source ? { source: diagnostic.source } : {}),
        message: diagnostic.message.split('\n')[0].slice(0, 300),
      });
    }
  }
  return items;
}

function relativePath(filePath: string): string {
  try {
    return vscode.workspace.asRelativePath(filePath);
  } catch {
    return filePath;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
