import * as vscode from 'vscode';

const MAX_PER_FILE = 20;
const MAX_TOTAL = 40;
const SETTLE_MS = 1500;
const POLL_MS = 200;

export async function collectDiagnostics(paths: string[]): Promise<string> {
  if (paths.length === 0) {
    return '';
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
  let current = formatDiagnostics(unique);
  while (Date.now() - start < SETTLE_MS) {
    await delay(POLL_MS);
    current = formatDiagnostics(unique);
    if (current === last) {
      break;
    }
    last = current;
  }
  return current;
}

export function diagnosticsSection(diagnostics: string): string {
  if (!diagnostics.trim()) {
    return '';
  }
  return `\n\nDiagnostics for the files you touched:\n${diagnostics}`;
}

function formatDiagnostics(paths: string[]): string {
  const lines: string[] = [];
  let total = 0;

  for (const filePath of paths) {
    if (total >= MAX_TOTAL) {
      break;
    }
    let diagnostics: vscode.Diagnostic[];
    try {
      diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(filePath));
    } catch {
      continue;
    }
    const relevant = diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === vscode.DiagnosticSeverity.Error ||
        diagnostic.severity === vscode.DiagnosticSeverity.Warning,
    );
    if (relevant.length === 0) {
      continue;
    }
    const relative = vscode.workspace.asRelativePath(filePath);
    const shown = relevant.slice(0, MAX_PER_FILE);
    for (const diagnostic of shown) {
      if (total >= MAX_TOTAL) {
        break;
      }
      const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      const source = diagnostic.source ? ` (${diagnostic.source})` : '';
      const message = diagnostic.message.split('\n')[0].slice(0, 300);
      lines.push(
        `${relative}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} [${severity}]${source} ${message}`,
      );
      total++;
    }
    const hidden = relevant.length - shown.length;
    if (hidden > 0) {
      lines.push(`${relative}: ... ${hidden} more diagnostic${hidden === 1 ? '' : 's'}`);
    }
  }

  return lines.join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
