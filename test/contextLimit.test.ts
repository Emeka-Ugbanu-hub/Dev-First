import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-context-limit-test' } }],
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

import type { AgentOptions } from '../src/agent/AgentService';
import { AgentService } from '../src/agent/AgentService';
import { checkCompaction } from '../src/agent/compaction';
import type { ChatMessage } from '../src/llm/types';
import { SessionController } from '../src/session/SessionController';
import type { HostMessage } from '../src/shared/protocol';

function createController(posted: HostMessage[]): SessionController {
  const storage = `/tmp/dev-first-context-limit-${Math.random().toString(36).slice(2)}`;
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-context-limit-test' },
    globalStorageUri: { fsPath: storage },
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

function captureExecutorOptions(): () => AgentOptions | undefined {
  let captured: AgentOptions | undefined;
  vi.spyOn(AgentService.prototype, 'run').mockImplementation(async function (this: AgentService) {
    captured = (this as unknown as { options: AgentOptions }).options;
    return { reachedLimit: false };
  });
  return () => captured;
}

function openAiToolSse(name: string, args: Record<string, unknown>): string {
  const chunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

function anthropicToolSse(name: string, args: Record<string, unknown>): string {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${name}`, name } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function stubFetch(responses: string[]): void {
  let index = 0;
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).includes('models.dev')) {
      return new Response('{}', { status: 200 });
    }
    const response = responses[index++] ?? responses[responses.length - 1];
    return new Response(response, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

function posts<T extends HostMessage['type']>(posted: HostMessage[], type: T) {
  return posted.filter((message): message is Extract<HostMessage, { type: T }> => message.type === type);
}

beforeEach(() => {
  env.config = {};
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-context-limit-test-home');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('effective context window', () => {
  it('uses the catalog contextWindow for UI state, usage, and the executor', async () => {
    env.config = { preset: 'anthropic', model: 'claude-fable-5', contextLimitTokens: 128000 };
    stubFetch([
      anthropicToolSse('submit_plan', { intent: 'plan', trivial: true, steps: ['Rename the flag'] }),
    ]);
    const captured = captureExecutorOptions();
    const posted: HostMessage[] = [];
    const controller = createController(posted);

    await controller.handleMessage({ type: 'sendMessage', text: 'rename the flag' });

    const usage = controller.getState().contextUsage;
    expect(usage.limit).toBe(1_000_000);
    expect(usage.reserved).toBe(128_000);
    expect(captured()?.contextLimitTokens).toBe(1_000_000);
    const postedUsage = posts(posted, 'usage');
    expect(postedUsage.length).toBeGreaterThan(0);
    expect(postedUsage.every((message) => message.limit === 1_000_000)).toBe(true);

    controller.newSession();
    await vi.waitFor(() => {
      expect(
        posts(posted, 'usage').some((message) => message.tokens === 0 && message.limit === 1_000_000),
      ).toBe(true);
    });
    controller.dispose();
  });

  it('uses a 200k catalog window for state and the executor', async () => {
    env.config = { preset: 'openai', model: 'o1', contextLimitTokens: 128000 };
    stubFetch([openAiToolSse('submit_plan', { intent: 'plan', trivial: true, steps: ['Do it'] })]);
    const captured = captureExecutorOptions();
    const controller = createController([]);

    await controller.handleMessage({ type: 'sendMessage', text: 'do it' });

    expect(controller.getState().contextUsage.limit).toBe(200_000);
    expect(controller.getState().contextUsage.reserved).toBe(100_000);
    expect(captured()?.contextLimitTokens).toBe(200_000);
    controller.dispose();
  });

  it('falls back to the setting for an unknown model', () => {
    env.config = { preset: 'openai', model: 'unknown-model-xyz', contextLimitTokens: 64_000 };
    const controller = createController([]);

    const usage = controller.getState().contextUsage;
    expect(usage.limit).toBe(64_000);
    expect(usage.reserved).toBe(8192);
    controller.dispose();
  });

  it('prefers registry metadata over the setting for reserved output and limit', () => {
    env.config = { preset: 'anthropic', model: 'claude-opus-4-1', contextLimitTokens: 64_000 };
    const controller = createController([]);

    const usage = controller.getState().contextUsage;
    expect(usage.limit).toBe(200_000);
    expect(usage.reserved).toBe(32_000);
    controller.dispose();
  });

  it('drives compaction from the same effective limit as the UI', async () => {
    env.config = { preset: 'anthropic', model: 'claude-fable-5', contextLimitTokens: 128000 };
    stubFetch([anthropicToolSse('submit_plan', { intent: 'plan', trivial: true, steps: ['Do it'] })]);
    const captured = captureExecutorOptions();
    const controller = createController([]);

    await controller.handleMessage({ type: 'sendMessage', text: 'do it' });

    const uiLimit = controller.getState().contextUsage.limit;
    const executorLimit = captured()?.contextLimitTokens;
    expect(executorLimit).toBe(uiLimit);

    const bulky: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'x'.repeat(800_000) },
    ];
    expect(checkCompaction(bulky, executorLimit as number).needed).toBe(false);
    expect(checkCompaction(bulky, env.config.contextLimitTokens as number).needed).toBe(true);
    controller.dispose();
  });
});
