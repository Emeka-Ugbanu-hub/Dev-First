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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-finish-gate-test' } }],
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

import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolCall } from '../src/llm/types';
import type { HostMessage, Plan, TerminalApprovalDecision } from '../src/shared/protocol';
import type { ToolBox } from '../src/agent/ToolBox';
import { AgentService } from '../src/agent/AgentService';
import type { AgentOptions, FinishCheckSummary } from '../src/agent/AgentService';
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
  const toolCall: ToolCall = { id: `call-${name}-${Math.random().toString(36).slice(2, 6)}`, name, arguments: JSON.stringify(args) };
  return { type: 'toolCall', toolCall };
}

function planArgs(): Plan {
  return { version: 1, status: 'draft', intent: 'plan', title: 'Finish gate', steps: ['Do the thing'] };
}

function callbacks() {
  return {
    onTextDelta: () => undefined,
    onToolActivity: () => undefined,
    requestTerminalApproval: async () => 'deny' as TerminalApprovalDecision,
  };
}

const COMPACT = 'Finish check:\nAction required: finish step: "Do the thing"';

function gateFailure() {
  return { ok: false as const, issues: ['unfinished step: "Do the thing"'], compact: COMPACT };
}

function buildAgent(
  replies: StreamEvent[][],
  finishCheck?: AgentOptions['finishCheck'],
): { provider: ScriptedProvider; agent: AgentService } {
  const provider = new ScriptedProvider(replies);
  const toolbox = { execute: vi.fn(async () => 'ok') } as unknown as ToolBox;
  const agent = new AgentService(provider, 'gpt-test', toolbox, {
    maxSteps: 6,
    tools: executionTools(),
    autoCompact: false,
    contextLimitTokens: 128000,
    ...(finishCheck ? { finishCheck } : {}),
  });
  return { provider, agent };
}

function toolMessage(provider: ScriptedProvider, callIndex: number, content: string): ChatMessage | undefined {
  return provider.calls[callIndex].messages.find(
    (message) => message.role === 'tool' && message.content === content,
  );
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-test' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-finish-gate-test-home');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('AgentService finish gate', () => {
  it('accepts a consistent finish immediately with no extra model call', async () => {
    const finishCheck = vi.fn(() => ({ ok: true as const }));
    const { provider, agent } = buildAgent([[toolCallEvent('finish', { summary: 'Done.' })]], finishCheck);
    const notices: string[] = [];

    const result = await agent.run(planArgs(), 'do it', new AbortController().signal, {
      ...callbacks(),
      onNotice: (text) => notices.push(text),
    });

    expect(result).toEqual({ summary: 'Done.', files: undefined, reachedLimit: false });
    expect(provider.calls).toHaveLength(1);
    expect(finishCheck).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it('passes the run summary of changed files and tool failures to the gate', async () => {
    let received: FinishCheckSummary | undefined;
    const finishCheck = vi.fn((summary: FinishCheckSummary) => {
      received = summary;
      return { ok: true as const };
    });
    const provider = new ScriptedProvider([
      [toolCallEvent('write_file', { path: 'src/a.ts', content: 'x' })],
      [toolCallEvent('read_file', { path: 'src/missing.ts' })],
      [toolCallEvent('finish', { summary: 'Done.' })],
    ]);
    const toolbox = {
      execute: vi.fn(async (name: string) => (name === 'read_file' ? 'Error: src/missing.ts does not exist.' : 'ok')),
    } as unknown as ToolBox;
    const agent = new AgentService(provider, 'gpt-test', toolbox, {
      maxSteps: 6,
      tools: executionTools(),
      autoCompact: false,
      contextLimitTokens: 128000,
      finishCheck,
    });

    await agent.run(planArgs(), 'do it', new AbortController().signal, callbacks());

    expect(received?.changedFiles).toEqual([{ path: 'src/a.ts', delivered: true }]);
    expect(received?.recentToolFailures).toEqual(['read_file: src/missing.ts does not exist.']);
    expect(received?.diagnosticsAvailable).toBe(false);
    expect(received?.verificationRan).toEqual([]);
  });

  it('returns the compact correction once, then accepts the next finish as incomplete', async () => {
    const finishCheck = vi.fn(gateFailure);
    const { provider, agent } = buildAgent(
      [
        [toolCallEvent('finish', { summary: 'First.' })],
        [toolCallEvent('finish', { summary: 'Second.' })],
      ],
      finishCheck,
    );
    const notices: string[] = [];

    const result = await agent.run(planArgs(), 'do it', new AbortController().signal, {
      ...callbacks(),
      onNotice: (text) => notices.push(text),
    });

    expect(provider.calls).toHaveLength(2);
    expect(finishCheck).toHaveBeenCalledTimes(2);
    expect(toolMessage(provider, 1, COMPACT)).toBeDefined();
    expect(result.summary).toBe('Second.');
    expect(result.incomplete).toEqual({
      issues: ['unfinished step: "Do the thing"'],
      compact: COMPACT,
    });
    expect(notices).toEqual(['Run ended incomplete — unfinished step: "Do the thing"']);
  });

  it('accepts the finish after the single correction when the gate passes', async () => {
    const finishCheck = vi.fn().mockReturnValueOnce(gateFailure()).mockReturnValueOnce({ ok: true });
    const { provider, agent } = buildAgent(
      [
        [toolCallEvent('finish', { summary: 'First.' })],
        [toolCallEvent('finish', { summary: 'Second.' })],
      ],
      finishCheck,
    );
    const notices: string[] = [];

    const result = await agent.run(planArgs(), 'do it', new AbortController().signal, {
      ...callbacks(),
      onNotice: (text) => notices.push(text),
    });

    expect(provider.calls).toHaveLength(2);
    expect(toolMessage(provider, 1, COMPACT)).toBeDefined();
    expect(result.incomplete).toBeUndefined();
    expect(result.summary).toBe('Second.');
    expect(notices).toEqual([]);
  });

  it('resets the continuation counter per run', async () => {
    const finishCheck = vi.fn(gateFailure);
    const { provider, agent } = buildAgent(
      [
        [toolCallEvent('finish', { summary: 'a' })],
        [toolCallEvent('finish', { summary: 'a2' })],
        [toolCallEvent('finish', { summary: 'b' })],
        [toolCallEvent('finish', { summary: 'b2' })],
      ],
      finishCheck,
    );

    const first = await agent.run(planArgs(), 'do it', new AbortController().signal, callbacks());
    const second = await agent.run(planArgs(), 'do it', new AbortController().signal, callbacks());

    expect(provider.calls).toHaveLength(4);
    expect(finishCheck).toHaveBeenCalledTimes(4);
    expect(toolMessage(provider, 1, COMPACT)).toBeDefined();
    expect(toolMessage(provider, 3, COMPACT)).toBeDefined();
    expect(first.incomplete).toBeDefined();
    expect(second.incomplete).toBeDefined();
  });

  it('keeps the old behavior when no finish check is configured', async () => {
    const { provider, agent } = buildAgent([[toolCallEvent('finish', { summary: 'Done.' })]]);
    const result = await agent.run(planArgs(), 'do it', new AbortController().signal, callbacks());
    expect(provider.calls).toHaveLength(1);
    expect(result).toEqual({ summary: 'Done.', files: undefined, reachedLimit: false });
  });
});

function memoryState(): { store: Map<string, unknown>; get: (key: string) => unknown; update: (key: string, value: unknown) => Promise<void> } {
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
    extensionUri: { fsPath: '/tmp/dev-first-finish-gate-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-finish-gate-${Math.random().toString(36).slice(2)}` },
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

describe('SessionController incomplete finish', () => {
  it('adds the incomplete line to the finish summary', async () => {
    const posted: HostMessage[] = [];
    const { controller } = createController(posted);
    vi.spyOn(AgentService.prototype, 'run').mockResolvedValue({
      reachedLimit: false,
      summary: 'Done.',
      incomplete: { issues: ['unfinished step: "Do the thing"'], compact: COMPACT },
    });
    (controller as unknown as { plan: Plan | null }).plan = planArgs();

    await controller.handleMessage({ type: 'approvePlan' });

    const completion = posts(posted, 'addMessage')
      .map((message) => message.message)
      .find((message) => message.kind === 'completion');
    expect(completion?.text).toContain('Done.');
    expect(completion?.text).toContain('Run ended incomplete — unfinished step: "Do the thing"');
    controller.dispose();
  });
});
