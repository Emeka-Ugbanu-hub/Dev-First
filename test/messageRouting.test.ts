import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent } from '../src/llm/types';
import type { DurableTaskState } from '../src/shared/protocol';
import { classifyMessageRoute } from '../src/session/messageRouting';

class RouterProvider implements LLMProvider {
  readonly id = 'router';
  readonly calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];

  constructor(
    private readonly mode?: 'skip' | 'lite' | 'spec' | 'full',
    private readonly intent: 'question' | 'change' | 'conversation' = mode ? 'change' : 'question',
  ) {}

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push({ messages, options });
    const route = this.mode ? { route: 'new-task', mode: this.mode, intent: this.intent } : { route: 'question', intent: this.intent };
    yield {
      type: 'toolCall',
      toolCall: { id: 'route', name: 'classify_route', arguments: JSON.stringify(route) },
    };
  }

  async listModels(): Promise<string[]> { return []; }
  async embed(): Promise<number[][]> { return []; }
}

const state: DurableTaskState = {
  taskId: 'task',
  state: 'idle',
  taskSummary: '',
  completedSteps: [],
  nextSteps: [],
  blockers: [],
  lastHeartbeatAt: 0,
};

describe('classifyMessageRoute', () => {
  it('returns a planning mode for change requests', async () => {
    const decision = await classifyMessageRoute(new RouterProvider('lite'), 'model', 'add a retry', state, null);
    expect(decision).toEqual({ route: 'new-task', mode: 'lite', response: undefined, intent: 'change' });
  });

  it('keeps an inspection-only request out of planning', async () => {
    const provider = new RouterProvider('lite', 'question');
    const decision = await classifyMessageRoute(
      provider,
      'model',
      'Inspect the codebase and determine how to run it locally. Read the manifests. Output install: <cmd> and run: <cmd>.',
      state,
      null,
    );
    expect(decision?.route).toBe('question');
    expect(decision?.mode).toBeUndefined();
  });

  it('does not require a mode for questions', async () => {
    const decision = await classifyMessageRoute(new RouterProvider(), 'model', 'what does this do?', state, null);
    expect(decision).toEqual({ route: 'question', response: undefined, intent: 'question' });
  });

  it('infers intent when a small model omits it', async () => {
    const provider: LLMProvider = {
      id: 'no-intent',
      async *chat() {
        yield {
          type: 'toolCall',
          toolCall: {
            id: 'route',
            name: 'classify_route',
            arguments: JSON.stringify({ route: 'question' }),
          },
        };
      },
      async listModels() { return []; },
      async embed() { return []; },
    };

    const decision = await classifyMessageRoute(provider, 'model', 'what does this do?', state, null);

    expect(decision).toEqual({ route: 'question', response: undefined, intent: 'question' });
  });

  it('sends continuation state to the structured route probe', async () => {
    const provider = new RouterProvider();
    await classifyMessageRoute(provider, 'model', 'continue', state, null, undefined, undefined, {
      continuationKind: 'answer',
      continuationStatus: 'truncated',
      lastAnswerStatus: 'truncated',
      lastAnswerQuestion: 'Explain the request flow',
    });
    const request = provider.calls[0].messages[1]?.content;
    expect(request).toContain('"kind":"answer"');
    expect(request).toContain('"status":"truncated"');
    expect(request).toContain('Explain the request flow');
  });
});
