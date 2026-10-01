import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LLMProvider, ReasoningOptions, StreamEvent, ToolDef } from '../src/llm/types';
import type { Plan } from '../src/shared/protocol';
import { PlannerService, PlannerCallbacks } from '../src/planner/PlannerService';

class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly calls: Array<{ messages: ChatMessage[]; tools: ToolDef[]; reasoning?: ReasoningOptions }> = [];

  constructor(private readonly replies: StreamEvent[][]) {}

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push({ messages, tools: options.tools ?? [], reasoning: options.reasoning });
    const reply = this.replies.shift() ?? [];
    for (const event of reply) yield event;
  }

  async listModels(): Promise<string[]> { return []; }
  async embed(): Promise<number[][]> { return []; }
}

const call = (name: string, args: Record<string, unknown>): StreamEvent => ({
  type: 'toolCall',
  toolCall: { id: `call-${name}`, name, arguments: JSON.stringify(args) },
});

const draftPlan: Plan = {
  version: 1,
  status: 'draft',
  intent: 'plan',
  what: 'Add retry handling',
  steps: ['Add a retry helper'],
};

function callbacks(toolResults: string[] = [], text: string[] = [], reasoning: string[] = []): PlannerCallbacks {
  return {
    onTextDelta: (delta) => text.push(delta),
    onReasoningDelta: (delta) => reasoning.push(delta),
    onToolActivity: () => undefined,
    executeTool: async (tool) => {
      toolResults.push(tool.name);
      return tool.name === 'ask_user' ? 'Please update the login page.' : 'File contents';
    },
  };
}

function planner(provider: ScriptedProvider, reasoning?: ReasoningOptions): PlannerService {
  return new PlannerService(provider, 'test-model', {
    maxSteps: 4,
    tools: [{ name: 'read_file', description: 'Read files', parameters: { type: 'object', properties: {} } },
      { name: 'ask_user', description: 'Ask a question', parameters: { type: 'object', properties: {} } }],
    reasoning,
  });
}

const request: ChatMessage[] = [{ role: 'user', content: 'What does index.html do?' }];

describe('PlannerService single-turn intent handling', () => {
  it('keeps a greeting as the active request when earlier turns and a draft exist', async () => {
    const provider = new ScriptedProvider([[{ type: 'text', text: 'Hi! What can I help with?' }]]);
    const history: ChatMessage[] = [
      { role: 'user', content: 'Delete dead code and find learning resources.' },
      { role: 'assistant', content: 'I will inspect the files and prepare a plan.' },
      { role: 'user', content: 'hi' },
    ];
    const executedTools: string[] = [];

    const result = await planner(provider, { enabled: true, effort: 'max' }).plan(
      history,
      draftPlan,
      2,
      callbacks(executedTools),
      new AbortController().signal,
    );

    expect(result.text).toBe('Hi! What can I help with?');
    expect(result.plan).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].reasoning).toEqual({ enabled: true, effort: 'max' });
    expect(provider.calls[0].messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
    expect(provider.calls[0].messages[0].content).toContain(
      'Respond to the latest user message; use earlier messages only when they help answer it or it refers to earlier work.',
    );
    expect(executedTools).toEqual([]);
    expect(provider.calls[0].tools.map((tool) => tool.name)).toContain('submit_plan');
  });

  it('handles a greeting plus a task as a task in the same selected-model call', async () => {
    const provider = new ScriptedProvider([[call('submit_plan', { what: 'Fix X', steps: ['Fix X'] })]]);
    const result = await planner(provider, { enabled: true, effort: 'max' }).plan(
      [{ role: 'user', content: 'hi, now fix X' }], null, 1, callbacks(), new AbortController().signal,
    );

    expect(result.plan?.what).toBe('Fix X');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].reasoning).toEqual({ enabled: true, effort: 'max' });
    expect(provider.calls[0].messages[0].content).toContain('If a greeting also includes a question or task, handle that request');
  });

  it('answers a supplied code snippet directly without automatically inspecting callers', async () => {
    const provider = new ScriptedProvider([[{ type: 'text', text: 'It gets the Tauri IPC bridge, returns if it is unavailable, then invokes the native window minimize command.' }]]);
    const executedTools: string[] = [];
    const snippetRequest: ChatMessage[] = [{ role: 'user', content: "Explain this code — how it works and anything subtle:\n\nexport async function minimizeWindow(): Promise<void> {\n  const ipc = getIPC();\n  if (!ipc) return;\n  await ipc.invoke('plugin:window|minimize');\n}" }];
    const result = await planner(provider, { enabled: true, effort: 'max' }).plan(
      snippetRequest, null, 1, callbacks(executedTools), new AbortController().signal,
    );

    expect(result.text).toContain('Tauri IPC bridge');
    expect(result.plan).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].reasoning).toEqual({ enabled: true, effort: 'max' });
    expect(executedTools).toEqual([]);
    expect(provider.calls[0].messages[0].content).toContain('use a supplied snippet when it is sufficient');
  });

  it('streams reasoning and answers a question in the first selected-model call, even with an open draft', async () => {
    const provider = new ScriptedProvider([[
      { type: 'reasoning', text: 'This is a question about the file.' },
      { type: 'text', text: 'It is the app entry point.' },
    ]]);
    const text: string[] = [];
    const reasoning: string[] = [];
    const result = await planner(provider, { enabled: true, effort: 'high' }).plan(request, draftPlan, 2, callbacks([], text, reasoning), new AbortController().signal);

    expect(result.plan).toBeUndefined();
    expect(result.text).toBe('It is the app entry point.');
    expect(reasoning).toEqual(['This is a question about the file.']);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].reasoning).toEqual({ enabled: true, effort: 'high' });
    expect(provider.calls[0].messages[0].content).toContain('Questions (simple, deep, or follow-up) NEVER call submit_plan');
  });

  it('submits a requested change in the first call', async () => {
    const provider = new ScriptedProvider([[call('submit_plan', { what: 'Add a health endpoint', steps: ['Add the endpoint'] })]]);
    const result = await planner(provider).plan(request, null, 1, callbacks(), new AbortController().signal);

    expect(result.plan?.what).toBe('Add a health endpoint');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].tools.map((tool) => tool.name)).toContain('submit_plan');
    expect(provider.calls[0].tools.map((tool) => tool.name)).toContain('dismiss_plan');
  });

  it('cancels an open draft in the first call', async () => {
    const provider = new ScriptedProvider([[call('dismiss_plan', {})]]);
    const result = await planner(provider).plan(request, draftPlan, 2, callbacks(), new AbortController().signal);

    expect(result.dismissed).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it('submits a complete revised plan for a draft update', async () => {
    const provider = new ScriptedProvider([[call('submit_plan', {
      what: 'Add retry handling and logging',
      steps: ['Add a retry helper', 'Add logging'],
    })]]);
    const result = await planner(provider).plan(
      [{ role: 'user', content: 'also add logging' }], draftPlan, 3, callbacks(), new AbortController().signal,
    );

    expect(result.plan?.version).toBe(3);
    expect(result.plan?.steps).toEqual(['Add a retry helper', 'Add logging']);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].messages[0].content).toContain('Current plan:');
  });

  it('asks for clarification, then continues with the user answer without a routing pass', async () => {
    const provider = new ScriptedProvider([
      [call('ask_user', { question: 'Do you want an explanation or a code change?', header: 'Clarify request' })],
      [call('submit_plan', { what: 'Update the login page', steps: ['Update the page'] })],
    ]);
    const toolResults: string[] = [];
    const result = await planner(provider).plan(request, null, 1, callbacks(toolResults), new AbortController().signal);

    expect(toolResults).toEqual(['ask_user']);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].messages.some((message) => message.role === 'tool' && message.content === 'Please update the login page.')).toBe(true);
    expect(result.plan?.what).toBe('Update the login page');
  });
});
