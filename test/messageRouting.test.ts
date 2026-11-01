import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent } from '../src/llm/types';
import type { DurableTaskState } from '../src/shared/protocol';
import { classifyMessageRoute } from '../src/session/messageRouting';

class RouterProvider implements LLMProvider {
  readonly id = 'router';
  readonly calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];

  constructor(private readonly mode?: 'skip' | 'lite' | 'spec' | 'full') {}

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push({ messages, options });
    const route = this.mode ? { route: 'new-task', mode: this.mode } : { route: 'question' };
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
    expect(decision).toEqual({ route: 'new-task', mode: 'lite', response: undefined });
  });

  it('does not require a mode for questions', async () => {
    const decision = await classifyMessageRoute(new RouterProvider(), 'model', 'what does this do?', state, null);
    expect(decision).toEqual({ route: 'question', response: undefined });
  });
});
