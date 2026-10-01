import * as vscode from 'vscode';
import { DiffManager } from './DiffManager';

export const ORIGINAL_SCHEME = 'dev-first-original';

export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly diffManager: DiffManager) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const relative = decodeURIComponent(uri.path.replace(/^\//, ''));
    const params = new URLSearchParams(uri.query ?? '');
    if (params.get('empty') === '1') {
      return '';
    }
    const runId = params.get('runId');
    if (runId) {
      return this.diffManager.getRunOriginal(runId, relative) ?? '';
    }
    return this.diffManager.getOriginalContent(relative) ?? '';
  }

  static uriFor(relativePath: string, runId?: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: ORIGINAL_SCHEME,
      path: `/${encodeURIComponent(relativePath)}`,
      ...(runId ? { query: `runId=${encodeURIComponent(runId)}` } : {}),
    });
  }

  static emptyUri(relativePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: ORIGINAL_SCHEME,
      path: `/${encodeURIComponent(relativePath)}`,
      query: 'empty=1',
    });
  }
}
