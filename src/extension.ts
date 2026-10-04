import * as vscode from 'vscode';
import { DiffManager } from './diff/DiffManager';
import { DiffCodeLensProvider } from './diff/DiffCodeLensProvider';
import { ORIGINAL_SCHEME, OriginalContentProvider } from './diff/OriginalContentProvider';
import { FimCompletionProvider } from './autocomplete/CompletionProvider';
import { SessionController } from './session/SessionController';
import { AttentionService } from './attention/AttentionService';
import { Phase } from './shared/protocol';
import { registerEditorIntegration } from './editor/editorActions';
import {
  commitMessagePrompt,
  parseTerminalCommandResponse,
  terminalCommandPrompt,
} from './editor/prompts';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { getConfig, promptForApiKey, workspaceRoot } from './config';
import { activeProvider } from './llm/activeProvider';
import { PRESETS, findPreset } from './llm/presets';
import { WorktreeManager } from './worktree/WorktreeManager';
import { worktreeMergeConflictPrompt } from './worktree/prompts';
import { ScanRunner } from './scan/scanner';
import { createHoverProvider } from './scan/hover';
import { ArchitecturePanel } from './architecture/panel';
import {
  RECOMMENDED_SERVERS,
  addServer,
  mcpConfigPath,
  mergeRecommended,
  npxAvailable,
  readMcpConfig,
  writeMcpConfig,
} from './mcp/mcpSetup';

export function activate(context: vscode.ExtensionContext): void {
  const diffManager = DiffManager.getInstance();
  const codeLensProvider = new DiffCodeLensProvider(diffManager);
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    diffManager.onDidChangePendingChanges(() => codeLensProvider.refresh()),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, new OriginalContentProvider(diffManager)),
  );

  const completionProvider = new FimCompletionProvider(context);
  let completionRegistration: vscode.Disposable | undefined;
  const syncAutocomplete = () => {
    const enabled = getConfig().autocomplete;
    if (enabled && !completionRegistration) {
      completionRegistration = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' },
        completionProvider,
      );
    } else if (!enabled && completionRegistration) {
      completionRegistration.dispose();
      completionRegistration = undefined;
    }
  };
  syncAutocomplete();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('devFirst.autocomplete')) {
        syncAutocomplete();
      }
    }),
    { dispose: () => completionRegistration?.dispose() },
  );

  let provider: ChatViewProvider;
  const session = new SessionController(context, (message) => provider.post(message), diffManager);
  provider = new ChatViewProvider(context.extensionUri, session);
  const attention = new AttentionService(context);

  let architectureAvailable: boolean | undefined;
  const syncArchitectureAvailability = (connected: boolean): void => {
    if (connected === architectureAvailable) {
      return;
    }
    architectureAvailable = connected;
    void vscode.commands.executeCommand(
      'setContext',
      'devFirst.architectureAvailable',
      connected,
    );
  };
  session.setConnectionListener(syncArchitectureAvailability);
  syncArchitectureAvailability(false);
  void activeProvider(context)
    .then((active) => syncArchitectureAvailability(Boolean(active)))
    .catch(() => syncArchitectureAvailability(false));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(...registerEditorIntegration(session));

  async function generateText(prompt: string, maxTokens: number): Promise<string | undefined> {
    const active = await activeProvider(context);
    if (!active) {
      void vscode.window.showWarningMessage('Connect a provider first — Settings → Provider.');
      return undefined;
    }
    let text = '';
    for await (const event of active.provider.chat([{ role: 'user', content: prompt }], {
      model: active.model,
      maxTokens,
      temperature: 0.2,
    })) {
      if (event.type === 'text') {
        text += event.text;
      }
    }
    return text.trim();
  }

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.text = '$(sparkle) Dev-First';
  statusItem.tooltip = 'Open Dev-First';
  statusItem.command = 'devFirst.openChat';
  statusItem.show();
  context.subscriptions.push(statusItem);

  let previousPhase: Phase = 'idle';
  let runHadError = false;
  session.setPhaseListener((phase) => {
    attention.setPhase(phase);
    if (phase === 'planning' || phase === 'executing') {
      runHadError = false;
    } else if (previousPhase === 'executing' && !runHadError) {
      attention.complete();
    }
    previousPhase = phase;
    statusItem.text =
      phase === 'planning'
        ? '$(sync~spin) Dev-First: planning…'
        : phase === 'executing'
          ? '$(sync~spin) Dev-First: working…'
          : phase === 'review'
            ? '$(diff) Dev-First: review changes'
            : '$(sparkle) Dev-First';
    provider.setDescription(
      phase === 'planning'
        ? 'Planning'
        : phase === 'executing'
          ? 'Working'
          : phase === 'review'
            ? 'Review changes'
            : '',
    );
  });

  session.setErrorListener((message) => {
    runHadError = true;
    attention.error(message);
  });

  session.setNeedsInputListener((message) => {
    attention.needsInput(message);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('devFirst.exportTranscript', () => {
      void session.exportTranscript();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('devFirst.openChat', () => {
      void vscode.commands.executeCommand('devFirst.chatView.focus');
    }),
    vscode.commands.registerCommand('devFirst.newSession', () => {
      session.newSession();
    }),
    vscode.commands.registerCommand('devFirst.setApiKey', async () => {
      const config = getConfig();
      const current = findPreset(config.preset);
      const picked = await vscode.window.showQuickPick(
        PRESETS.map((preset) => ({
          label: preset.label,
          description: preset.description,
          preset,
        })),
        { placeHolder: `Select a provider (current: ${current?.label ?? config.preset})` },
      );
      if (!picked) {
        return;
      }
      await promptForApiKey(context, picked.preset);
      await session.refreshConnectionState();
    }),
    vscode.commands.registerCommand('devFirst.pickModel', async () => {
      const active = await activeProvider(context);
      if (!active) {
        void vscode.window.showWarningMessage('Dev-First: connect a provider first.');
        return;
      }
      let models: string[] = [];
      try {
        models = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Dev-First: fetching models…' },
          () => active.provider.listModels(),
        );
      } catch {
        models = [];
      }
      if (models.length > 0) {
        const picked = await vscode.window.showQuickPick(models, {
          placeHolder: `Model (current: ${active.model})`,
        });
        if (!picked) {
          return;
        }
        await session.setModel(picked);
        return;
      }
      const picked = await vscode.window.showInputBox({
        prompt: `Could not fetch models. Enter a model id (current: ${active.model})`,
        value: active.model,
        ignoreFocusOut: true,
      });
      if (picked === undefined) {
        return;
      }
      await session.setModel(picked.trim());
    }),
    vscode.commands.registerCommand('devFirst.acceptChange', (changeId: string) => {
      diffManager.acceptChange(changeId);
    }),
    vscode.commands.registerCommand('devFirst.rejectChange', async (changeId: string) => {
      await diffManager.rejectChange(changeId);
    }),
    vscode.commands.registerCommand('devFirst.acceptAllChanges', () => {
      diffManager.acceptAllChanges();
    }),
    vscode.commands.registerCommand('devFirst.rejectAllChanges', async () => {
      await diffManager.rejectAllChanges();
    }),
    vscode.commands.registerCommand('devFirst.buildIndex', async () => {
      await session.buildSemanticIndex();
    }),
    vscode.commands.registerCommand('devFirst.clearIndex', async () => {
      await session.clearSemanticIndex();
    }),
    vscode.commands.registerCommand('devFirst.mcpStatus', async () => {
      await session.showMcpStatus();
    }),
    vscode.commands.registerCommand('devFirst.setupMcp', async () => {
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage('Dev-First: open a folder first.');
        return;
      }
      if (!npxAvailable()) {
        void vscode.window.showWarningMessage(
          'Dev-First: the recommended MCP servers run through npx — install Node.js first.',
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        RECOMMENDED_SERVERS.map((server) => ({
          label: server.name,
          description: server.description,
          picked: true,
        })),
        { canPickMany: true, placeHolder: 'Select MCP servers to add to .dev-first/mcp.json' },
      );
      if (!picked || picked.length === 0) {
        return;
      }
      const filePath = mcpConfigPath(root);
      const config = await readMcpConfig(filePath);
      const { added } = mergeRecommended(
        config,
        root,
        picked.map((item) => item.label),
      );
      await writeMcpConfig(filePath, config);
      await session.reloadMcp();
      void vscode.window.showInformationMessage(
        added.length > 0
          ? `Dev-First: added MCP servers: ${added.join(', ')}.`
          : 'Dev-First: all selected MCP servers were already configured.',
      );
    }),
    vscode.commands.registerCommand('devFirst.addMcpServer', async () => {
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage('Dev-First: open a folder first.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [
          ...RECOMMENDED_SERVERS.map((server) => ({ label: server.name, description: server.description })),
          { label: 'custom', description: 'Enter a command manually' },
        ],
        { placeHolder: 'MCP server to add' },
      );
      if (!picked) {
        return;
      }
      const filePath = mcpConfigPath(root);
      const config = await readMcpConfig(filePath);

      if (picked.label === 'custom') {
        const command = await vscode.window.showInputBox({
          prompt: 'Command that starts the MCP server',
          placeHolder: 'npx',
          ignoreFocusOut: true,
        });
        if (!command) {
          return;
        }
        const argsRaw = await vscode.window.showInputBox({
          prompt: 'Arguments (space separated, optional)',
          ignoreFocusOut: true,
        });
        const name = await vscode.window.showInputBox({
          prompt: 'Server name',
          placeHolder: 'my-server',
          ignoreFocusOut: true,
        });
        if (!name) {
          return;
        }
        addServer(config, name.trim(), {
          command: command.trim(),
          args: argsRaw?.trim() ? argsRaw.trim().split(/\s+/) : [],
        });
      } else {
        const server = RECOMMENDED_SERVERS.find((candidate) => candidate.name === picked.label);
        if (!server) {
          return;
        }
        config.mcpServers[server.name] = server.entry(root);
      }

      await writeMcpConfig(filePath, config);
      await session.reloadMcp();
      void vscode.window.showInformationMessage('Dev-First: MCP configuration updated.');
    }),
    vscode.commands.registerCommand('devFirst.newWorktree', async () => {
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage('Dev-First: open a folder first.');
        return;
      }
      const manager = new WorktreeManager(root);
      if (!(await manager.isGitRepo())) {
        void vscode.window.showWarningMessage('Dev-First: worktrees require a git repository.');
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Worktree name (a branch dev-first/<name> will be created)',
        placeHolder: 'feature-x',
        ignoreFocusOut: true,
      });
      if (!name) {
        return;
      }
      try {
        const worktree = await manager.create(name);
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(worktree.path),
          { forceNewWindow: true },
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Dev-First: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
    vscode.commands.registerCommand('devFirst.mergeWorktree', async () => {
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage('Dev-First: open a folder first.');
        return;
      }
      const manager = new WorktreeManager(root);
      if (!(await manager.isGitRepo())) {
        void vscode.window.showWarningMessage('Dev-First: worktrees require a git repository.');
        return;
      }
      const current = await manager.currentBranch().catch(() => '');
      const worktrees = await manager.list();
      const candidates = worktrees.filter(
        (worktree) => worktree.path !== root && worktree.branch && worktree.branch !== current,
      );
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage('Dev-First: no worktree branches to merge.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        candidates.map((worktree) => ({
          label: worktree.branch,
          description: worktree.path,
          worktree,
        })),
        { placeHolder: `Merge a worktree branch into ${current || 'the current branch'}` },
      );
      if (!picked) {
        return;
      }
      try {
        const result = await manager.merge(picked.worktree.branch);
        if (result.status === 'conflict') {
          await vscode.commands.executeCommand('devFirst.chatView.focus');
          session.sendFromEditor(
            worktreeMergeConflictPrompt(picked.worktree.branch, current || 'the current branch', result.conflicts),
          );
          return;
        }
        void vscode.window.showInformationMessage(
          `Dev-First: merged ${picked.worktree.branch} into ${current || 'the current branch'}.`,
        );
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Dev-First: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
    vscode.commands.registerCommand('devFirst.removeWorktree', async () => {
      const root = workspaceRoot();
      if (!root) {
        return;
      }
      const manager = new WorktreeManager(root);
      const worktrees = await manager.list();
      const removable = worktrees.filter((worktree) => worktree.path !== root);
      if (removable.length === 0) {
        void vscode.window.showInformationMessage('Dev-First: no extra worktrees to remove.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        removable.map((worktree) => ({
          label: worktree.branch || worktree.path,
          description: worktree.path,
          worktree,
        })),
        { placeHolder: 'Select a worktree to remove' },
      );
      if (!picked) {
        return;
      }
      try {
        const message = await manager.remove(picked.worktree.path);
        void vscode.window.showInformationMessage(`Dev-First: ${message}`);
        if (picked.worktree.branch) {
          const confirmed = await vscode.window.showWarningMessage(
            `Dev-First: delete branch ${picked.worktree.branch} too?`,
            { modal: true },
            'Delete Branch',
          );
          if (confirmed === 'Delete Branch') {
            const deleted = await manager.deleteBranch(picked.worktree.branch);
            void vscode.window.showInformationMessage(`Dev-First: ${deleted}`);
          }
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Dev-First: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
    vscode.commands.registerCommand('devFirst.generateCommitMessage', async () => {
      const gitExports = vscode.extensions.getExtension('vscode.git')?.exports as
        | { getAPI?: (version: number) => { repositories?: Array<Record<string, unknown>> } }
        | undefined;
      const repository = gitExports?.getAPI?.(1)?.repositories?.[0] as
        | { diff?: (cached?: boolean) => Promise<string>; inputBox?: { value: string } }
        | undefined;
      if (!repository) {
        void vscode.window.showWarningMessage('Dev-First: no git repository found.');
        return;
      }
      let diff = '';
      try {
        diff = (await repository.diff?.(true)) ?? '';
      } catch {
        diff = '';
      }
      if (!diff.trim()) {
        void vscode.window.showInformationMessage('Dev-First: stage some changes first.');
        return;
      }
      try {
        const message = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Dev-First: generating commit message…' },
          () => generateText(commitMessagePrompt(diff.slice(0, 20000)), 256),
        );
        if (message === undefined) {
          return;
        }
        if (!message) {
          void vscode.window.showWarningMessage('Dev-First: the model returned an empty commit message.');
          return;
        }
        if (repository.inputBox) {
          repository.inputBox.value = message;
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Dev-First: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
    vscode.commands.registerCommand('devFirst.generateTerminalCommand', async () => {
      const request = await vscode.window.showInputBox({
        prompt: 'Describe the command you need',
        placeHolder: 'find the largest files in this repo',
        ignoreFocusOut: true,
      });
      if (!request?.trim()) {
        return;
      }
      try {
        const response = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Dev-First: generating command…' },
          () => generateText(terminalCommandPrompt(request.trim()), 256),
        );
        if (response === undefined) {
          return;
        }
        const { command, explanation } = parseTerminalCommandResponse(response);
        if (!command) {
          void vscode.window.showWarningMessage('Dev-First: could not generate a command.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          [
            { label: 'Run', description: command, detail: explanation, action: 'run' as const },
            { label: 'Insert only', description: command, detail: explanation, action: 'insert' as const },
          ],
          { placeHolder: 'Run the generated command?' },
        );
        if (!picked) {
          return;
        }
        const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal();
        terminal.show();
        terminal.sendText(command, picked.action === 'run');
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Dev-First: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
    { dispose: () => session.dispose() },
    { dispose: () => diffManager.dispose() },
  );

  const scanRunner = new ScanRunner(context);
  session.setKnowledgeSource({ refreshKnowledge: () => scanRunner.refreshKnowledge() });
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, createHoverProvider(scanRunner)),
    vscode.commands.registerCommand('devFirst.explainCodebase', async () => {
      await session.explainCodebase();
    }),
    vscode.commands.registerCommand('devFirst.resetScanBaseline', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        'Dev-First: reset the scan baseline? Previously seen findings will be reported again.',
        { modal: true },
        'Reset Baseline',
      );
      if (confirmed !== 'Reset Baseline') {
        return;
      }
      await scanRunner.resetBaseline();
      void vscode.window.showInformationMessage('Dev-First: scan baseline reset.');
    }),
    vscode.commands.registerCommand('devFirst.scanWholeFile', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        void vscode.window.showWarningMessage('Dev-First: open a file to scan with AI.');
        return;
      }
      void scanRunner.scanWholeFile(editor.document);
    }),
    vscode.commands.registerCommand('devFirst.openArchitecture', async () => {
      const executeTool = session.readOnlyToolExecutor();
      await ArchitecturePanel.show({
        extensionUri: context.extensionUri,
        root: workspaceRoot() ?? '',
        state: context.globalState,
        getFacts: () => scanRunner.getArchitectureFacts(),
        getActive: () => activeProvider(context),
        getTools: () => session.plannerToolDefs(),
        executeTool:
          executeTool ?? (() => Promise.resolve('Error: read-only tools are unavailable.')),
      });
    }),
    vscode.commands.registerCommand('devFirst.refreshArchitecture', () => {
      ArchitecturePanel.current?.reload();
    }),
  );
}

export function deactivate(): void {
  DiffManager.getInstance().dispose();
}
