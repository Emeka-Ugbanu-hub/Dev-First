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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-compress-test' } }],
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
import { PlannerService } from '../src/planner/PlannerService';
import {
  PRESERVE_RECENT_TOKENS,
  chooseRecentStart,
  type CompressionBlock,
} from '../src/agent/compaction';
import { compressContextTool, executionTools, plannerToolSet, toolIcon } from '../src/agent/tools';
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

function bulkyConversation(count = 12): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < count; index++) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}: ${'x'.repeat(40_000)}`,
    });
  }
  return messages;
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

function createController(posted: HostMessage[] = []): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-compress-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-compress-${Math.random().toString(36).slice(2)}` },
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
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

interface ControllerInternals {
  conversation: ChatMessage[];
  compressionBlocks: CompressionBlock[];
  compressionsThisTurn: number;
  lastExactUsage?: unknown;
  buildProvider: () => Promise<LLMProvider | undefined>;
  compressContext(focus?: string): Promise<string>;
  projectedConversation(): ChatMessage[];
  snapshotSession(): Record<string, unknown>;
  applySession(stored: never): void;
}

function internals(controller: SessionController): ControllerInternals {
  return controller as unknown as ControllerInternals;
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-test' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-compress-test-home');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('compress_context tool schema', () => {
  it('is present in the planner and executor tool sets', () => {
    expect(plannerToolSet([]).map((tool) => tool.name)).toContain('compress_context');
    expect(executionTools().map((tool) => tool.name)).toContain('compress_context');
    expect(plannerToolSet([], { compressContext: false }).map((tool) => tool.name)).not.toContain('compress_context');
    expect(executionTools({ compressContext: false }).map((tool) => tool.name)).not.toContain('compress_context');
    const properties = compressContextTool.parameters.properties as Record<string, { type: string }>;
    expect(properties.focus.type).toBe('string');
    expect(compressContextTool.description).toContain('At most once per turn');
    expect(toolIcon('compress_context')).toBe('archive');
  });
});

describe('SessionController compressContext', () => {
  it('rejects folding when there is too little resolved conversation', async () => {
    const controller = createController();
    const ctrl = internals(controller);
    ctrl.conversation = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'yes' },
    ];

    const result = await ctrl.compressContext();

    expect(result).toContain('at least');
    expect(ctrl.compressionBlocks).toEqual([]);
    controller.dispose();
  });

  it('stores a summary block, honors the focus, and projects the compacted range', async () => {
    const controller = createController();
    const ctrl = internals(controller);
    const conversation = bulkyConversation();
    ctrl.conversation = conversation;
    const provider = new ScriptedProvider([[{ type: 'text', text: 'FOLDED SUMMARY' }]]);
    ctrl.buildProvider = async () => provider;
    const recentStart = chooseRecentStart(conversation, PRESERVE_RECENT_TOKENS);

    const result = await ctrl.compressContext('the auth refactor');

    expect(result).toBe(`Compressed ${recentStart} earlier messages into a summary.`);
    expect(ctrl.compressionBlocks).toHaveLength(1);
    const block = ctrl.compressionBlocks[0];
    expect(block.startIndex).toBe(0);
    expect(block.endIndex).toBe(recentStart);
    expect(block.summary).toBe('FOLDED SUMMARY');
    expect(block.active).toBe(true);
    expect(block.id).toBeTruthy();

    const summaryRequest = provider.calls[0].messages.map((message) => message.content).join('\n');
    expect(summaryRequest).toContain('Must preserve: the auth refactor');

    const projected = ctrl.projectedConversation();
    expect(projected[0]).toEqual({
      role: 'system',
      content: '[Compressed conversation section]\nFOLDED SUMMARY',
    });
    expect(projected.slice(1)).toEqual(conversation.slice(recentStart));
    expect(ctrl.conversation).toBe(conversation);
    controller.dispose();
  });

  it('allows only one compression per turn and resets the cap on send', async () => {
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    const ctrl = internals(controller);
    ctrl.conversation = bulkyConversation();
    ctrl.buildProvider = async () => new ScriptedProvider([[{ type: 'text', text: 'FIRST' }]]);

    await ctrl.compressContext();
    const second = await ctrl.compressContext();

    expect(second).toContain('at most once per turn');
    expect(ctrl.compressionBlocks).toHaveLength(1);

    vi.spyOn(PlannerService.prototype, 'plan').mockResolvedValue({ text: 'ok', exhausted: false });
    await controller.handleMessage({ type: 'sendMessage', text: 'keep going' });
    expect(ctrl.compressionsThisTurn).toBe(0);
    controller.dispose();
  });

  it('does not persist compression blocks, so a restart lapses them', async () => {
    const controller = createController();
    const ctrl = internals(controller);
    ctrl.conversation = bulkyConversation();
    ctrl.buildProvider = async () => new ScriptedProvider([[{ type: 'text', text: 'FOLDED' }]]);
    await ctrl.compressContext();
    expect(ctrl.compressionBlocks).toHaveLength(1);

    const stored = ctrl.snapshotSession();
    expect(stored.compressionBlocks).toBeUndefined();

    const fresh = createController();
    const freshCtrl = internals(fresh);
    freshCtrl.applySession(stored as never);

    expect(freshCtrl.compressionBlocks).toEqual([]);
    expect(freshCtrl.projectedConversation()).toEqual(freshCtrl.conversation);
    controller.dispose();
    fresh.dispose();
  });
});

describe('compress_context nudges', () => {
  function runAgent(
    replies: StreamEvent[][],
    options: { contextLimitTokens?: number } = {},
  ): { provider: ScriptedProvider; agent: AgentService } {
    const provider = new ScriptedProvider(replies);
    const toolbox = { execute: vi.fn(async () => 'ok') } as unknown as ToolBox;
    const agent = new AgentService(provider, 'gpt-test', toolbox, {
      maxSteps: replies.length,
      tools: executionTools(),
      autoCompact: false,
      contextLimitTokens: options.contextLimitTokens ?? 1_000_000,
    });
    return { provider, agent };
  }

  const callbacks = (compressContext?: () => Promise<string> | string) => ({
    onTextDelta: () => undefined,
    onToolActivity: () => undefined,
    requestTerminalApproval: async () => 'deny' as TerminalApprovalDecision,
    setReasoning: () => 'ok',
    ...(compressContext ? { compressContext } : {}),
  });

  function nudgeTexts(provider: ScriptedProvider, callIndex: number): string[] {
    return provider.calls[callIndex].messages
      .filter((message) => message.role === 'system' && message.content.includes('compress_context'))
      .map((message) => message.content);
  }

  it('nudges at 50% and uses the firm variant at 85%', async () => {
    const soft = runAgent(
      [
        [{ type: 'usage', inputTokens: 600_000 }, toolCallEvent('set_reasoning', { level: 'low' })],
        [toolCallEvent('finish', { summary: 'Done.' })],
      ],
    );
    await soft.agent.run(planArgs(), 'do it', new AbortController().signal, callbacks());
    const softNudges = nudgeTexts(soft.provider, 1);
    expect(softNudges).toHaveLength(1);
    expect(softNudges[0]).toContain('Context is ~60%');
    expect(softNudges[0]).toContain('call compress_context to fold it');

    const firm = runAgent(
      [
        [{ type: 'usage', inputTokens: 850_000 }, toolCallEvent('set_reasoning', { level: 'low' })],
        [toolCallEvent('finish', { summary: 'Done.' })],
      ],
    );
    await firm.agent.run(planArgs(), 'do it', new AbortController().signal, callbacks());
    const firmNudges = nudgeTexts(firm.provider, 1);
    expect(firmNudges).toHaveLength(1);
    expect(firmNudges[0]).toContain('Context is ~85%');
    expect(firmNudges[0]).toContain('call compress_context now');
  });

  it('does not nudge below the threshold', async () => {
    const { provider, agent } = runAgent(
      [
        [{ type: 'usage', inputTokens: 400_000 }, toolCallEvent('set_reasoning', { level: 'low' })],
        [toolCallEvent('finish', { summary: 'Done.' })],
      ],
    );
    await agent.run(planArgs(), 'do it', new AbortController().signal, callbacks());
    expect(nudgeTexts(provider, 1)).toEqual([]);
  });

  it('throttles nudges to once every five assistant turns', async () => {
    const read = (index: number): StreamEvent => toolCallEvent('read_file', { path: `file-${index}.ts` });
    const replies: StreamEvent[][] = [
      [{ type: 'usage', inputTokens: 600_000 }, read(0)],
      [read(1)],
      [read(2)],
      [read(3)],
      [read(4)],
      [read(5)],
      [toolCallEvent('finish', { summary: 'Done.' })],
    ];
    const { provider, agent } = runAgent(replies);
    await agent.run(planArgs(), 'do it', new AbortController().signal, callbacks());

    const nudges = provider.calls.map((_call, index) => nudgeTexts(provider, index).length);
    expect(nudges).toEqual([0, 1, 1, 1, 1, 1, 2]);
  });

  it('suppresses the nudge right after a compression block is created', async () => {
    const compress = vi.fn(async () => 'Compressed 3 earlier messages into a summary.');
    const { provider, agent } = runAgent(
      [
        [{ type: 'usage', inputTokens: 600_000 }, toolCallEvent('compress_context', { focus: 'auth' })],
        [toolCallEvent('set_reasoning', { level: 'low' })],
        [toolCallEvent('finish', { summary: 'Done.' })],
      ],
      { compressContext: compress },
    );

    await agent.run(planArgs(), 'do it', new AbortController().signal, callbacks(compress));

    expect(compress).toHaveBeenCalledWith('auth');
    expect(nudgeTexts(provider, 1)).toEqual([]);
    expect(nudgeTexts(provider, 2)).toEqual([]);
    expect(
      provider.calls[1].messages.some(
        (message) => message.role === 'tool' && message.content === 'Compressed 3 earlier messages into a summary.',
      ),
    ).toBe(true);
  });
});
