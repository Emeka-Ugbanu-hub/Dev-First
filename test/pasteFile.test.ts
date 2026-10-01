import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
  root: '',
}));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => env.config[key] ?? fallback,
        update: async () => undefined,
      }),
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
      workspaceFolders: [
        {
          uri: {
            get fsPath() {
              return env.root;
            },
          },
        },
      ],
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

import type { ChatMessage } from '../src/llm/types';
import { PlannerService } from '../src/planner/PlannerService';
import { SessionController } from '../src/session/SessionController';
import type { HostMessage, UiMessage } from '../src/shared/protocol';

function createController(posted: HostMessage[]): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-paste-file-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-paste-file-storage-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => false,
    setRunContext: () => undefined,
    setFileSummaries: () => undefined,
  } as never;
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

function longText(count = 121): string {
  return Array.from({ length: count }, (_, index) => `line ${index}`).join('\n');
}

beforeEach(() => {
  env.root = `/tmp/dev-first-paste-file-${Math.random().toString(36).slice(2)}`;
  env.config = { preset: 'openai', model: 'gpt-4o', pasteFileLines: 120 };
  env.secret = 'sk-test';
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await fs.rm(env.root, { recursive: true, force: true });
});

describe('SessionController paste files', () => {
  it('exposes pasteFileLines in the ui state', () => {
    const controller = createController([]);
    expect(controller.getState().pasteFileLines).toBe(120);
    env.config.pasteFileLines = 40;
    expect(controller.getState().pasteFileLines).toBe(40);
  });

  it('writes pastes to .dev-first/pastes and appends a reference', async () => {
    vi.spyOn(PlannerService.prototype, 'plan').mockResolvedValue({ text: 'ok', exhausted: false });
    const controller = createController([]);
    const big = longText();

    await (
      controller as unknown as {
        handleSend: (
          text: string,
          selection?: undefined,
          quote?: undefined,
          images?: undefined,
          pastes?: Array<{ id: string; text: string }>,
        ) => Promise<void>;
      }
    ).handleSend('review this', undefined, undefined, undefined, [{ id: 'paste_alpha', text: big }]);

    const dir = path.join(env.root, '.dev-first', 'pastes');
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^paste-\d+-paste_alpha\.txt$/);
    expect(await fs.readFile(path.join(dir, files[0]), 'utf-8')).toBe(big);

    const conversation = (controller as unknown as { conversation: ChatMessage[] }).conversation;
    const user = String(conversation.find((message) => message.role === 'user')?.content ?? '');
    expect(user).toContain('review this');
    expect(user).toContain(`Pasted content saved to .dev-first/pastes/${files[0]} — read it if needed.`);
  });

  it('carries pastes on queued messages and passes them through on dequeue', async () => {
    const plan = vi.spyOn(PlannerService.prototype, 'plan').mockResolvedValue({ text: 'ok', exhausted: false });
    const controller = createController([]);
    const big = longText(130);

    (controller as unknown as { phase: string }).phase = 'executing';
    await controller.handleMessage({
      type: 'sendMessage',
      text: 'steer this',
      pastes: [{ id: 'paste_beta', text: big }],
    });

    const queued = (
      controller as unknown as {
        queuedMessages: Array<{ text: string; pastes?: Array<{ id: string; text: string }> }>;
      }
    ).queuedMessages;
    expect(queued).toHaveLength(1);
    expect(queued[0].pastes).toEqual([{ id: 'paste_beta', text: big }]);
    expect(queued[0].text).toContain('Pasted content saved to .dev-first/pastes/');

    const uiMessages = (controller as unknown as { uiMessages: UiMessage[] }).uiMessages;
    expect(uiMessages.find((message) => message.queued)?.pastes).toEqual([{ id: 'paste_beta', text: big }]);

    (controller as unknown as { phase: string }).phase = 'idle';
    (controller as unknown as { processNextQueued: () => void }).processNextQueued();
    await vi.waitFor(() => {
      expect(plan).toHaveBeenCalledTimes(1);
      const conversation = (controller as unknown as { conversation: ChatMessage[] }).conversation;
      const user = String(conversation.find((message) => message.role === 'user')?.content ?? '');
      expect((user.match(/Pasted content saved to /g) ?? []).length).toBe(1);
      expect(user).toContain('steer this');
    });

    const files = await fs.readdir(path.join(env.root, '.dev-first', 'pastes'));
    expect(files.filter((file) => file.includes('paste_beta'))).toHaveLength(1);
  });

  it('removes paste files older than seven days on startup', async () => {
    const dir = path.join(env.root, '.dev-first', 'pastes');
    await fs.mkdir(dir, { recursive: true });
    const oldFile = path.join(dir, 'paste-1-old.txt');
    await fs.writeFile(oldFile, 'old', 'utf-8');
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFile, stale, stale);

    createController([]);

    await vi.waitFor(async () => {
      expect(await fs.readdir(dir).catch(() => [])).not.toContain('paste-1-old.txt');
    });
  });
});
