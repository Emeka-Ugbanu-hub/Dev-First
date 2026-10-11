import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import type { ChatMessage } from '../src/llm/types';
import type { Plan } from '../src/shared/protocol';
import type { SessionContextEntry, StoredSession } from '../src/session/SessionStore';
import { SessionStore } from '../src/session/SessionStore';
import {
  buildContextEntry,
  decisionContextMetadata,
  diagnosticsContextMetadata,
  mergeContextMetadata,
  mutationContextMetadata,
  planContextMetadata,
  toolContextMetadata,
} from '../src/session/contextIndex';

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
        update: async () => undefined,
      }),
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-context-test' } }],
      asRelativePath: (value: string) => value,
    },
    window: {
      onDidChangeTextEditorSelection: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      visibleTextEditors: [],
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
    },
    commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
    ConfigurationTarget: { Global: 1 },
  };
});

import { SessionController } from '../src/session/SessionController';

afterEach(() => {
  vi.restoreAllMocks();
});

function session(id: string, conversation: ChatMessage[]): StoredSession {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    conversation,
    plan: null,
    todos: [],
    planVersion: 0,
    lastRequest: '',
    contextTokens: 0,
  };
}

function plan(version: number): Plan {
  return { version, status: 'draft', title: 'Fix parser', steps: ['Read parser', 'Patch parser'] };
}

function createController(): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-context-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-context-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => undefined, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: new Map(),
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => false,
    setRunContext: () => undefined,
    setFileSummaries: () => undefined,
  } as never;
  return new SessionController(context, () => undefined, diffManager);
}

describe('structured context metadata', () => {
  it('extracts files, symbols, tool names, and command summaries from JSON tool args', () => {
    const write = toolContextMetadata('write_file', JSON.stringify({ path: 'src/parser.ts' }));
    expect(write.toolNames).toEqual(['write_file']);
    expect(write.files).toEqual(['src/parser.ts']);

    const rename = toolContextMetadata('rename_symbol', JSON.stringify({ path: 'src/a.ts', symbol: 'parseThing' }));
    expect(rename.symbols).toEqual(['parseThing']);

    const command = toolContextMetadata('run_terminal_command', JSON.stringify({ command: 'npm test' }));
    expect(command.summary).toBe('run_terminal_command: npm test');

    const prose = toolContextMetadata('read_file', 'not json');
    expect(prose).toEqual({ toolNames: ['read_file'] });
  });

  it('does not fall back to regex when structured args are available', () => {
    const update = toolContextMetadata('write_file', JSON.stringify({ file: 'src/actual.ts' }));
    const entry = buildContextEntry({ role: 'tool', content: 'ok' }, 0, update);
    expect(entry.files).toEqual(['src/actual.ts']);
    expect(entry.files).not.toContain('content.ts');
  });

  it('derives plan step ids and version summaries from submitted plans', () => {
    const update = planContextMetadata(plan(3));
    expect(update.planStepIds).toEqual(['0', '1']);
    expect(update.summary).toBe('plan v3: Fix parser');
  });

  it('derives decision ids and mutation files from structured events', () => {
    expect(decisionContextMetadata({ id: 'q-1', kind: 'question', prompt: 'Which file?', createdAt: 1 }).decisionIds).toEqual(['q-1']);
    expect(mutationContextMetadata(['src/a.ts', 'src/b.ts']).files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('summarizes diagnostics availability as an error count', () => {
    expect(diagnosticsContextMetadata({ diagnosticsAvailable: true, newDiagnosticErrors: 2 }).summary).toBe('2 errors');
    expect(diagnosticsContextMetadata({ diagnosticsAvailable: true, newDiagnosticErrors: 1 }).summary).toBe('1 error');
    expect(diagnosticsContextMetadata({ diagnosticsAvailable: false, newDiagnosticErrors: 5 })).toEqual({});
  });

  it('merges structured updates into an appended entry', () => {
    const message: ChatMessage = { role: 'user', content: 'please update the parser' };
    const entry = buildContextEntry(message, 0);
    expect(entry.files).toEqual([]);
    mergeContextMetadata(entry, { files: ['src/parser.ts'], toolNames: ['edit_file'], planStepIds: ['1'] });
    expect(entry.files).toEqual(['src/parser.ts']);
    expect(entry.toolNames).toEqual(['edit_file']);
    expect(entry.planStepIds).toEqual(['1']);
  });
});

describe('SessionStore context sidecar', () => {
  it('persists the sidecar and rebuilds it when missing or corrupt', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-context-'));
    try {
      const store = new SessionStore(dir);
      const conversation: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'work on src/a.ts' }];
      const entries = [buildContextEntry(conversation[0], 0, { files: ['src/a.ts'] })];
      await store.save(session('a', conversation), entries);

      const loaded = await store.loadContext('a');
      expect(loaded.active).toHaveLength(1);
      expect(loaded.active[0].messageId).toBe('u1');
      expect(loaded.active[0].files).toEqual(['src/a.ts']);

      await writeFile(path.join(dir, 'a.context.json'), '{ corrupt', 'utf-8');
      const repaired = await store.loadContext('a');
      expect(repaired.active).toHaveLength(1);
      expect(repaired.active[0].messageId).toBe('u1');
      expect(repaired.active[0].files).toEqual(['src/a.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps structured metadata for messages moved into archives', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-context-'));
    try {
      const store = new SessionStore(dir, 1000);
      const conversation = Array.from({ length: 24 }, (_, index) => ({
        id: `m-${index}`,
        role: 'user' as const,
        content: `message ${index} ${'x'.repeat(200)}`,
      }));
      const entries = conversation.map((message, index) =>
        buildContextEntry(message, index, index === 0 ? { files: ['src/old.ts'], toolNames: ['write_file'] } : undefined),
      );
      await store.save(session('a', conversation), entries);

      const context = await store.loadContext('a');
      expect(context.archived[0].messageId).toBe('m-0');
      expect(context.archived[0].files).toEqual(['src/old.ts']);
      expect(context.archived[0].toolNames).toEqual(['write_file']);
      expect(context.active.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SessionController append-time metadata', () => {
  it('assigns stable ids and attaches structured tool metadata to the last entry', () => {
    const controller = createController();
    const ctrl = controller as unknown as {
      conversation: ChatMessage[];
      contextIndex: SessionContextEntry[];
      appendConversation(message: ChatMessage): SessionContextEntry;
      recordToolCallContext(name: string, argsJson: string): void;
      recordContextMetadata(update: Parameters<typeof mergeContextMetadata>[1]): void;
    };
    ctrl.appendConversation({ role: 'user', content: 'update the parser' });
    const id = ctrl.conversation[0].id;
    expect(id).toBeTruthy();
    expect(ctrl.contextIndex[0].messageId).toBe(id);
    expect(ctrl.contextIndex[0].hash).toBeTruthy();

    ctrl.recordToolCallContext('write_file', JSON.stringify({ path: 'src/parser.ts' }));
    expect(ctrl.contextIndex[0].files).toContain('src/parser.ts');
    expect(ctrl.contextIndex[0].toolNames).toContain('write_file');

    ctrl.recordContextMetadata(planContextMetadata(plan(2)));
    expect(ctrl.contextIndex[0].planStepIds).toEqual(['0', '1']);
    expect(ctrl.contextIndex[0].summary).toBe('plan v2: Fix parser');

    controller.dispose();
  });

  it('buffers structured metadata until a conversation message exists', () => {
    const controller = createController();
    const ctrl = controller as unknown as {
      conversation: ChatMessage[];
      contextIndex: SessionContextEntry[];
      appendConversation(message: ChatMessage): SessionContextEntry;
      recordContextMetadata(update: Parameters<typeof mergeContextMetadata>[1]): void;
    };
    ctrl.recordContextMetadata({ files: ['src/buffered.ts'] });
    ctrl.appendConversation({ role: 'user', content: 'work on it' });
    expect(ctrl.contextIndex[0].files).toContain('src/buffered.ts');
    controller.dispose();
  });
});
