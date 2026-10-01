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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-exact-usage-test' } }],
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

import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  StreamEvent,
  ToolCall,
  UsageTotals,
} from '../src/llm/types';
import type { HostMessage, Plan, TerminalApprovalDecision } from '../src/shared/protocol';
import type { ToolBox } from '../src/agent/ToolBox';
import { AgentService } from '../src/agent/AgentService';
import { PlannerService } from '../src/planner/PlannerService';
import { executionTools } from '../src/agent/tools';
import { SessionController } from '../src/session/SessionController';

class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];

  constructor(private readonly replies: StreamEvent[][]) {}

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push({ messages, options });
    for (const event of this.replies.shift() ?? []) {
      yield event;
    }
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async embed(): Promise<number[][]> {
    return [];
  }
}

function toolCallEvent(name: string, args: Record<string, unknown>): StreamEvent {
  const toolCall: ToolCall = { id: `call-${name}`, name, arguments: JSON.stringify(args) };
  return { type: 'toolCall', toolCall };
}

function planArgs(): Plan {
  return { version: 1, status: 'draft', intent: 'plan', title: 'Add retry handling', steps: ['Add a retry helper'] };
}

function memoryState(): {
  store: Map<string, unknown>;
  get: (key: string) => unknown;
  update: (key: string, value: unknown) => Promise<void>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    get: (key) => store.get(key),
    update: async (key, value) => {
      store.set(key, value);
    },
  };
}

function createController(posted: HostMessage[]): { controller: SessionController } {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-exact-usage-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-exact-usage-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: memoryState(),
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => false,
    setRunContext: () => undefined,
    setFileSummaries: () => undefined,
  } as never;
  return { controller: new SessionController(context, (message) => posted.push(message), diffManager) };
}

function posts<T extends HostMessage['type']>(posted: HostMessage[], type: T) {
  return posted.filter((message): message is Extract<HostMessage, { type: T }> => message.type === type);
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-test' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-exact-usage-test-home');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('exact usage accumulation', () => {
  it('merges usage events from a single AgentService provider call', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'usage', inputTokens: 100, cachedTokens: 5 },
        { type: 'usage', outputTokens: 20, reasoningTokens: 7 },
        toolCallEvent('set_reasoning', { level: 'low' }),
      ],
      [toolCallEvent('finish', { summary: 'Done.' })],
    ]);
    const usages: UsageTotals[] = [];
    const agent = new AgentService(
      provider,
      'gpt-test',
      { execute: vi.fn(async () => 'ok') } as unknown as ToolBox,
      { maxSteps: 3, tools: executionTools(), autoCompact: false, contextLimitTokens: 128000 },
    );

    const result = await agent.run(planArgs(), 'do it', new AbortController().signal, {
      onTextDelta: () => undefined,
      onToolActivity: () => undefined,
      requestTerminalApproval: async () => 'deny' as TerminalApprovalDecision,
      setReasoning: () => 'ok',
      onUsageExact: (usage) => usages.push(usage),
    });

    expect(result.summary).toBe('Done.');
    expect(usages).toEqual([{ input: 100, output: 20, reasoning: 7, cached: 5 }]);
  });

  it('reports planner usage through onUsageExact', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'usage', inputTokens: 50 },
        { type: 'usage', outputTokens: 5, cachedTokens: 2 },
        { type: 'text', text: 'Noted.' },
      ],
    ]);
    const usages: UsageTotals[] = [];
    await new PlannerService(provider, 'gpt-test', { maxSteps: 1, tools: [] }).plan(
      [{ role: 'user', content: 'hi' }],
      null,
      1,
      {
        onTextDelta: () => undefined,
        onToolActivity: () => undefined,
        executeTool: async () => 'ok',
        onUsageExact: (usage) => usages.push(usage),
      },
      new AbortController().signal,
    );

    expect(usages).toEqual([{ input: 50, output: 5, reasoning: 0, cached: 2 }]);
  });

  it('does not emit onUsageExact when the provider reports no usage', async () => {
    const provider = new ScriptedProvider([[{ type: 'text', text: 'plain' }]]);
    const usages: UsageTotals[] = [];
    await new PlannerService(provider, 'gpt-test', { maxSteps: 1, tools: [] }).plan(
      [{ role: 'user', content: 'hi' }],
      null,
      1,
      {
        onTextDelta: () => undefined,
        onToolActivity: () => undefined,
        executeTool: async () => 'ok',
        onUsageExact: (usage) => usages.push(usage),
      },
      new AbortController().signal,
    );

    expect(usages).toEqual([]);
  });
});

describe('SessionController exact usage preference', () => {
  it('prefers exact totals over estimates and falls back when cleared', () => {
    const { controller } = createController([]);
    const ctrl = controller as unknown as {
      lastExactUsage?: UsageTotals;
      reportUsage(tokens: number): void;
      reportExactUsage(usage: UsageTotals): void;
    };

    ctrl.reportExactUsage({ input: 1000, output: 200, reasoning: 100, cached: 50 });
    expect(controller.getState().contextUsage.tokens).toBe(1350);

    ctrl.reportUsage(999_999);
    expect(controller.getState().contextUsage.tokens).toBe(1350);

    ctrl.lastExactUsage = undefined;
    ctrl.reportUsage(5000);
    expect(controller.getState().contextUsage.tokens).toBe(5000);
    controller.dispose();
  });

  it('posts exact totals in usage messages', () => {
    const posted: HostMessage[] = [];
    const { controller } = createController(posted);
    const ctrl = controller as unknown as { reportExactUsage(usage: UsageTotals): void };

    ctrl.reportExactUsage({ input: 10, output: 20, reasoning: 30, cached: 40 });

    const usage = posts(posted, 'usage').at(-1);
    expect(usage?.tokens).toBe(100);
    controller.dispose();
  });

  it('clears exact usage on a new user turn and records the fresh call', async () => {
    const posted: HostMessage[] = [];
    const { controller } = createController(posted);
    const ctrl = controller as unknown as { lastExactUsage?: UsageTotals };
    ctrl.lastExactUsage = { input: 10, output: 20, reasoning: 30, cached: 40 };

    let duringPlan: UsageTotals | undefined;
    vi.spyOn(PlannerService.prototype, 'plan').mockImplementation(async (_conversation, _plan, _version, callbacks) => {
      duringPlan = ctrl.lastExactUsage;
      callbacks.onUsageExact?.({ input: 1, output: 2, reasoning: 3, cached: 4 });
      return { text: 'ok', exhausted: false };
    });

    await controller.handleMessage({ type: 'sendMessage', text: 'hi' });

    expect(duringPlan).toBeUndefined();
    expect(ctrl.lastExactUsage).toEqual({ input: 1, output: 2, reasoning: 3, cached: 4 });
    expect(controller.getState().contextUsage.tokens).toBe(10);
    controller.dispose();
  });

  it('clears exact usage on a new session', async () => {
    const { controller } = createController([]);
    const ctrl = controller as unknown as { lastExactUsage?: UsageTotals };
    ctrl.lastExactUsage = { input: 10, output: 20, reasoning: 30, cached: 40 };

    controller.newSession();
    await vi.waitFor(() => {
      expect(ctrl.lastExactUsage).toBeUndefined();
    });
    controller.dispose();
  });
});
