import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    workspace: {
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: async () => undefined }),
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
      workspaceFolders: [],
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
import type { Plan, TerminalApprovalDecision } from '../src/shared/protocol';
import type { ToolBox } from '../src/agent/ToolBox';
import { AgentService } from '../src/agent/AgentService';
import {
  DUPLICATE_TOOL_OUTPUT,
  FAILED_TOOL_OUTPUT,
  KEEP_RECENT_TOOL_RESULTS,
  PRUNED_TOOL_OUTPUT,
  PROTECTED_TOOL_NAMES,
  pruneMessages,
  shouldPrune,
} from '../src/agent/prune';

const longOutput = (index: number): string => `output-${index} ${'x'.repeat(400)}`;

function exchange(index: number, name = 'read_file', content = longOutput(index)): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call-${index}`, name, arguments: JSON.stringify({ path: `file-${index}.ts` }) }],
    },
    { role: 'tool', toolCallId: `call-${index}`, toolName: name, content },
  ];
}

function conversation(
  count: number,
  name = 'read_file',
  contentFor: (index: number) => string = longOutput,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'do the work' },
  ];
  for (let index = 0; index < count; index++) {
    messages.push(...exchange(index, name, contentFor(index)));
  }
  return messages;
}

function toolIndex(index: number): number {
  return 3 + index * 2;
}

function errorConversation(assistantsAfter: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'err', name: 'read_file', arguments: '{"path":"missing.ts"}' }],
    },
    { role: 'tool', toolCallId: 'err', toolName: 'read_file', content: `Error: no such file ${'x'.repeat(300)}` },
  ];
  for (let index = 0; index < assistantsAfter; index++) {
    messages.push({ role: 'assistant', content: `turn ${index}` });
  }
  return messages;
}

describe('pruneMessages old results', () => {
  it('replaces only results older than the last ten tool messages', () => {
    const messages = conversation(12);
    const pruned = pruneMessages(messages);
    expect(pruned).not.toBe(messages);
    expect(pruned).toHaveLength(messages.length);
    expect(pruned[toolIndex(0)].content).toBe(PRUNED_TOOL_OUTPUT);
    expect(pruned[toolIndex(1)].content).toBe(PRUNED_TOOL_OUTPUT);
    for (let index = 2; index < 12; index++) {
      expect(pruned[toolIndex(index)].content).toBe(messages[toolIndex(index)].content);
    }
  });

  it('keeps the newest ten completed tool results', () => {
    expect(KEEP_RECENT_TOOL_RESULTS).toBe(10);
    const messages = conversation(14);
    const pruned = pruneMessages(messages);
    for (let index = 4; index < 14; index++) {
      expect(pruned[toolIndex(index)].content).toBe(longOutput(index));
    }
  });

  it('leaves short outputs untouched', () => {
    const messages = conversation(12, 'read_file', () => 'short');
    const pruned = pruneMessages(messages);
    for (let index = 0; index < 12; index++) {
      expect(pruned[toolIndex(index)].content).toBe('short');
    }
  });

  it('never prunes protected tool results', () => {
    for (const name of PROTECTED_TOOL_NAMES) {
      const messages = conversation(12, name);
      const pruned = pruneMessages(messages);
      for (let index = 0; index < 12; index++) {
        expect(pruned[toolIndex(index)].content).toBe(longOutput(index));
      }
    }
    expect([...PROTECTED_TOOL_NAMES].sort()).toEqual([
      'apply_patch',
      'ask_user',
      'compress_context',
      'edit_file',
      'memory_save',
      'set_reasoning',
      'task',
      'todo_write',
      'use_skill',
      'write_file',
    ]);
  });
});

describe('pruneMessages dedup', () => {
  it('keeps the newest duplicate and replaces older identical results', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'a1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }],
      },
      { role: 'tool', toolCallId: 'a1', toolName: 'read_file', content: 'first result' },
      { role: 'assistant', content: 'still going' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'a2', name: 'read_file', arguments: '{ "path" : "src/a.ts" }' }],
      },
      { role: 'tool', toolCallId: 'a2', toolName: 'read_file', content: 'second result' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'a3', name: 'read_file', arguments: '{"path":"src/b.ts"}' }],
      },
      { role: 'tool', toolCallId: 'a3', toolName: 'read_file', content: 'unique result' },
    ];
    const pruned = pruneMessages(messages);
    expect(pruned[3].content).toBe(DUPLICATE_TOOL_OUTPUT);
    expect(pruned[6].content).toBe('second result');
    expect(pruned[8].content).toBe('unique result');
  });

  it('does not dedupe protected tools', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'e1', name: 'edit_file', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'e1', toolName: 'edit_file', content: 'edited once' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'e2', name: 'edit_file', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'e2', toolName: 'edit_file', content: 'edited twice' },
    ];
    const pruned = pruneMessages(messages);
    expect(pruned[1].content).toBe('edited once');
    expect(pruned[3].content).toBe('edited twice');
  });
});

describe('pruneMessages error purge', () => {
  it('purges failed results only once more than four assistant turns follow', () => {
    const withFour = errorConversation(4);
    expect(pruneMessages(withFour)[3].content).toContain('Error:');
    const withFive = errorConversation(5);
    expect(pruneMessages(withFive)[3].content).toBe(FAILED_TOOL_OUTPUT);
  });

  it('leaves recent errors and non-error failures alone', () => {
    const recent = errorConversation(1);
    expect(pruneMessages(recent)[3].content).toContain('Error:');
    const nonError: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'thinking' },
      { role: 'assistant', content: 'thinking again' },
      { role: 'assistant', content: 'thinking more' },
      { role: 'assistant', content: 'thinking even more' },
      { role: 'assistant', content: 'and more' },
      { role: 'tool', toolCallId: 'x', toolName: 'read_file', content: 'partial failure noted' },
    ];
    expect(pruneMessages(nonError)[6].content).toBe('partial failure noted');
  });
});

describe('pruneMessages preservation', () => {
  it('leaves user, assistant, and reasoning metadata byte-identical', () => {
    const messages = conversation(12);
    messages[1] = { ...messages[1], images: ['data:image/png;base64,AAAA'] };
    messages[2] = { ...messages[2], content: 'narrating', reasoning: 'chain of thought' };
    const pruned = pruneMessages(messages);
    expect(JSON.stringify(pruned[0])).toBe(JSON.stringify(messages[0]));
    expect(JSON.stringify(pruned[1])).toBe(JSON.stringify(messages[1]));
    expect(JSON.stringify(pruned[2])).toBe(JSON.stringify(messages[2]));
    expect(pruned[1]).toBe(messages[1]);
    expect(pruned[2]).toBe(messages[2]);
    expect(pruned[toolIndex(0)].role).toBe('tool');
    expect(pruned[toolIndex(0)].toolCallId).toBe(messages[toolIndex(0)].toolCallId);
    expect(pruned[toolIndex(0)].toolName).toBe(messages[toolIndex(0)].toolName);
  });

  it('does not mutate the original conversation', () => {
    const messages = conversation(12);
    const snapshot = JSON.stringify(messages);
    const pruned = pruneMessages(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(pruned).not.toBe(messages);
    expect(pruned[toolIndex(0)]).not.toBe(messages[toolIndex(0)]);
    expect(pruned[toolIndex(11)]).toBe(messages[toolIndex(11)]);
    expect(pruned[0]).toBe(messages[0]);
  });

  it('returns a new array even when there is nothing to prune', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const pruned = pruneMessages(messages);
    expect(pruned).not.toBe(messages);
    expect(pruned).toEqual(messages);
  });
});

describe('shouldPrune', () => {
  it('triggers above half the context limit', () => {
    expect(shouldPrune(499, 1000)).toBe(false);
    expect(shouldPrune(500, 1000)).toBe(false);
    expect(shouldPrune(501, 1000)).toBe(true);
    expect(shouldPrune(1000, 0)).toBe(false);
  });
});

class RecordingProvider implements LLMProvider {
  readonly id = 'recording';
  readonly calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  private toolCalls = 0;

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push({ messages: messages.map((message) => ({ ...message })), options });
    if (options.tools === undefined) {
      yield { type: 'text', text: 'condensed history' };
      yield { type: 'done' };
      return;
    }
    if (this.toolCalls < 11) {
      const index = this.toolCalls++;
      yield {
        type: 'toolCall',
        toolCall: {
          id: `call-${index}`,
          name: 'read_file',
          arguments: JSON.stringify({ path: `file-${index}.ts` }),
        },
      };
      yield { type: 'done' };
      return;
    }
    yield { type: 'text', text: 'All done.' };
    yield { type: 'done' };
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async embed(): Promise<number[][]> {
    return [];
  }
}

describe('AgentService preflight pruning', () => {
  it('prunes before compaction and still compacts when over sixty percent', async () => {
    const provider = new RecordingProvider();
    const toolbox = {
      execute: vi.fn(async (_name: string, args: string) => {
        const parsed = JSON.parse(args) as { path: string };
        if (parsed.path === 'file-10.ts') {
          return `huge output ${'x'.repeat(80_000)}`;
        }
        return `output for ${parsed.path} ${'y'.repeat(2_400)}`;
      }),
    } as unknown as ToolBox;
    const compactions: Array<{
      tokensBefore: number;
      tokensAfter: number;
      messagesBefore: number;
      messagesAfter: number;
    }> = [];
    const agent = new AgentService(provider, 'test-model', toolbox, {
      maxSteps: 50,
      tools: [],
      autoCompact: true,
      contextLimitTokens: 40_000,
    });

    const plan: Plan = { version: 1, status: 'approved', steps: ['Read files'] };
    await agent.run(plan, 'read the files', new AbortController().signal, {
      onTextDelta: () => undefined,
      onToolActivity: () => undefined,
      requestTerminalApproval: async () => 'deny' as TerminalApprovalDecision,
      onCompaction: (info) => compactions.push(info),
    });

    const summaryCalls = provider.calls.filter((call) => call.options.tools === undefined);
    expect(summaryCalls).toHaveLength(1);
    const summarized = summaryCalls[0].messages.map((message) => message.content).join('\n');
    expect(summarized).toContain(PRUNED_TOOL_OUTPUT);
    expect(summarized).not.toContain('output for file-0.ts');

    const compactedCalls = provider.calls.filter(
      (call) =>
        call.options.tools !== undefined &&
        call.messages.some(
          (message) => message.role === 'user' && message.content.startsWith('[Summary of earlier work'),
        ),
    );
    expect(compactedCalls).toHaveLength(1);
    expect(compactions).toHaveLength(1);
    expect(compactions[0].messagesAfter).toBeLessThan(compactions[0].messagesBefore);
    expect(compactions[0].tokensAfter).toBeLessThan(compactions[0].tokensBefore);
  });
});
