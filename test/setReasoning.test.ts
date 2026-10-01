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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-set-reasoning-test' } }],
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
  ReasoningOptions,
  StreamEvent,
  ToolCall,
} from '../src/llm/types';
import type { HostMessage, Plan, TerminalApprovalDecision } from '../src/shared/protocol';
import type { ToolBox } from '../src/agent/ToolBox';
import { AgentService } from '../src/agent/AgentService';
import { PlannerService, type PlannerCallbacks } from '../src/planner/PlannerService';
import { executionTools, plannerToolSet, setReasoningTool, toolIcon } from '../src/agent/tools';
import { clampReasoningLevel } from '../src/llm/catalog';
import { buildExecutorSystemPrompt, buildPlannerSystemPrompt } from '../src/planner/prompts';
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

function createController(
  posted: HostMessage[],
  globalState = memoryState(),
): { controller: SessionController; globalState: ReturnType<typeof memoryState> } {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-set-reasoning-test' },
    globalStorageUri: { fsPath: `/tmp/dev-first-set-reasoning-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState,
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => false,
    setRunContext: () => undefined,
    setFileSummaries: () => undefined,
  } as never;
  return { controller: new SessionController(context, (message) => posted.push(message), diffManager), globalState };
}

function setPlan(controller: SessionController, plan: Plan | null): void {
  (controller as unknown as { plan: Plan | null }).plan = plan;
}

function reasoningOptionsOf(controller: SessionController): ReasoningOptions | undefined {
  return (controller as unknown as {
    reasoningOptions(supported: boolean, presetId: string): ReasoningOptions | undefined;
  }).reasoningOptions(true, 'openai');
}

function setRunReasoning(controller: SessionController, level: string): string {
  return (controller as unknown as {
    setRunReasoning(level: string): string;
  }).setRunReasoning(level);
}

function reasoningChangesOf(controller: SessionController): number {
  return (controller as unknown as { reasoningChanges: number }).reasoningChanges;
}

beforeEach(() => {
  env.config = { preset: 'openai', model: 'gpt-5.6' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-set-reasoning-test-home');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('set_reasoning tool schema', () => {
  it('is present in the planner and executor tool sets', () => {
    expect(plannerToolSet([]).map((tool) => tool.name)).toContain('set_reasoning');
    expect(executionTools().map((tool) => tool.name)).toContain('set_reasoning');
    expect(setReasoningTool.parameters.required).toEqual(['level']);
    const properties = setReasoningTool.parameters.properties as Record<string, { type: string }>;
    expect(properties.level.type).toBe('string');
    expect(properties.persist).toBeUndefined();
    expect(setReasoningTool.description).toContain('subsequent calls in this run');
    expect(setReasoningTool.description).not.toContain('persist');
    expect(toolIcon('set_reasoning')).toBe('settings-gear');
  });

  it('is hidden when the model has fewer than two selectable levels', () => {
    expect(plannerToolSet([], { reasoningSwitch: false }).map((tool) => tool.name)).not.toContain('set_reasoning');
    expect(executionTools({ reasoningSwitch: false }).map((tool) => tool.name)).not.toContain('set_reasoning');
    expect(plannerToolSet([], { reasoningSwitch: true }).map((tool) => tool.name)).toContain('set_reasoning');
    expect(executionTools({ reasoningSwitch: true }).map((tool) => tool.name)).toContain('set_reasoning');
  });

  it('is advertised to the planner and executor during real runs', async () => {
    const plannerProvider = new ScriptedProvider([[{ type: 'text', text: 'Nothing to plan.' }]]);
    await new PlannerService(plannerProvider, 'gpt-5.6', { maxSteps: 1, tools: [] }).plan(
      [{ role: 'user', content: 'hi' }],
      null,
      1,
      {
        onTextDelta: () => undefined,
        onToolActivity: () => undefined,
        executeTool: async () => 'ok',
      },
      new AbortController().signal,
    );
    expect(plannerProvider.calls[0].options.tools?.map((tool) => tool.name)).toContain('set_reasoning');

    const executorProvider = new ScriptedProvider([[toolCallEvent('finish', { summary: 'Done.' })]]);
    const tools = executionTools();
    const agent = new AgentService(
      executorProvider,
      'gpt-5.6',
      { execute: vi.fn(async () => 'ok') } as unknown as ToolBox,
      { maxSteps: 2, tools, autoCompact: false, contextLimitTokens: 128000 },
    );
    await agent.run(planArgs(), 'do it', new AbortController().signal, {
      onTextDelta: () => undefined,
      onToolActivity: () => undefined,
      requestTerminalApproval: async () => 'deny' as TerminalApprovalDecision,
    });
    expect(executorProvider.calls[0].options.tools?.map((tool) => tool.name)).toContain('set_reasoning');
  });
});

describe('reasoning override clamping', () => {
  const levels = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

  it('keeps a level at or below the ceiling and clamps everything else', () => {
    expect(clampReasoningLevel('low', 'medium', levels)).toBe('low');
    expect(clampReasoningLevel('max', 'medium', levels)).toBe('medium');
    expect(clampReasoningLevel('xhigh', 'medium', levels)).toBe('medium');
    expect(clampReasoningLevel('none', 'medium', levels)).toBe('medium');
    expect(clampReasoningLevel('auto', 'medium', levels)).toBe('medium');
    expect(clampReasoningLevel('on', 'medium', levels)).toBe('medium');
    expect(clampReasoningLevel('bogus', 'medium', levels)).toBe('medium');
  });

  it('treats off as the lowest level when the model supports it', () => {
    expect(clampReasoningLevel('off', 'medium', ['off', 'low', 'medium'])).toBe('off');
    expect(clampReasoningLevel('off', 'on', ['off', 'on'])).toBe('on');
  });
});

describe('SessionController reasoning override', () => {
  it('rejects an invalid level with the valid list and leaves the selection unchanged', () => {
    const { controller } = createController([]);
    const result = setRunReasoning(controller, 'bogus');
    expect(result).toContain('invalid reasoning level "bogus"');
    expect(result).toContain('none, low, medium, high, xhigh, max');
    expect((controller as unknown as { reasoningOverride?: string }).reasoningOverride).toBeUndefined();
    expect(reasoningOptionsOf(controller)).toEqual({ enabled: true, effort: 'medium' });
    controller.dispose();
  });

  it('applies a valid level to subsequent reasoning options', () => {
    const { controller } = createController([]);
    expect(setRunReasoning(controller, 'low')).toBe('Reasoning effort set to low for this run.');
    expect((controller as unknown as { reasoningOverride?: string }).reasoningOverride).toBe('low');
    expect(reasoningOptionsOf(controller)).toEqual({ enabled: true, effort: 'low' });
    controller.dispose();
  });

  it('clamps an override above the developer ceiling to the ceiling', () => {
    const { controller } = createController([]);
    const result = setRunReasoning(controller, 'max');
    expect(result).toContain('Reasoning effort set to medium for this run.');
    expect(reasoningOptionsOf(controller)).toEqual({ enabled: true, effort: 'medium' });
    controller.dispose();
  });

  it('clears a non-persisted override when the executor run finishes', async () => {
    const posted: HostMessage[] = [];
    const { controller } = createController(posted);
    let duringRun: ReasoningOptions | undefined;
    const run = vi.spyOn(AgentService.prototype, 'run').mockImplementation(async (_plan, _request, _signal, callbacks) => {
      callbacks.setReasoning?.('low');
      duringRun = reasoningOptionsOf(controller);
      return { reachedLimit: false };
    });
    setPlan(controller, planArgs());

    await controller.handleMessage({ type: 'approvePlan' });

    expect(run).toHaveBeenCalledTimes(1);
    expect(duringRun).toEqual({ enabled: true, effort: 'low' });
    expect((controller as unknown as { reasoningOverride?: string }).reasoningOverride).toBeUndefined();
    expect(reasoningOptionsOf(controller)).toEqual({ enabled: true, effort: 'medium' });
    controller.dispose();
  });

  it('caps changes at five per run and does not apply the sixth', () => {
    const { controller } = createController([]);
    for (let index = 0; index < 5; index++) {
      expect(setRunReasoning(controller, 'low')).toBe('Reasoning effort set to low for this run.');
    }
    expect(reasoningChangesOf(controller)).toBe(5);
    expect(setRunReasoning(controller, 'low')).toBe('Error: reasoning effort can change at most 5 times per run.');
    expect(reasoningChangesOf(controller)).toBe(5);
    expect((controller as unknown as { reasoningOverride?: string }).reasoningOverride).toBe('low');
    controller.dispose();
  });

  it('resets the change counter when the run finishes', async () => {
    const posted: HostMessage[] = [];
    const { controller } = createController(posted);
    for (let index = 0; index < 5; index++) {
      setRunReasoning(controller, 'low');
    }
    vi.spyOn(AgentService.prototype, 'run').mockImplementation(async () => ({ reachedLimit: false }));
    setPlan(controller, planArgs());

    await controller.handleMessage({ type: 'approvePlan' });

    expect(reasoningChangesOf(controller)).toBe(0);
    expect(setRunReasoning(controller, 'low')).toBe('Reasoning effort set to low for this run.');
    controller.dispose();
  });

  it('reverts the planner override when the planning run finishes', async () => {
    const posted: HostMessage[] = [];
    const { controller } = createController(posted);
    let duringRun: ReasoningOptions | undefined;
    vi.spyOn(PlannerService.prototype, 'plan').mockImplementation(async (_conversation, _plan, _version, callbacks) => {
      callbacks.setReasoning?.('low');
      duringRun = reasoningOptionsOf(controller);
      return { text: 'Nothing to plan.', exhausted: false };
    });

    await controller.handleMessage({ type: 'sendMessage', text: 'say hi' });

    expect(duringRun).toEqual({ enabled: true, effort: 'low' });
    expect((controller as unknown as { reasoningOverride?: string }).reasoningOverride).toBeUndefined();
    expect(reasoningOptionsOf(controller)).toEqual({ enabled: true, effort: 'medium' });
    controller.dispose();
  });
});

describe('PlannerService set_reasoning interception', () => {
  it('does not execute the tool, reports through the callback, and applies the change to later turns', async () => {
    const provider = new ScriptedProvider([
      [toolCallEvent('set_reasoning', { level: 'low' })],
      [{ type: 'text', text: 'Noted.' }],
    ]);
    const executed: string[] = [];
    let current: ReasoningOptions | undefined = { enabled: true, effort: 'medium' };
    const setReasoning = vi.fn((level: string) => {
      current = { enabled: true, effort: level };
      return `Reasoning effort set to ${level} for this run.`;
    });
    const callbacks: PlannerCallbacks = {
      onTextDelta: () => undefined,
      onToolActivity: () => undefined,
      executeTool: async (call) => {
        executed.push(call.name);
        return 'ok';
      },
      setReasoning,
    };
    const planner = new PlannerService(provider, 'gpt-5.6', {
      maxSteps: 3,
      tools: [],
      resolveReasoning: () => current,
    });

    const result = await planner.plan([{ role: 'user', content: 'do work' }], null, 1, callbacks, new AbortController().signal);

    expect(setReasoning).toHaveBeenCalledWith('low');
    expect(executed).toEqual([]);
    expect(provider.calls[0].options.reasoning).toEqual({ enabled: true, effort: 'medium' });
    expect(provider.calls[1].options.reasoning).toEqual({ enabled: true, effort: 'low' });
    expect(
      provider.calls[1].messages.some(
        (message) => message.role === 'tool' && message.content === 'Reasoning effort set to low for this run.',
      ),
    ).toBe(true);
    expect(result.text).toBe('Noted.');
  });
});

describe('AgentService set_reasoning interception', () => {
  it('does not send the tool to the toolbox, reports through the callback, and applies the change to later calls', async () => {
    const provider = new ScriptedProvider([
      [toolCallEvent('set_reasoning', { level: 'low' })],
      [toolCallEvent('finish', { summary: 'Done.' })],
    ]);
    const execute = vi.fn(async () => 'ok');
    const toolbox = { execute } as unknown as ToolBox;
    let current: ReasoningOptions | undefined = { enabled: true, effort: 'medium' };
    const setReasoning = vi.fn((level: string) => {
      current = { enabled: true, effort: level };
      return `Reasoning effort set to ${level} for this run.`;
    });
    const agent = new AgentService(provider, 'gpt-5.6', toolbox, {
      maxSteps: 4,
      tools: executionTools(),
      autoCompact: false,
      contextLimitTokens: 128000,
      resolveReasoning: () => current,
    });

    const result = await agent.run(planArgs(), 'do it', new AbortController().signal, {
      onTextDelta: () => undefined,
      onToolActivity: () => undefined,
      requestTerminalApproval: async () => 'deny' as TerminalApprovalDecision,
      setReasoning,
    });

    expect(setReasoning).toHaveBeenCalledWith('low');
    expect(execute).not.toHaveBeenCalled();
    expect(provider.calls[0].options.reasoning).toEqual({ enabled: true, effort: 'medium' });
    expect(provider.calls[1].options.reasoning).toEqual({ enabled: true, effort: 'low' });
    expect(
      provider.calls[1].messages.some(
        (message) => message.role === 'tool' && message.content === 'Reasoning effort set to low for this run.',
      ),
    ).toBe(true);
    expect(result.summary).toBe('Done.');
  });
});

describe('reasoning replay', () => {
  it('accumulates executor reasoning onto tool-call turns without exposing it as text', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'reasoning', text: 'weigh ' },
        { type: 'reasoning', text: 'options' },
        { type: 'text', text: 'Working.' },
        toolCallEvent('set_reasoning', { level: 'low' }),
      ],
      [toolCallEvent('finish', { summary: 'Done.' })],
    ]);
    const textDeltas: string[] = [];
    let current: ReasoningOptions | undefined = { enabled: true, effort: 'medium' };
    const agent = new AgentService(provider, 'deepseek-reasoner', { execute: vi.fn(async () => 'ok') } as unknown as ToolBox, {
      maxSteps: 3,
      tools: executionTools(),
      autoCompact: false,
      contextLimitTokens: 128000,
      resolveReasoning: () => current,
    });

    const result = await agent.run(planArgs(), 'do it', new AbortController().signal, {
      onTextDelta: (delta) => textDeltas.push(delta),
      onReasoningDelta: () => undefined,
      onToolActivity: () => undefined,
      requestTerminalApproval: async () => 'deny' as TerminalApprovalDecision,
      setReasoning: (level) => {
        current = { enabled: true, effort: level };
        return 'ok';
      },
    });

    expect(textDeltas).toEqual(['Working.']);
    const assistant = provider.calls[1].messages.find(
      (message) => message.role === 'assistant' && message.toolCalls?.length,
    );
    expect(assistant?.reasoning).toBe('weigh options');
    expect(assistant?.content).toBe('Working.');
    expect(assistant?.content).not.toContain('weigh');
    expect(result.summary).toBe('Done.');
  });

  it('accumulates planner reasoning onto tool-call turns for replay', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'reasoning', text: 'plan ' },
        { type: 'reasoning', text: 'first' },
        toolCallEvent('set_reasoning', { level: 'low' }),
      ],
      [{ type: 'text', text: 'Noted.' }],
    ]);
    const planner = new PlannerService(provider, 'deepseek-reasoner', {
      maxSteps: 3,
      tools: [],
      resolveReasoning: () => ({ enabled: true, effort: 'medium' }),
    });

    const result = await planner.plan(
      [{ role: 'user', content: 'do work' }],
      null,
      1,
      {
        onTextDelta: () => undefined,
        onToolActivity: () => undefined,
        executeTool: async () => 'ok',
        setReasoning: () => 'ok',
      },
      new AbortController().signal,
    );

    const assistant = provider.calls[1].messages.find(
      (message) => message.role === 'assistant' && message.toolCalls?.length,
    );
    expect(assistant?.reasoning).toBe('plan first');
    expect(assistant?.content).toBe('');
    expect(result.text).toBe('Noted.');
  });
});

describe('self-adjusting reasoning prompts', () => {
  const discipline = [
    'Manage reasoning actively',
    'Downshift before trivial or routine work',
    'raise it for ambiguity, debugging, risky changes, or multi-step synthesis',
    'Reassess at turn start, after meaningful new evidence, and when the task shifts — never change it by inertia.',
    'Change only when it clearly pays',
    "when the task's character shifts, or after a failure",
    'Do not change it per step',
    "Never request a level above the developer's selected setting.",
  ];

  it('teaches the planner and executor the reasoning discipline', () => {
    for (const prompt of [buildPlannerSystemPrompt(), buildExecutorSystemPrompt()]) {
      for (const line of discipline) {
        expect(prompt).toContain(line);
      }
      expect(prompt).toContain('set_reasoning');
    }
  });

  it('keeps the anti-over-escalation rule intact', () => {
    expect(buildPlannerSystemPrompt()).toContain('do not invent work because the selected reasoning setting is high');
    expect(buildExecutorSystemPrompt()).toContain('Never narrate individual tool calls');
  });
});
