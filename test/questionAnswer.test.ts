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
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-answer-test' } }],
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

import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent } from '../src/llm/types';
import { estimateRequestTokens, requestBudget } from '../src/llm/contextFit';
import { SessionController } from '../src/session/SessionController';
import type { HostMessage, UiMessage } from '../src/shared/protocol';

function createController(posted: HostMessage[] = []): SessionController {
  const storage = `/tmp/dev-first-answer-test-${Math.random().toString(36).slice(2)}`;
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-answer-test' },
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
  return new SessionController(context, (message: HostMessage) => { posted.push(message); }, diffManager);
}

function fakeProvider(responses: StreamEvent[][]) {
  let index = 0;
  const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  const provider: LLMProvider = {
    id: 'test',
    chat: (messages, options) => (async function* () {
      calls.push({ messages: messages.map((message) => ({ ...message })), options: { ...options } });
      const events = responses[index++] ?? [];
      yield* events;
    })(),
    listModels: async () => [],
    embed: async () => [],
  };
  return { provider, calls };
}

function tool(name: string, args: Record<string, unknown>, id: string): StreamEvent {
  return { type: 'toolCall', toolCall: { id, name, arguments: JSON.stringify(args) } };
}

function text(value: string): StreamEvent {
  return { type: 'text', text: value };
}

function userMessage(): UiMessage {
  return { id: 'msg_user', role: 'user', text: 'where does execution begin?' };
}

function answer(
  controller: SessionController,
  provider: LLMProvider,
): Promise<{ answered: boolean; notice?: string }> {
  return (controller as unknown as {
    answerQuestionDirectly(
      provider: LLMProvider,
      text: string,
      message: UiMessage,
      images: string[],
    ): Promise<{ answered: boolean; notice?: string }>;
  }).answerQuestionDirectly(provider, 'where does execution begin?', userMessage(), []);
}

beforeEach(() => {
  env.config = {
    preset: 'ollama',
    model: 'unknown-local-model-xyz',
    contextLimitTokens: 262144,
    localContextCapTokens: 0,
  };
  env.secret = undefined;
  vi.stubEnv('HOME', '/tmp/dev-first-answer-test-home');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('answer mode final turn', () => {
  it('publishes an answering phase, provider reasoning, and visible tool activity', async () => {
    const posted: HostMessage[] = [];
    const { provider } = fakeProvider([
      [{ type: 'reasoning', text: 'I need the project index.' }, tool('list_files', { path: '.' }, 'call_trace')],
      [text('The answer is ready.')],
    ]);
    const controller = createController(posted);

    const outcome = await answer(controller, provider);

    expect(outcome.answered).toBe(true);
    expect(posted.some((message) => message.type === 'phase' && message.phase === 'answering')).toBe(true);
    expect(posted.some((message) => message.type === 'reasoningDelta' && message.text.includes('project index'))).toBe(true);
    const activity = [...posted].reverse().find((message) => message.type === 'activity' && message.activity.id === 'call_trace');
    expect(activity?.type).toBe('activity');
    if (activity?.type === 'activity') {
      expect(activity.activity.status).toBe('done');
      expect(activity.activity.durationMs).toEqual(expect.any(Number));
    }
    controller.dispose();
  });

  it('keeps reading until the model answers and never sends an output cap', async () => {
    const { provider, calls } = fakeProvider([
      [tool('list_files', { path: '.' }, 'call_1')],
      [tool('list_files', { path: '.' }, 'call_2')],
      [text('Execution starts in src/main.ts, which mounts the router.')],
    ]);
    const controller = createController();

    const outcome = await answer(controller, provider);

    expect(outcome.answered).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0].options.tools).toBeDefined();
    expect(calls[1].options.tools).toBeDefined();
    expect(calls[2].options.tools).toBeDefined();
    expect(calls.every((call) => call.options.maxTokens === undefined)).toBe(true);
    expect(controller.getState().messages.some((message) =>
      message.role === 'assistant' && message.text.includes('src/main.ts'),
    )).toBe(true);
    controller.dispose();
  });

  it('keeps a 4,096-token local answer and follow-up read inside the window', async () => {
    env.config = {
      preset: 'ollama',
      model: 'unknown-local-model-xyz',
      contextLimitTokens: 4096,
      localContextCapTokens: 0,
    };
    const { provider, calls } = fakeProvider([
      [tool('list_files', { path: '.' }, 'call_1')],
      [text('Execution starts in src/main.ts.')],
    ]);
    const controller = createController();

    const outcome = await answer(controller, provider);

    expect(outcome.answered).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.options.contextTokens === 4096)).toBe(true);
    for (const call of calls) {
      expect(estimateRequestTokens(call.messages, call.options))
        .toBeLessThanOrEqual(requestBudget(4096, call.options));
    }
    expect(calls[1].messages.some((message) => message.role === 'tool')).toBe(true);
    controller.dispose();
  });

  it('automatically continues a length-stopped answer and appends it to the same message', async () => {
    const { provider, calls } = fakeProvider([
      [text('Part one. '), { type: 'done', reason: 'length' }],
      [text('Part two.'), { type: 'done', reason: 'stop' }],
    ]);
    const controller = createController();

    const outcome = await answer(controller, provider);

    expect(outcome.answered).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].options.maxTokens).toBeUndefined();
    expect(calls[1].options.maxTokens).toBeUndefined();
    expect(calls[1].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Continue the answer'),
    });
    const assistants = controller.getState().messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('Part one. Part two.');
    expect((controller as unknown as { snapshotSession(): { lastAnswer?: { status: string } } })
      .snapshotSession().lastAnswer?.status).toBe('complete');
    expect((controller as unknown as { snapshotSession(): { continuation?: { kind: string; status: string } } })
      .snapshotSession().continuation).toMatchObject({ kind: 'answer', status: 'complete' });
    controller.dispose();
  });

  it('resumes the latest answer for a continuation message instead of routing a new task', async () => {
    const first = fakeProvider([
      [text('Part one. '), { type: 'done', reason: 'length' }],
      [text('Part two.'), { type: 'done', reason: 'stop' }],
    ]);
    const controller = createController();
    await answer(controller, first.provider);

    const second = fakeProvider([
      [text(' Part three.'), { type: 'done', reason: 'stop' }],
    ]);
    (controller as unknown as { buildProvider(): Promise<LLMProvider> }).buildProvider = async () => second.provider;

    await (controller as unknown as { handleSend(text: string): Promise<void> }).handleSend('continue');

    expect(second.calls).toHaveLength(1);
    expect(second.calls[0].options.maxTokens).toBeUndefined();
    expect(second.calls[0].messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Continue the answer'),
    });
    const conversation = (controller as unknown as { conversation: ChatMessage[] }).conversation;
    expect(conversation.some(
      (message) => message.role === 'user' && message.content.trim() === 'continue',
    )).toBe(false);
    const assistants = controller.getState().messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].text).toBe('Part one. Part two. Part three.');
    controller.dispose();
  });

  it('reports the files read when the final turn is still empty', async () => {
    const { provider } = fakeProvider([
      [tool('read_file', { path: 'src/missing.ts' }, 'call_1')],
      [tool('read_file', { path: 'src/other.ts' }, 'call_2')],
      [],
    ]);
    const controller = createController();

    const outcome = await answer(controller, provider);

    expect(outcome.answered).toBe(false);
    expect(outcome.notice).toContain('did not produce a final answer');
    expect(outcome.notice).toContain('src/missing.ts');
    expect(controller.getState().messages.some((message) => message.streaming)).toBe(false);
    controller.dispose();
  });
});
