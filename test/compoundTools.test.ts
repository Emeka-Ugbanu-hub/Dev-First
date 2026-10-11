import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const env = vi.hoisted(() => ({
  workspace: '',
  configValues: {} as Record<string, unknown>,
  getDiagnostics: (_uri: unknown): any[] => [],
  executeCommand: async (_command: string, ..._args: unknown[]): Promise<any> => undefined,
  applyEdit: async (_edit: unknown): Promise<boolean> => true,
  getCommands: async (): Promise<string[]> => [
    'vscode.executeDocumentRenameProvider',
    'vscode.executeCodeActionProvider',
    'vscode.executeReferenceProvider',
  ],
}));

const terminal = vi.hoisted(() => ({
  calls: [] as string[],
  exitCode: 0,
  output: 'ok',
}));

const diagnosticsMock = vi.hoisted(() => ({ collectCalls: [] as string[][] }));

vi.mock('../src/agent/terminal', () => ({
  runTerminalCommand: async (command: string) => {
    terminal.calls.push(command);
    return { exitCode: terminal.exitCode, output: terminal.output };
  },
}));

vi.mock('../src/agent/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/diagnostics')>();
  return {
    ...actual,
    collectFileDiagnostics: async (paths: string[]) => {
      diagnosticsMock.collectCalls.push([...paths]);
      return actual.collectFileDiagnostics(paths);
    },
  };
});

vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Range {
    constructor(public start: Position, public end: Position) {}
  }
  const disposable = { dispose() {} };
  return {
    workspace: {
      get workspaceFolders() {
        return env.workspace ? [{ uri: uri(env.workspace) }] : [];
      },
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => (key in env.configValues ? env.configValues[key] : fallback),
        update: async () => undefined,
      }),
      openTextDocument: async () => undefined,
      applyEdit: (edit: unknown) => env.applyEdit(edit),
      asRelativePath: (value: unknown) => {
        const fsPath =
          typeof value === 'string' ? value : ((value as { fsPath?: string } | undefined)?.fsPath ?? '');
        if (env.workspace && fsPath.startsWith(env.workspace)) {
          return path.relative(env.workspace, fsPath).split(path.sep).join('/');
        }
        return fsPath;
      },
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
    },
    languages: { getDiagnostics: (fileUri: unknown) => env.getDiagnostics(fileUri) },
    commands: {
      getCommands: () => env.getCommands(),
      executeCommand: (command: string, ...args: unknown[]) => env.executeCommand(command, ...args),
      registerCommand: () => disposable,
    },
    Uri: { file: (fsPath: string) => uri(fsPath), from: (parts: { path: string }) => uri(parts.path) },
    Position,
    Range,
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    SymbolKind: [
      'File',
      'Module',
      'Namespace',
      'Package',
      'Class',
      'Method',
      'Property',
      'Field',
      'Constructor',
      'Enum',
      'Interface',
      'Function',
      'Variable',
      'Constant',
      'String',
      'Number',
      'Boolean',
      'Array',
      'Object',
      'Key',
      'Null',
      'EnumMember',
      'Struct',
      'Event',
      'Operator',
      'TypeParameter',
    ],
    CodeActionKind: { QuickFix: 'quickfix' },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    window: {
      onDidChangeActiveTextEditor: () => disposable,
      onDidChangeVisibleTextEditors: () => disposable,
      visibleTextEditors: [],
    },
  };
});

import { ToolBox } from '../src/agent/ToolBox';
import {
  declarationCandidateCount,
  detectVerifyCommand,
  isWorkspaceRelativePath,
  parseHunks,
  patchHunksFor,
  textualRenameHazards,
  validateChangeSet,
} from '../src/agent/compoundTools';
import { attachToolPreflights, preflightRenameSymbol } from '../src/agent/compoundPreflight';
import { executionTools, plannerTools } from '../src/agent/tools';

let root: string;
let applyChange: ReturnType<typeof vi.fn>;
let applyDeletion: ReturnType<typeof vi.fn>;

function toolbox(): ToolBox {
  return new ToolBox({
    root,
    diffManager: { applyChange, applyDeletion } as any,
    terminalTimeoutSeconds: 15,
    autoApproveTerminal: false,
    autoApproveEdits: true,
    safeCommandsOnly: true,
    yolo: false,
    autoApproveMcp: true,
    checkDiagnostics: false,
    sandbox: 'off',
  });
}

const context = { requestTerminalApproval: async () => 'allow' as const };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-compound-'));
  env.workspace = root;
  env.configValues = {};
  env.getDiagnostics = () => [];
  env.executeCommand = async () => undefined;
  env.applyEdit = async () => true;
  terminal.calls = [];
  terminal.exitCode = 0;
  terminal.output = 'ok';
  diagnosticsMock.collectCalls = [];
  applyChange = vi.fn(async (file: string, content: string) => {
    await fs.writeFile(file, content, 'utf-8');
    return `Applied changes to ${path.basename(file)}.`;
  });
  applyDeletion = vi.fn(async (file: string) => {
    await fs.unlink(file);
    return `Deleted ${path.basename(file)}.`;
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('change-set validation', () => {
  it('accepts valid edits, creates, and deletes', () => {
    const result = validateChangeSet({
      changes: [
        { path: 'src/a.ts', action: 'edit', patch: '@@\n-a\n+b' },
        { path: 'src/b.ts', action: 'create', content: 'hello' },
        { path: 'src/c.ts', action: 'delete' },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.changes.map((entry) => [entry.path, entry.action])).toEqual([
      ['src/a.ts', 'edit'],
      ['src/b.ts', 'create'],
      ['src/c.ts', 'delete'],
    ]);
  });

  it('rejects missing, escaping, duplicate, and malformed entries', () => {
    expect(validateChangeSet({ changes: [] }).ok).toBe(false);
    expect(validateChangeSet({}).ok).toBe(false);
    expect(validateChangeSet({ changes: [{ path: '../escape.ts', action: 'edit', content: 'x' }] }).ok).toBe(false);
    expect(validateChangeSet({ changes: [{ path: '/abs.ts', action: 'edit', content: 'x' }] }).ok).toBe(false);
    expect(validateChangeSet({ changes: [{ path: '.', action: 'edit', content: 'x' }] }).ok).toBe(false);
    expect(
      validateChangeSet({
        changes: [
          { path: 'a.ts', action: 'edit', content: 'x' },
          { path: 'a.ts', action: 'delete' },
        ],
      }).ok,
    ).toBe(false);
    expect(validateChangeSet({ changes: [{ path: 'a.ts', action: 'edit' }] }).ok).toBe(false);
    expect(validateChangeSet({ changes: [{ path: 'a.ts', action: 'edit', patch: '@@', content: 'x' }] }).ok).toBe(
      false,
    );
    expect(validateChangeSet({ changes: [{ path: 'a.ts', action: 'create' }] }).ok).toBe(false);
    expect(validateChangeSet({ changes: [{ path: 'a.ts', action: 'rename' }] }).ok).toBe(false);
    expect(validateChangeSet({ changes: [{ path: 'a.ts', action: 'edit', content: 'x' }] }).ok).toBe(true);
  });

  it('caps the number of entries per call', () => {
    const changes = Array.from({ length: 51 }, (_, index) => ({
      path: `file-${index}.ts`,
      action: 'delete',
    }));
    expect(validateChangeSet({ changes }).ok).toBe(false);
  });

  it('treats traversal segments as workspace-relative or not', () => {
    expect(isWorkspaceRelativePath('src/a.ts')).toBe(true);
    expect(isWorkspaceRelativePath('a/../b.ts')).toBe(true);
    expect(isWorkspaceRelativePath('../a.ts')).toBe(false);
    expect(isWorkspaceRelativePath('..')).toBe(false);
    expect(isWorkspaceRelativePath('')).toBe(false);
  });
});

describe('verify_change command detection', () => {
  it('prefers typecheck, then test, then build', () => {
    expect(detectVerifyCommand(JSON.stringify({ scripts: { build: 'vite build', test: 'vitest', typecheck: 'tsc' } }))).toEqual(
      { script: 'typecheck', command: 'npm run typecheck' },
    );
    expect(detectVerifyCommand(JSON.stringify({ scripts: { build: 'vite build', test: 'vitest' } }))).toEqual({
      script: 'test',
      command: 'npm run test',
    });
    expect(detectVerifyCommand(JSON.stringify({ scripts: { build: 'vite build' } }))).toEqual({
      script: 'build',
      command: 'npm run build',
    });
  });

  it('returns undefined for missing, empty, or malformed scripts', () => {
    expect(detectVerifyCommand(JSON.stringify({ scripts: {} }))).toBeUndefined();
    expect(detectVerifyCommand(JSON.stringify({ scripts: { test: '   ' } }))).toBeUndefined();
    expect(detectVerifyCommand(JSON.stringify({ name: 'x' }))).toBeUndefined();
    expect(detectVerifyCommand('not json')).toBeUndefined();
  });
});

describe('hunk parsing', () => {
  it('parses bare hunks and patch sections', () => {
    expect(parseHunks('@@\n-a\n+b')).toEqual([{ lines: ['-a', '+b'] }]);
    expect(parseHunks('@@\n-a\n+b\n@@\n-c\n+d')).toEqual([
      { lines: ['-a', '+b'] },
      { lines: ['-c', '+d'] },
    ]);
    const patch = ['*** Begin Patch', '*** Update File: a.ts', '@@', '-old', '+new', '*** End Patch'].join('\n');
    expect(patchHunksFor(patch)).toEqual([{ lines: ['-old', '+new'] }]);
  });
});

describe('textual rename analysis', () => {
  it('flags identifier occurrences in strings and comments', () => {
    expect(textualRenameHazards('const value = 1;\n', 'value')).toEqual([]);
    expect(textualRenameHazards("const label = 'value';\n", 'value')).toContain('identifier appears in a string literal');
    expect(textualRenameHazards('// value\nconst value = 1;\n', 'value')).toContain('identifier appears in a comment');
    expect(textualRenameHazards('const value = 1; // value\n', 'value')).toContain('identifier appears in a comment');
    expect(textualRenameHazards('/* value */\nconst value = 1;\n', 'value')).toContain('identifier appears in a comment');
    expect(textualRenameHazards('# value\nvalue = 1\n', 'value')).toContain('identifier appears in a comment');
  });

  it('counts declaration candidates', () => {
    expect(declarationCandidateCount('const value = 1;\n', 'value')).toBe(1);
    expect(declarationCandidateCount('export const value = 1;\nfunction value() {\n}\n', 'value')).toBe(2);
    expect(declarationCandidateCount('return value;\n', 'value')).toBe(0);
  });
});

describe('registry wiring', () => {
  it('puts the executor compound order first and never puts mutating compound tools in the planner', () => {
    const executor = executionTools().map((tool) => tool.name);
    expect(executor.slice(0, 11)).toEqual([
      'fix_in_file',
      'apply_change_set',
      'rename_symbol',
      'refactor_symbol',
      'fix_diagnostic',
      'add_import_and_use',
      'update_related_files',
      'investigate_issue',
      'verify_change',
      'inspect_file_context',
      'bounded_investigation',
    ]);
    const planner = plannerTools().map((tool) => tool.name);
    for (const name of [
      'apply_change_set',
      'fix_in_file',
      'fix_diagnostic',
      'rename_symbol',
      'add_import_and_use',
      'update_related_files',
      'refactor_symbol',
    ]) {
      expect(planner).not.toContain(name);
    }
    expect(planner.slice(0, 4)).toEqual([
      'inspect_file_context',
      'investigate_issue',
      'bounded_investigation',
      'verify_change',
    ]);
  });

  it('registers the read-only compound tools in both sets with distinct verify_change schemas', () => {
    const executor = executionTools();
    const planner = plannerTools();
    for (const name of ['inspect_file_context', 'investigate_issue', 'verify_change', 'bounded_investigation']) {
      expect(executor.map((tool) => tool.name)).toContain(name);
      expect(planner.map((tool) => tool.name)).toContain(name);
    }
    const executorVerify = executor.find((tool) => tool.name === 'verify_change')!;
    const plannerVerify = planner.find((tool) => tool.name === 'verify_change')!;
    const executorEnum = (executorVerify.parameters as any).properties.mode.enum;
    const plannerEnum = (plannerVerify.parameters as any).properties.mode.enum;
    expect(executorEnum).toEqual(['diagnostics', 'auto']);
    expect(plannerEnum).toEqual(['diagnostics']);
    expect((plannerVerify.parameters as any).properties.mode.description).toContain('planning');
  });

  it('marks the raw fallback tools and leaves compound names untouched', () => {
    const names = executionTools();
    for (const name of ['read_file', 'write_file', 'edit_file', 'apply_patch', 'search_text', 'run_terminal_command']) {
      const definition = names.find((tool) => tool.name === name)!;
      expect(definition.description.endsWith(' Fallback: use only when no compound tool fits.')).toBe(true);
    }
    const execute = names.find((tool) => tool.name === 'apply_change_set')!;
    expect(execute.description).toBe('Coordinated changes across related files.');
  });
});

describe('preflight mechanism', () => {
  it('attaches preflights only to dynamic-target tools', () => {
    const tools = attachToolPreflights(executionTools());
    const withPreflight = tools.filter((tool) => tool.preflight).map((tool) => tool.name);
    expect(withPreflight.sort()).toEqual(
      ['add_import_and_use', 'refactor_symbol', 'rename_symbol', 'update_related_files'].sort(),
    );
  });

  it('captures reference files for rename before any edit is applied', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const value = 1;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'b.ts'), 'export { value };\n', 'utf-8');
    await fs.writeFile(path.join(root, 'c.ts'), "import { value } from './b';\n", 'utf-8');
    env.executeCommand = async (command: string) => {
      if (command === 'vscode.executeReferenceProvider') {
        return [
          { uri: { fsPath: path.join(root, 'a.ts') }, range: { start: { line: 0, character: 6 } } },
          { uri: { fsPath: path.join(root, 'b.ts') }, range: { start: { line: 0, character: 9 } } },
          { uri: { fsPath: path.join(root, 'c.ts') }, range: { start: { line: 0, character: 9 } } },
        ];
      }
      return undefined;
    };
    const captured = await preflightRenameSymbol({ path: 'a.ts', line: 1, character: 7 });
    expect(captured).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('apply_change_set', () => {
  it('preflights every match before writing anything', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf-8');
    await fs.writeFile(path.join(root, 'b.txt'), 'two\n', 'utf-8');
    const result = await toolbox().execute(
      'apply_change_set',
      JSON.stringify({
        changes: [
          { path: 'a.txt', action: 'edit', patch: '@@\n-one\n+ONE' },
          { path: 'b.txt', action: 'edit', patch: '@@\n-missing\n+changed' },
        ],
      }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('failed');
    expect(parsed.message).toContain('nothing was written');
    expect(parsed.message).toContain('b.txt');
    expect(applyChange).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('two\n');
  });

  it('rolls back already-applied files when a later write fails', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf-8');
    await fs.writeFile(path.join(root, 'b.txt'), 'two\n', 'utf-8');
    applyChange = vi.fn(async (file: string, content: string) => {
      if (file.endsWith('b.txt')) {
        throw new Error('disk full');
      }
      await fs.writeFile(file, content, 'utf-8');
      return `Applied changes to ${path.basename(file)}.`;
    });
    const result = await toolbox().execute(
      'apply_change_set',
      JSON.stringify({
        changes: [
          { path: 'a.txt', action: 'edit', patch: '@@\n-one\n+ONE' },
          { path: 'b.txt', action: 'edit', patch: '@@\n-two\n+TWO' },
        ],
      }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('failed');
    expect(parsed.message).toContain('disk full');
    expect(JSON.stringify(parsed.evidence)).toContain('rolled back a.txt');
    expect(parsed.diff).toContain('-one');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('two\n');
  });

  it('applies an ordered change set with per-file status', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf-8');
    await fs.writeFile(path.join(root, 'old.txt'), 'old\n', 'utf-8');
    const result = await toolbox().execute(
      'apply_change_set',
      JSON.stringify({
        changes: [
          { path: 'a.txt', action: 'edit', patch: '@@\n-one\n+ONE' },
          { path: 'new.txt', action: 'create', content: 'created\n' },
          { path: 'old.txt', action: 'delete' },
        ],
      }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.files).toEqual(['a.txt', 'new.txt', 'old.txt']);
    expect(parsed.diff).toContain('+ONE');
    expect(parsed.rollbackAvailable).toBe(true);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('ONE\n');
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf-8')).toBe('created\n');
    await expect(fs.stat(path.join(root, 'old.txt'))).rejects.toThrow();
  });
});

describe('fix_in_file', () => {
  it('applies the change and reports a verifiable result', async () => {
    const target = path.join(root, 'broken.ts');
    await fs.writeFile(target, 'const broken = 1;\n', 'utf-8');
    env.getDiagnostics = (fileUri: any) => {
      if (fileUri?.fsPath === target) {
        const current = readFileSync(target, 'utf-8');
        if (!current.includes('broken')) {
          return [];
        }
        return [
          {
            severity: 0,
            source: 'ts',
            message: 'broken code',
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
          },
        ];
      }
      return [];
    };
    const result = await toolbox().execute(
      'fix_in_file',
      JSON.stringify({ path: 'broken.ts', content: 'const fixed = 1;\n' }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.files).toEqual(['broken.ts']);
    expect(parsed.diff).toContain('+const fixed = 1;');
    expect(parsed.verification.level).toBe('full');
    expect(await fs.readFile(target, 'utf-8')).toBe('const fixed = 1;\n');
  });

  it('fails cleanly when the patch does not match', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf-8');
    const result = await toolbox().execute(
      'fix_in_file',
      JSON.stringify({ path: 'a.txt', patch: '@@\n-missing\n+changed' }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('failed');
    expect(parsed.message).toContain('Could not locate');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('one\n');
  });

  it('applies directive oldText/newText replacements and rejects ambiguity', async () => {
    await fs.writeFile(path.join(root, 'dup.txt'), 'alpha\nalpha\n', 'utf-8');
    const ambiguous = await toolbox().execute(
      'fix_in_file',
      JSON.stringify({ path: 'dup.txt', oldText: 'alpha', newText: 'beta' }),
      context,
    );
    const ambiguousParsed = JSON.parse(ambiguous);
    expect(ambiguousParsed.status).toBe('needs_input');
    expect(ambiguousParsed.message).toContain('lines 1, 2');

    const applied = await toolbox().execute(
      'fix_in_file',
      JSON.stringify({ path: 'dup.txt', oldText: 'alpha', newText: 'beta', occurrence: 2 }),
      context,
    );
    expect(JSON.parse(applied).status).toBe('verified');
    expect(await fs.readFile(path.join(root, 'dup.txt'), 'utf-8')).toBe('alpha\nbeta\n');
  });
});

describe('add_import_and_use', () => {
  it('falls back to textual import insertion with allowTextual and marks it partial', async () => {
    await fs.writeFile(path.join(root, 'use.ts'), 'const result = value;\n', 'utf-8');
    env.executeCommand = async (command: string) => {
      if (command === 'vscode.executeCodeActionProvider') {
        return [];
      }
      return undefined;
    };
    const result = await toolbox().execute(
      'add_import_and_use',
      JSON.stringify({
        path: 'use.ts',
        symbol: 'value',
        source: './values',
        allowTextual: true,
        patch: '@@\n-const result = value;\n+const result = value();',
      }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(JSON.stringify(parsed.evidence)).toContain("Inserted: import { value } from './values';");
    expect(parsed.verification.level).toBe('partial');
    expect(parsed.verification.checks).toContain('textual');
    const content = await fs.readFile(path.join(root, 'use.ts'), 'utf-8');
    expect(content.startsWith("import { value } from './values';\n")).toBe(true);
    expect(content).toContain('const result = value();');
  });

  it('requires allowTextual before inserting an import textually', async () => {
    await fs.writeFile(path.join(root, 'use.ts'), 'const result = value;\n', 'utf-8');
    env.executeCommand = async (command: string) => {
      if (command === 'vscode.executeCodeActionProvider') {
        return [];
      }
      return undefined;
    };
    const result = await toolbox().execute(
      'add_import_and_use',
      JSON.stringify({ path: 'use.ts', symbol: 'value', source: './values' }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.message).toContain('No language server is available; re-call with allowTextual: true');
    expect(await fs.readFile(path.join(root, 'use.ts'), 'utf-8')).toBe('const result = value;\n');
    expect(applyChange).not.toHaveBeenCalled();
  });
});

describe('rename_symbol', () => {
  it('falls back to a word-boundary textual rename with allowTextual and marks it partial', async () => {
    const target = path.join(root, 'greet.ts');
    await fs.writeFile(target, 'const value = 1;\nreturn value;\n', 'utf-8');
    env.executeCommand = async (command: string) => {
      if (command === 'vscode.executeDocumentRenameProvider') {
        return undefined;
      }
      return undefined;
    };
    const result = await toolbox().execute(
      'rename_symbol',
      JSON.stringify({ path: 'greet.ts', line: 1, character: 7, newName: 'count', allowTextual: true }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.message).toContain('Renamed symbol to count.');
    expect(parsed.message).toContain('language server rename was unavailable');
    expect(parsed.verification.level).toBe('partial');
    expect(parsed.verification.checks).toContain('textual');
    const content = await fs.readFile(target, 'utf-8');
    expect(content).toBe('const count = 1;\nreturn count;\n');
  });

  it('requires allowTextual before falling back to a textual rename', async () => {
    const target = path.join(root, 'greet.ts');
    await fs.writeFile(target, 'const value = 1;\nreturn value;\n', 'utf-8');
    env.executeCommand = async () => undefined;
    const result = await toolbox().execute(
      'rename_symbol',
      JSON.stringify({ path: 'greet.ts', line: 1, character: 7, newName: 'count' }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.message).toContain('No language server is available; re-call with allowTextual: true');
    expect(await fs.readFile(target, 'utf-8')).toBe('const value = 1;\nreturn value;\n');
  });

  it('refuses a textual rename when the identifier appears in a string literal', async () => {
    const target = path.join(root, 'greet.ts');
    await fs.writeFile(target, "const value = 1;\nconst label = 'value';\n", 'utf-8');
    env.executeCommand = async () => undefined;
    const result = await toolbox().execute(
      'rename_symbol',
      JSON.stringify({ path: 'greet.ts', line: 1, character: 7, newName: 'count', allowTextual: true }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.message).toContain('ambiguous');
    expect(parsed.message).toContain('string literal');
    expect(await fs.readFile(target, 'utf-8')).toBe("const value = 1;\nconst label = 'value';\n");
    expect(applyChange).not.toHaveBeenCalled();
  });

  it('refuses a textual rename with multiple declaration candidates', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'export const value = 1;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'b.ts'), 'const value = 2;\n', 'utf-8');
    const result = await toolbox().execute(
      'rename_symbol',
      JSON.stringify({ instruction: 'rename value to total', allowTextual: true }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.message).toContain('multiple declaration candidates');
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf-8')).toBe('export const value = 1;\n');
    expect(await fs.readFile(path.join(root, 'b.ts'), 'utf-8')).toBe('const value = 2;\n');
    expect(applyChange).not.toHaveBeenCalled();
  });

  it('accepts a deterministic rename instruction without a position', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'export const value = 1;\n', 'utf-8');
    const result = await toolbox().execute(
      'rename_symbol',
      JSON.stringify({ instruction: 'rename value to total', allowTextual: true }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.files).toContain('a.ts');
    expect(parsed.verification.level).toBe('partial');
    expect(parsed.verification.checks).toContain('textual');
    expect(await fs.readFile(path.join(root, 'a.ts'), 'utf-8')).toBe('export const total = 1;\n');
  });
});

describe('update_related_files', () => {
  async function seedReferences(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      await fs.writeFile(path.join(root, `file-${index}.ts`), 'let MARKER = 1;\n', 'utf-8');
    }
    env.executeCommand = async (command: string) => {
      if (command === 'vscode.executeWorkspaceSymbolProvider') {
        return [
          {
            name: 'MARKER',
            kind: 13,
            location: {
              uri: { fsPath: path.join(root, 'file-0.ts') },
              range: { start: { line: 0, character: 4 }, end: { line: 0, character: 10 } },
            },
          },
        ];
      }
      if (command === 'vscode.executeReferenceProvider') {
        return Array.from({ length: count }, (_, index) => ({
          uri: { fsPath: path.join(root, `file-${index}.ts`) },
          range: { start: { line: 0, character: 4 } },
        }));
      }
      return undefined;
    };
  }

  it('asks for confirm when more than 10 candidates are found', async () => {
    await seedReferences(12);
    const result = await toolbox().execute(
      'update_related_files',
      JSON.stringify({ symbol_or_pattern: 'MARKER', patchTemplate: '@@\n-let MARKER = 1;\n+let marker = 1;' }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.message).toContain('Found 12 candidate files');
    expect(parsed.message).toContain('Re-call with confirm: true');
    expect(applyChange).not.toHaveBeenCalled();
  });

  it('applies the template to up to 20 confirmed files', async () => {
    await seedReferences(12);
    const result = await toolbox().execute(
      'update_related_files',
      JSON.stringify({
        symbol_or_pattern: 'MARKER',
        patchTemplate: '@@\n-let MARKER = 1;\n+let marker = 1;',
        confirm: true,
      }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.message).toContain('Updated 12/12 files');
    expect(parsed.policyLevel).toBe(3);
    expect(parsed.message).toContain('none was resolved and no command ran');
    expect(await fs.readFile(path.join(root, 'file-5.ts'), 'utf-8')).toBe('let marker = 1;\n');
  });
});

describe('refactor_symbol', () => {
  it('extracts a range into a new function in the same file', async () => {
    const target = path.join(root, 'main.ts');
    await fs.writeFile(target, 'const a = compute(1);\nfunction other() {}\n', 'utf-8');
    const result = await toolbox().execute(
      'refactor_symbol',
      JSON.stringify({
        path: 'main.ts',
        operation: 'extract',
        name: 'compute',
        range: { startLine: 1, startChar: 11, endLine: 1, endChar: 21 },
        callCode: 'extracted(1)',
        extractedCode: 'function extracted(x: number) { return x; }',
      }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.message).toContain('Extracted compute in main.ts.');
    const content = await fs.readFile(target, 'utf-8');
    expect(content.startsWith('const a = extracted(1);\n')).toBe(true);
    expect(content).toContain('function extracted(x: number) { return x; }');
  });

  it('moves a range into a target file and can roll back the source on failure', async () => {
    const source = path.join(root, 'a.ts');
    const target = path.join(root, 'b.ts');
    await fs.writeFile(source, 'export function helper() {\n  return 1;\n}\n', 'utf-8');
    await fs.writeFile(target, 'export const x = 1;\n', 'utf-8');
    const result = await toolbox().execute(
      'refactor_symbol',
      JSON.stringify({
        path: 'a.ts',
        operation: 'move',
        name: 'helper',
        range: { startLine: 1, startChar: 1, endLine: 3, endChar: 2 },
        targetPath: 'b.ts',
        targetHeader: 'export { helper };',
      }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.message).toContain('Moved helper from a.ts to b.ts.');
    const movedContent = await fs.readFile(target, 'utf-8');
    expect(movedContent).toContain('export { helper };');
    expect(movedContent).toContain('export function helper() {');
    expect(await fs.readFile(source, 'utf-8')).toBe('');

    await fs.writeFile(source, 'export function helper() {\n  return 1;\n}\n', 'utf-8');
    applyChange = vi.fn(async (file: string, content: string) => {
      if (file === target) {
        throw new Error('disk full');
      }
      await fs.writeFile(file, content, 'utf-8');
      return `Applied changes to ${path.basename(file)}.`;
    });
    const failed = await toolbox().execute(
      'refactor_symbol',
      JSON.stringify({
        path: 'a.ts',
        operation: 'move',
        name: 'helper',
        range: { startLine: 1, startChar: 1, endLine: 3, endChar: 2 },
        targetPath: 'b.ts',
        targetHeader: 'export { helper };',
      }),
      context,
    );
    const failedParsed = JSON.parse(failed);
    expect(failedParsed.status).toBe('failed');
    expect(failedParsed.message).toContain('The source change was rolled back.');
    expect(await fs.readFile(source, 'utf-8')).toBe('export function helper() {\n  return 1;\n}\n');
  });
});

describe('verify_change', () => {
  it('forces diagnostics-only mode during planning even when auto is requested', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n', 'utf-8');
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'utf-8',
    );
    const result = await toolbox().execute(
      'verify_change',
      JSON.stringify({ paths: ['a.ts'], mode: 'auto' }),
      { requestTerminalApproval: async () => 'allow' as const, planning: true },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.verification.level).toBe('partial');
    expect(parsed.verification.checks).toContain('diagnostics');
    expect(parsed.message).not.toContain('npm run typecheck');
  });

  it('runs the resolved command and reports the kind, command, and source', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n', 'utf-8');
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'utf-8',
    );
    const result = await toolbox().execute('verify_change', JSON.stringify({ paths: ['a.ts'], mode: 'auto' }), context);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.verification.level).toBe('full');
    expect(parsed.verification.checks).toContain('typecheck:npm run typecheck');
    expect(parsed.message).toContain('Verified with typecheck: npm run typecheck');
    expect(JSON.stringify(parsed.evidence)).toContain('manifest');
    expect(terminal.calls).toEqual(['npm run typecheck']);
  });

  it('uses a configured command over a detected one', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n', 'utf-8');
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'utf-8',
    );
    env.configValues = { typecheckCommand: 'custom-check' };
    const result = await toolbox().execute('verify_change', JSON.stringify({ paths: ['a.ts'], mode: 'auto' }), context);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.verification.checks).toContain('typecheck:custom-check');
    expect(terminal.calls).toEqual(['custom-check']);
  });

  it('asks the developer to configure a command when none is detected', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n', 'utf-8');
    const result = await toolbox().execute('verify_change', JSON.stringify({ paths: ['a.ts'], mode: 'auto' }), context);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.verification.level).toBe('partial');
    expect(parsed.verification.checks).toContain('diagnostics');
    expect(parsed.message).toContain('devFirst.typecheckCommand');
    expect(terminal.calls).toEqual([]);
  });

  it('asks the developer to pick a command when candidates are ambiguous', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n', 'utf-8');
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'utf-8',
    );
    await fs.writeFile(path.join(root, 'Cargo.toml'), '[package]\nname = "x"\n', 'utf-8');
    const result = await toolbox().execute('verify_change', JSON.stringify({ paths: ['a.ts'], mode: 'auto' }), context);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('needs_input');
    expect(parsed.verification.level).toBe('partial');
    expect(parsed.message).toContain('npm run typecheck');
    expect(parsed.message).toContain('cargo check');
    expect(parsed.message).toContain('devFirst.typecheckCommand');
    expect(terminal.calls).toEqual([]);
  });

  it('reports a failed check when the command exits non-zero', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n', 'utf-8');
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'utf-8',
    );
    terminal.exitCode = 2;
    terminal.output = 'error TS1005';
    const result = await toolbox().execute('verify_change', JSON.stringify({ paths: ['a.ts'], mode: 'auto' }), context);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('failed');
    expect(parsed.verification.level).toBe('none');
    expect(parsed.verification.checks).toContain('typecheck:npm run typecheck');
    expect(parsed.message).toContain('npm run typecheck failed');
  });
});

describe('compound edge cases', () => {
  it('marks bounded_investigation partial when output exceeds the budget', async () => {
    const lines = Array.from(
      { length: 300 },
      (_value, index) => `export const value${index} = 1234567890;`,
    );
    await fs.writeFile(path.join(root, 'big.ts'), `${lines.join('\n')}\n`, 'utf-8');
    const result = await toolbox().execute(
      'bounded_investigation',
      JSON.stringify({ operations: [{ tool: 'read_file', args: { path: 'big.ts' } }] }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.verification.level).toBe('partial');
    expect(parsed.truncated).toBe(true);
  });

  it('rejects the whole change set before writing when any target is generated', async () => {
    await fs.writeFile(path.join(root, 'keep.ts'), 'const a = 1;\n', 'utf-8');
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist', 'out.js'), 'old\n', 'utf-8');
    const result = await toolbox().execute(
      'apply_change_set',
      JSON.stringify({
        changes: [
          { path: 'keep.ts', action: 'edit', content: 'const a = 2;\n' },
          { path: 'dist/out.js', action: 'edit', content: 'new\n' },
        ],
      }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(['blocked', 'needs_input', 'failed']).toContain(parsed.status);
    expect(await fs.readFile(path.join(root, 'keep.ts'), 'utf-8')).toBe('const a = 1;\n');
    expect(await fs.readFile(path.join(root, 'dist', 'out.js'), 'utf-8')).toBe('old\n');
  });
});

describe('adaptive verification', () => {
  it('keeps a trivial single-file fix at level 1 with no command', async () => {
    await fs.writeFile(path.join(root, 'clean.ts'), 'const a = 1;\n', 'utf-8');
    const result = await toolbox().execute(
      'fix_in_file',
      JSON.stringify({ path: 'clean.ts', content: 'const a = 2;\n' }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.policyLevel).toBe(1);
    expect(parsed.reasons).toEqual([]);
    expect(parsed.verification.level).toBe('full');
    expect(parsed.verification.checks).toEqual(expect.arrayContaining(['write', 'diagnostics', 'diff']));
    expect(terminal.calls).toEqual([]);
  });

  it('escalates a symbol rename to level 2 with reference and closest-test checks', async () => {
    await fs.writeFile(path.join(root, 'greet.ts'), 'const value = 1;\nreturn value;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'greet.test.ts'), "import { value } from './greet';\n", 'utf-8');
    env.executeCommand = async (command: string) => {
      if (command === 'vscode.executeReferenceProvider') {
        return [
          { uri: { fsPath: path.join(root, 'greet.ts') }, range: { start: { line: 0, character: 6 } } },
          { uri: { fsPath: path.join(root, 'greet.test.ts') }, range: { start: { line: 0, character: 9 } } },
        ];
      }
      return undefined;
    };
    const result = await toolbox().execute(
      'rename_symbol',
      JSON.stringify({ path: 'greet.ts', line: 1, character: 7, newName: 'count', allowTextual: true }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.policyLevel).toBe(2);
    expect(parsed.verification.checks).toEqual(
      expect.arrayContaining(['related-diagnostics', 'references', 'closest-test', 'package-typecheck']),
    );
    expect(terminal.calls).toEqual([]);
  });

  it('escalates a five-file change set to level 3 and runs the project test command', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf-8');
    const changes = [];
    for (let index = 0; index < 5; index++) {
      await fs.writeFile(path.join(root, `part-${index}.ts`), `export const part${index} = ${index};\n`, 'utf-8');
      changes.push({ path: `part-${index}.ts`, action: 'edit', content: `export const part${index} = ${index + 1};\n` });
    }
    const result = await toolbox().execute('apply_change_set', JSON.stringify({ changes }), context);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.policyLevel).toBe(3);
    expect(parsed.reasons).toContain('5 files changed');
    expect(parsed.verification.checks).toContain('project-command');
    expect(terminal.calls).toEqual(['npm run test']);
  });

  it('allows one repair and reruns only the failed check', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'utf-8',
    );
    await fs.writeFile(path.join(root, 'check.ts'), 'const a = 1;\n', 'utf-8');
    const box = toolbox();
    terminal.exitCode = 2;
    terminal.output = 'error TS1005';
    const first = await box.execute(
      'fix_in_file',
      JSON.stringify({ path: 'check.ts', content: 'const a = 2;\n' }),
      context,
    );
    const firstParsed = JSON.parse(first);
    expect(firstParsed.status).toBe('failed');
    expect(firstParsed.repairAllowed).toBe(true);
    expect(firstParsed.message).toContain('error TS1005');
    expect(terminal.calls).toEqual(['npm run typecheck']);

    terminal.exitCode = 0;
    const second = await box.execute(
      'fix_in_file',
      JSON.stringify({ path: 'check.ts', content: 'const a = 3;\n' }),
      context,
    );
    const secondParsed = JSON.parse(second);
    expect(secondParsed.status).toBe('verified');
    expect(secondParsed.repairAllowed).toBe(false);
    expect(secondParsed.policyLevel).toBe(3);
    expect(secondParsed.verification.level).toBe('full');
    expect(terminal.calls).toEqual(['npm run typecheck', 'npm run typecheck']);
  });

  it('stops after the second failure of the same check', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'utf-8',
    );
    await fs.writeFile(path.join(root, 'check.ts'), 'const a = 1;\n', 'utf-8');
    const box = toolbox();
    terminal.exitCode = 2;
    terminal.output = 'error TS1005';
    await box.execute('fix_in_file', JSON.stringify({ path: 'check.ts', content: 'const a = 2;\n' }), context);
    terminal.output = 'error TS2322';
    const second = await box.execute(
      'fix_in_file',
      JSON.stringify({ path: 'check.ts', content: 'const a = 3;\n' }),
      context,
    );
    const parsed = JSON.parse(second);
    expect(parsed.status).toBe('failed');
    expect(parsed.repairAllowed).toBe(false);
    expect(parsed.message).toBe('Repair attempt already used; stopping.');
    expect(terminal.calls).toEqual(['npm run typecheck', 'npm run typecheck']);
  });

  it('caches diagnostics per unchanged file hash', async () => {
    const target = path.join(root, 'shared.ts');
    await fs.writeFile(target, 'export const shared = 1;\n', 'utf-8');
    const box = toolbox() as any;
    await box.cachedDiagnostics([target]);
    await box.cachedDiagnostics([target]);
    expect(diagnosticsMock.collectCalls.filter((paths) => paths.includes(target)).length).toBe(1);
  });

  it('skips escalation when adaptiveVerify is false', async () => {
    env.configValues = { adaptiveVerify: false };
    await fs.writeFile(path.join(root, 'quiet.ts'), 'const a = 1;\n', 'utf-8');
    const result = await toolbox().execute(
      'fix_in_file',
      JSON.stringify({ path: 'quiet.ts', content: 'const a = 2;\n' }),
      context,
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('verified');
    expect(parsed.policyLevel).toBeUndefined();
    expect(parsed.repairAllowed).toBeUndefined();
    expect(parsed.verification.checks).toEqual(['content', 'stale-guard', 'diagnostics']);
    expect(terminal.calls).toEqual([]);
  });
});
