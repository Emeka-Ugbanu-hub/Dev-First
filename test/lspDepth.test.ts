import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ commands: undefined as string[] | undefined }));
const calls = vi.hoisted(
  () => [] as Array<{ command: string; position?: { line: number; character: number } }>,
);

vi.mock('vscode', () => ({
  commands: {
    executeCommand: async (command: string, _uri: unknown, position?: { line: number; character: number }) => {
      calls.push({ command, position });
      switch (command) {
        case 'vscode.executeHoverProvider':
          return [{ contents: [{ value: '**docs** for run()' }] }];
        case 'vscode.executeImplementationProvider':
          return [{ uri: { fsPath: '/w/impl.ts' }, range: { start: { line: 4, character: 2 } } }];
        case 'vscode.prepareCallHierarchy':
          return [{ name: 'run', uri: { fsPath: '/w/a.ts' }, range: { start: { line: 0, character: 0 } } }];
        case 'vscode.provideIncomingCalls':
          return [{ from: { name: 'caller', uri: { fsPath: '/w/b.ts' }, range: { start: { line: 9, character: 1 } } } }];
        case 'vscode.provideOutgoingCalls':
          return [{ to: { name: 'callee', uri: { fsPath: '/w/c.ts' }, range: { start: { line: 2, character: 3 } } } }];
        default:
          return undefined;
      }
    },
    getCommands: async () =>
      env.commands ?? [
        'vscode.executeHoverProvider',
        'vscode.executeImplementationProvider',
        'vscode.prepareCallHierarchy',
        'vscode.provideIncomingCalls',
        'vscode.provideOutgoingCalls',
      ],
  },
  workspace: { asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace('/w/', '') },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
}));

import {
  goToImplementation,
  hoverAt,
  incomingCalls,
  outgoingCalls,
  toZeroBased,
} from '../src/agent/lspTools';

afterEach(() => {
  env.commands = undefined;
  calls.length = 0;
});

describe('position conversion', () => {
  it('converts 1-based line and character to 0-based', () => {
    expect(toZeroBased(3, 5)).toEqual({ line: 2, character: 4 });
    expect(toZeroBased('2', '1')).toEqual({ line: 1, character: 0 });
  });

  it('rejects missing or invalid positions', () => {
    expect(toZeroBased(undefined, 1)).toBeUndefined();
    expect(toZeroBased('soon', 1)).toBeUndefined();
  });
});

describe('hover', () => {
  it('passes a 0-based position and formats the hover text', async () => {
    const result = await hoverAt('/w/a.ts', 3, 5);
    expect(result).toContain('**docs** for run()');
    const call = calls.find((entry) => entry.command === 'vscode.executeHoverProvider');
    expect(call?.position).toEqual({ line: 2, character: 4 });
  });

  it('gates on language server availability', async () => {
    env.commands = ['vscode.executeHoverProvider'];
    const result = await goToImplementation('/w/a.ts', 3, 5);
    expect(result).toContain('no language server is available');
    expect(result).toContain('vscode.executeImplementationProvider');
  });
});

describe('go to implementation', () => {
  it('lists implementations with 1-based output positions', async () => {
    const result = await goToImplementation('/w/a.ts', 1, 1);
    expect(result).toBe('impl.ts:5:3');
  });
});

describe('call hierarchy', () => {
  it('lists incoming calls', async () => {
    const result = await incomingCalls('/w/a.ts', 1, 1);
    expect(result).toBe('b.ts:10:2 — caller');
  });

  it('lists outgoing calls', async () => {
    const result = await outgoingCalls('/w/a.ts', 1, 1);
    expect(result).toBe('c.ts:3:4 — callee');
  });
});
