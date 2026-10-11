import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const env = vi.hoisted(() => ({
  workspace: '',
  getDiagnostics: (_uri: unknown): any[] => [],
  executeCommand: async (_command: string, ..._args: unknown[]): Promise<any> => undefined,
  applyEdit: async (_edit: unknown): Promise<boolean> => true,
  getCommands: async (): Promise<string[]> => [
    'vscode.executeDocumentRenameProvider',
    'vscode.executeCodeActionProvider',
    'vscode.executeReferenceProvider',
  ],
}));

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
        get: (_key: string, fallback: unknown) => fallback,
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
  detectVerifyCommand,
  isWorkspaceRelativePath,
  parseHunks,
  patchHunksFor,
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
  env.getDiagnostics = () => [];
  env.executeCommand = async () => undefined;
  env.applyEdit = async () => true;
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

describe('registry wiring', () => {
  it('puts mutating compound tools first in the executor and never in the planner', () => {
    const executor = executionTools().map((tool) => tool.name);
    expect(executor.slice(0, 7)).toEqual([
      'apply_change_set',
      'fix_in_file',
      'fix_diagnostic',
      'rename_symbol',
      'add_import_and_use',
      'update_related_files',
      'refactor_symbol',
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
  });

  it('registers the read-only trio in both sets with distinct verify_change schemas', () => {
    const executor = executionTools();
    const planner = plannerTools();
    for (const name of ['inspect_file_context', 'investigate_issue', 'verify_change']) {
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
  it('rolls back already-applied files when a later change fails', async () => {
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
    expect(result).toContain('Error: change set failed at b.txt');
    expect(result).toContain('Rolled back: a.txt');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('two\n');
  });

  it('applies an ordered change set with per-file status', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf-8');
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
    expect(result).toContain('- a.txt [edit] ok');
    expect(result).toContain('- new.txt [create] ok');
    expect(result).toContain('Error: change set failed at old.txt');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('one\n');
    await expect(fs.stat(path.join(root, 'new.txt'))).rejects.toThrow();
  });
});

describe('fix_in_file', () => {
  it('reports before and after diagnostics for the file', async () => {
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
    expect(result).toContain('Diagnostics before:');
    expect(result).toContain('broken.ts:1:7 [error] (ts) broken code');
    expect(result).toContain('Diagnostics after:');
    expect(result).toContain('(none)');
    expect(result).toContain('Summary: 1 resolved, 0 new.');
    expect(await fs.readFile(target, 'utf-8')).toBe('const fixed = 1;\n');
  });

  it('fails cleanly when the patch does not match', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one\n', 'utf-8');
    const result = await toolbox().execute(
      'fix_in_file',
      JSON.stringify({ path: 'a.txt', patch: '@@\n-missing\n+changed' }),
      context,
    );
    expect(result).toContain('Error:');
    expect(result).toContain('Could not locate');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('one\n');
  });
});

describe('add_import_and_use', () => {
  it('falls back to textual import insertion when no code action exists', async () => {
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
        patch: '@@\n-const result = value;\n+const result = value();',
      }),
      context,
    );
    expect(result).toContain("Inserted: import { value } from './values';");
    const content = await fs.readFile(path.join(root, 'use.ts'), 'utf-8');
    expect(content.startsWith("import { value } from './values';\n")).toBe(true);
    expect(content).toContain('const result = value();');
  });
});

describe('rename_symbol', () => {
  it('falls back to a word-boundary textual rename with a warning', async () => {
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
      JSON.stringify({ path: 'greet.ts', line: 1, character: 7, newName: 'count' }),
      context,
    );
    expect(result).toContain('Renamed symbol to count.');
    expect(result).toContain('language server rename was unavailable');
    const content = await fs.readFile(target, 'utf-8');
    expect(content).toBe('const count = 1;\nreturn count;\n');
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
    expect(result).toContain('Found 12 candidate files');
    expect(result).toContain('Re-call with confirm: true');
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
    expect(result).toContain('Updated 12/12 files');
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
    expect(result).toContain('Extracted compute in main.ts.');
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
    expect(result).toContain('Moved helper from a.ts to b.ts.');
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
    expect(failed).toContain('The source change was rolled back.');
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
    expect(result).toContain('# verify_change (diagnostics)');
    expect(result).not.toContain('## Command');
  });
});
