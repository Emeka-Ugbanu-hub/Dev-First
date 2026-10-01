import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolCall } from '../src/llm/types';
import { runSubagent, normalizeSubagentType, SUBAGENT_MAX_STEPS } from '../src/agent/subagent';
import { subagentTools, taskTool } from '../src/agent/tools';
import type { ToolBox } from '../src/agent/ToolBox';
import { ToolBox as RealToolBox } from '../src/agent/ToolBox';

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

class AbortProvider implements LLMProvider {
  readonly id = 'abort';

  async *chat(_messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    await new Promise<never>((_resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    });
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async embed(): Promise<number[][]> {
    return [];
  }
}

const toolbox = { execute: vi.fn(async () => 'file contents') } as unknown as ToolBox;

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, arguments: JSON.stringify(args) };
}

describe('subagent tools', () => {
  it('only exposes the read-only exploration tools, never task', () => {
    const names = subagentTools({ semanticSearch: true }).map((tool) => tool.name);
    expect(names).toEqual(['read_file', 'list_files', 'search_text', 'semantic_search']);
    expect(names).not.toContain('task');
  });

  it('normalizes the subagent type to explore by default', () => {
    expect(normalizeSubagentType(undefined)).toBe('explore');
    expect(normalizeSubagentType('  Explore ')).toBe('explore');
  });

  it('asks the toolbox for the task schema with a prompt and description', () => {
    expect(taskTool.parameters.required).toEqual(['description', 'prompt']);
    expect((taskTool.parameters.properties as Record<string, unknown>).subagent_type).toBeDefined();
  });
});

describe('runSubagent', () => {
  it('starts a fresh conversation containing only the prompt', async () => {
    const provider = new ScriptedProvider([[{ type: 'text', text: 'Nothing to see.' }]]);
    await runSubagent(
      { description: 'Explore auth', prompt: 'Find where auth is handled in this repo.' },
      {
        provider,
        model: 'test-model',
        toolbox,
        tools: subagentTools(),
        signal: new AbortController().signal,
      },
    );
    const messages = provider.calls[0].messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Find where auth is handled in this repo.');
    expect(JSON.stringify(messages)).not.toContain('PARENT_CONVERSATION_SECRET');
  });

  it('returns the final text after tool turns', async () => {
    const provider = new ScriptedProvider([
      [{ type: 'toolCall', toolCall: toolCall('read_file', { path: 'src/auth.ts' }) }],
      [{ type: 'text', text: 'Auth lives in src/auth.ts.' }],
    ]);
    const result = await runSubagent(
      { description: 'Explore auth', prompt: 'Find auth.' },
      {
        provider,
        model: 'test-model',
        toolbox,
        tools: subagentTools(),
        signal: new AbortController().signal,
      },
    );
    expect(result).toBe('Auth lives in src/auth.ts.');
    expect(provider.calls).toHaveLength(2);
    expect(SUBAGENT_MAX_STEPS).toBe(20);
  });

  it('rejects unknown subagent types', async () => {
    const provider = new ScriptedProvider([[{ type: 'text', text: 'hi' }]]);
    const result = await runSubagent(
      { description: 'Explore', prompt: 'Find auth.', subagentType: 'builder' },
      { provider, model: 'test-model', toolbox, tools: subagentTools(), signal: new AbortController().signal },
    );
    expect(result).toContain('unknown subagent type');
    expect(provider.calls).toHaveLength(0);
  });

  it('propagates the parent abort signal to the child', async () => {
    const provider = new AbortProvider();
    const controller = new AbortController();
    controller.abort();
    const promise = runSubagent(
      { description: 'Explore', prompt: 'Find auth.' },
      { provider, model: 'test-model', toolbox, tools: subagentTools(), signal: controller.signal },
    );
    await expect(promise).rejects.toThrow();
  });

  it('errors when the child tries to call task without a runner', async () => {
    const box = new RealToolBox({
      root: process.cwd(),
      diffManager: {} as never,
      terminalTimeoutSeconds: 15,
      autoApproveTerminal: false,
      autoApproveEdits: true,
      safeCommandsOnly: true,
      yolo: false,
      autoApproveMcp: true,
      checkDiagnostics: false,
      sandbox: 'off',
    });
    const result = await box.execute(
      'task',
      JSON.stringify({ description: 'nested', prompt: 'do it' }),
      { requestTerminalApproval: async () => 'deny' },
    );
    expect(result).toContain('subagents are not available');
  });
});

describe('toolbox task wiring', () => {
  function toolboxWithTask(runTask: (request: any, signal?: AbortSignal) => Promise<string>) {
    return new RealToolBox({
      root: process.cwd(),
      diffManager: {} as never,
      terminalTimeoutSeconds: 15,
      autoApproveTerminal: true,
      autoApproveEdits: true,
      safeCommandsOnly: true,
      yolo: false,
      autoApproveMcp: true,
      checkDiagnostics: false,
      sandbox: 'off',
      runTask,
    });
  }

  it('forwards the parsed request, the signal, and the child text', async () => {
    let seen: { description?: string; prompt?: string; subagentType?: string } = {};
    let seenSignal: AbortSignal | undefined;
    const box = toolboxWithTask(async (request, signal) => {
      seen = request;
      seenSignal = signal;
      return 'child findings';
    });
    const controller = new AbortController();
    const result = await box.execute(
      'task',
      JSON.stringify({ description: 'Find auth', prompt: 'Where is auth?', subagent_type: 'explore' }),
      { requestTerminalApproval: async () => 'deny', signal: controller.signal },
    );
    expect(result).toBe('child findings');
    expect(seen).toMatchObject({ description: 'Find auth', prompt: 'Where is auth?', subagentType: 'explore' });
    expect(seenSignal).toBe(controller.signal);
  });
});
