import * as vscode from 'vscode';
import { DiffManager } from './DiffManager';

export class DiffCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeEmitter.event;

  constructor(private readonly diffManager: DiffManager) {}

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const filePath = vscode.workspace.asRelativePath(document.uri);
    const pending = this.diffManager.getPendingChanges(filePath);
    if (pending.length === 0) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    for (const change of pending) {
      const line = Math.max(0, Math.min(change.startLine, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const kind =
        change.fileDeleted
          ? ' (file deleted)'
          : change.changeType === 'insert'
            ? ' (addition)'
            : change.changeType === 'delete'
              ? ' (deletion)'
              : ' (modification)';
      lenses.push(
        new vscode.CodeLens(range, {
          title: `✓ Accept${kind}`,
          command: 'devFirst.acceptChange',
          arguments: [change.id],
        }),
        new vscode.CodeLens(range, {
          title: `✗ Reject${kind}`,
          command: 'devFirst.rejectChange',
          arguments: [change.id],
        }),
      );
    }
    return lenses;
  }

  refresh(): void {
    this.onDidChangeEmitter.fire();
  }
}
