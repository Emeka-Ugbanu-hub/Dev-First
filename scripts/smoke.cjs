// Boots the built extension host bundle with a stubbed vscode API to catch
// activation-time errors (missing registrations, bad requires, etc).
const Module = require('module');
const path = require('path');

const disposables = [];
const disposable = () => ({ dispose() {} });

const fakeVscode = {
  window: {
    createTextEditorDecorationType: () => disposable(),
    onDidChangeActiveTextEditor: () => disposable(),
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeVisibleTextEditors: () => disposable(),
    registerWebviewViewProvider: () => disposable(),
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    showTextDocument: async () => ({ selection: null, revealRange() {} }),
    withProgress: async (_options, task) => task(),
    visibleTextEditors: [],
    activeTextEditor: undefined,
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    createOutputChannel: () => ({
      append() {},
      appendLine() {},
      show() {},
      hide() {},
      clear() {},
      dispose() {},
    }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  env: { clipboard: { readText: async () => '' } },
  workspace: {
    onDidChangeTextDocument: () => disposable(),
    onDidOpenTextDocument: () => disposable(),
    onDidSaveTextDocument: () => disposable(),
    onDidCloseTextDocument: () => disposable(),
    onDidChangeConfiguration: () => disposable(),
    getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }),
    registerCodeLensProvider: () => disposable(),
    registerTextDocumentContentProvider: () => disposable(),
    asRelativePath: (value) => String(value),
    openTextDocument: async () => ({ lineCount: 1, lineAt: () => ({ text: '' }) }),
    workspaceFolders: [],
  },
  languages: {
    createDiagnosticCollection: () => ({
      set() {},
      delete() {},
      clear() {},
      dispose() {},
    }),
    registerCodeLensProvider: () => disposable(),
    registerCodeActionsProvider: () => disposable(),
    registerHoverProvider: () => disposable(),
    getDiagnostics: () => [],
  },
  CodeAction: class {
    constructor(title, kind) {
      this.title = title;
      this.kind = kind;
    }
  },
  CodeActionKind: { Refactor: 'refactor', QuickFix: 'quickfix' },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  commands: {
    registerCommand: (id) => {
      disposables.push(id);
      return disposable();
    },
    executeCommand: () => Promise.resolve(),
  },
  Uri: {
    file: (p) => ({ fsPath: p }),
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath ?? String(base), ...parts) }),
  },
  EventEmitter: class {
    constructor() {
      this.event = () => disposable();
    }
    fire() {}
    dispose() {}
  },
  ThemeColor: class {},
  OverviewRulerLane: { Right: 1 },
  Range: class {},
  Position: class {},
  Selection: class {},
  TextEditorRevealType: { InCenter: 1 },
  ViewColumn: { Active: 1 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return fakeVscode;
  }
  return originalLoad.apply(this, arguments);
};

const extension = require('../dist/extension.js');

const context = {
  subscriptions: [],
  extensionUri: { fsPath: path.join(__dirname, '..') },
  globalStorageUri: { fsPath: path.join(require('os').tmpdir(), 'dev-first-smoke') },
  secrets: {
    get: async () => undefined,
    store: async () => {},
  },
  workspaceState: {
    get: () => undefined,
    update: async () => {},
  },
  globalState: {
    get: () => undefined,
    update: async () => {},
  },
};

extension.activate(context);
console.log(`activate() OK — ${context.subscriptions.length} subscriptions, ${disposables.length} commands registered`);
extension.deactivate();
console.log('deactivate() OK');
