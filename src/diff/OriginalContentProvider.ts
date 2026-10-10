import * as vscode from 'vscode';
import * as path from 'path';
import { DiffManager } from './DiffManager';
import { CheckpointManager } from '../checkpoints/CheckpointManager';
import { workspaceRoot } from '../config';

export const ORIGINAL_SCHEME = 'dev-first-original';

export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly diffManager: DiffManager) {}

  provideTextDocumentContent(uri: vscode.Uri): string | Promise<string> {
    const relative = decodeURIComponent(uri.path.replace(/^\//, ''));
    const params = new URLSearchParams(uri.query ?? '');
    if (params.get('empty') === '1') {
      return '';
    }
    const runId = params.get('runId');
    if (runId) {
      return this.diffManager.getRunOriginal(runId, relative) ?? '';
    }
    const checkpointId = params.get('checkpoint');
    if (checkpointId) {
      return this.checkpointContent(checkpointId, relative);
    }
    return this.diffManager.getOriginalContent(relative) ?? '';
  }

  private async checkpointContent(checkpointId: string, relative: string): Promise<string> {
    const root = workspaceRoot() ?? process.cwd();
    const checkpoints = new CheckpointManager(root, path.join(root, '.dev-first', 'checkpoints'));
    return (await checkpoints.originalContent(checkpointId, relative)) ?? '';
  }

  static uriFor(relativePath: string, runId?: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: ORIGINAL_SCHEME,
      path: `/${encodeURIComponent(relativePath)}`,
      ...(runId ? { query: `runId=${encodeURIComponent(runId)}` } : {}),
    });
  }

  static checkpointUriFor(relativePath: string, checkpointId: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: ORIGINAL_SCHEME,
      path: `/${encodeURIComponent(relativePath)}`,
      query: `checkpoint=${encodeURIComponent(checkpointId)}`,
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
