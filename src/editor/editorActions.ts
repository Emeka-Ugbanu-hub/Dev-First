import * as vscode from 'vscode';
import { SessionController } from '../session/SessionController';
import {
  contextPrompt,
  DiagnosticInfo,
  diagnosticFixPrompt,
  selectionPrompt,
  SelectionAction,
  terminalExplainPrompt,
  terminalFixPrompt,
  terminalPrompt,
} from './prompts';

const MAX_FILE_CHARS = 20000;

function editorRef(document: vscode.TextDocument, range: vscode.Range): string {
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const start = range.start.line + 1;
  const end = range.end.line + 1;
  return start === end ? `${relative}:${start}` : `${relative}:${start}-${end}`;
}

const SEVERITY_NAMES: Record<number, string> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

function diagnosticsInRange(document: vscode.TextDocument, range: vscode.Range): DiagnosticInfo[] {
  return vscode.languages
    .getDiagnostics(document.uri)
    .filter(
      (diagnostic) =>
        diagnostic.range.end.isAfterOrEqual(range.start) && diagnostic.range.start.isBeforeOrEqual(range.end),
    )
    .map((diagnostic) => ({
      message: diagnostic.message,
      severity: SEVERITY_NAMES[diagnostic.severity] ?? 'info',
      startLine: diagnostic.range.start.line + 1,
      endLine: diagnostic.range.end.line + 1,
    }));
}

export function registerEditorIntegration(session: SessionController): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      {
        provideCodeActions(document, range) {
          if (range.isEmpty) {
            return [];
          }
          const actions: vscode.CodeAction[] = [];
          if (diagnosticsInRange(document, range).length > 0) {
            const diagnosticAction = new vscode.CodeAction(
              'Dev-First: Fix (diagnostic)',
              vscode.CodeActionKind.QuickFix,
            );
            diagnosticAction.isPreferred = true;
            diagnosticAction.command = {
              command: 'devFirst.fixDiagnostics',
              title: 'Fix (diagnostic)',
              arguments: [document.uri, range],
            };
            actions.push(diagnosticAction);
          }
          const entries: Array<{ action: SelectionAction; title: string; command: string }> = [
            { action: 'explain', title: 'Explain', command: 'devFirst.explainSelection' },
            { action: 'fix', title: 'Fix', command: 'devFirst.fixSelection' },
            { action: 'improve', title: 'Improve', command: 'devFirst.improveSelection' },
          ];
          actions.push(
            ...entries.map((entry) => {
              const codeAction = new vscode.CodeAction(
                `Dev-First: ${entry.title}`,
                vscode.CodeActionKind.Refactor,
              );
              codeAction.command = {
                command: entry.command,
                title: entry.title,
                arguments: [document.uri, range],
              };
              return codeAction;
            }),
          );
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.Refactor, vscode.CodeActionKind.QuickFix] },
    ),
  );

  async function withSelection(
    uri: vscode.Uri | undefined,
    range: vscode.Range | undefined,
    run: (document: vscode.TextDocument, target: vscode.Range) => Promise<void>,
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    const target = range ?? editor?.selection;
    if (!document || !target || target.isEmpty) {
      void vscode.window.showInformationMessage('Dev-First: select some code first.');
      return;
    }
    await run(document, target);
  }

  async function terminalSelection(): Promise<string | undefined> {
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const output = (await vscode.env.clipboard.readText()).trim();
    if (!output) {
      void vscode.window.showInformationMessage('Dev-First: select some terminal output first.');
      return undefined;
    }
    return output;
  }

  function selectionCommand(action: SelectionAction) {
    return (uri?: vscode.Uri, range?: vscode.Range) =>
      withSelection(uri, range, async (document, target) => {
        const prompt = selectionPrompt(
          action,
          editorRef(document, target),
          document.languageId,
          document.getText(target),
        );
        await vscode.commands.executeCommand('devFirst.chatView.focus');
        session.sendFromEditor(prompt);
      });
  }

  disposables.push(
    vscode.commands.registerCommand('devFirst.explainSelection', selectionCommand('explain')),
    vscode.commands.registerCommand('devFirst.fixSelection', selectionCommand('fix')),
    vscode.commands.registerCommand('devFirst.improveSelection', selectionCommand('improve')),
    vscode.commands.registerCommand('devFirst.fixDiagnostics', (uri?: vscode.Uri, range?: vscode.Range) =>
      withSelection(uri, range, async (document, target) => {
        const diagnostics = diagnosticsInRange(document, target);
        if (diagnostics.length === 0) {
          void vscode.window.showInformationMessage('Dev-First: no diagnostics in the selection.');
          return;
        }
        await vscode.commands.executeCommand('devFirst.chatView.focus');
        session.sendFromEditor(
          diagnosticFixPrompt(
            editorRef(document, target),
            document.languageId,
            document.getText(target),
            diagnostics,
          ),
        );
      }),
    ),
    vscode.commands.registerCommand('devFirst.addSelectionToChat', (uri?: vscode.Uri, range?: vscode.Range) =>
      withSelection(uri, range, async (document, target) => {
        const ref = editorRef(document, target);
        await vscode.commands.executeCommand('devFirst.chatView.focus');
        session.prefillInput(contextPrompt(ref, document.languageId, document.getText(target)));
      }),
    ),
    vscode.commands.registerCommand('devFirst.addFileToChat', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      const document = await vscode.workspace.openTextDocument(target);
      const ref = vscode.workspace.asRelativePath(document.uri, false);
      const code = document.getText().slice(0, MAX_FILE_CHARS);
      await vscode.commands.executeCommand('devFirst.chatView.focus');
      session.prefillInput(contextPrompt(ref, document.languageId, code));
    }),
    vscode.commands.registerCommand('devFirst.addTerminalToChat', async () => {
      const output = await terminalSelection();
      if (!output) {
        return;
      }
      await vscode.commands.executeCommand('devFirst.chatView.focus');
      session.prefillInput(terminalPrompt(output));
    }),
    vscode.commands.registerCommand('devFirst.explainTerminalCommand', async () => {
      const output = await terminalSelection();
      if (!output) {
        return;
      }
      await vscode.commands.executeCommand('devFirst.chatView.focus');
      session.prefillInput(terminalExplainPrompt(output));
    }),
    vscode.commands.registerCommand('devFirst.fixTerminalCommand', async () => {
      const output = await terminalSelection();
      if (!output) {
        return;
      }
      await vscode.commands.executeCommand('devFirst.chatView.focus');
      session.prefillInput(terminalFixPrompt(output));
    }),
  );

  return disposables;
}
