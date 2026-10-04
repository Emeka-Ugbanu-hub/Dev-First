import { describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
  StreamEvent,
  ToolCall,
  ToolDef,
} from '../src/llm/types';
import { MAP_SYSTEM_PROMPT, generateArchitectureMap } from '../src/architecture/mapGenerate';
import type { MapGenerateDeps } from '../src/architecture/mapGenerate';

class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted';
  readonly calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];

  constructor(private readonly replies: StreamEvent[][]) {}

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncIterable<StreamEvent> {
    this.calls.push({ messages: messages.map((message) => ({ ...message })), options });
    const reply = this.replies.shift() ?? [];
    for (const event of reply) {
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

const readFileTool: ToolDef = {
  name: 'read_file',
  description: 'Read files',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

const diagram = 'flowchart TD\n  root["App"]\n  root --> api["API"]';

function toolCall(id: string, name: string, args: Record<string, unknown>): StreamEvent {
  return { type: 'toolCall', toolCall: { id, name, arguments: JSON.stringify(args) } };
}

function deps(
  provider: LLMProvider,
  executed: ToolCall[],
  overrides: Partial<MapGenerateDeps> = {},
): MapGenerateDeps {
  return {
    provider,
    model: 'test-model',
    tools: [readFileTool],
    executeTool: async (call) => {
      executed.push(call);
      return 'file contents';
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('generateArchitectureMap', () => {
  it('executes tool calls and returns the final text with planner-style messages', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text', text: 'Let me look at the routes.' },
        toolCall('call-1', 'read_file', { path: 'src/a.ts' }),
      ],
      [{ type: 'text', text: diagram }],
    ]);
    const executed: ToolCall[] = [];
    const progress: Array<{ text: string; done: boolean }> = [];

    const result = await generateArchitectureMap(
      'digest text',
      deps(provider, executed, {
        onProgress: (text, done) => progress.push({ text, done: done === true }),
      }),
    );

    expect(result).toBe(diagram);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toEqual({
      id: 'call-1',
      name: 'read_file',
      arguments: '{"path":"src/a.ts"}',
    });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].options.model).toBe('test-model');
    expect(provider.calls[0].options.tools).toEqual([readFileTool]);
    expect(provider.calls[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(provider.calls[0].messages[0]).toEqual({
      role: 'system',
      content: MAP_SYSTEM_PROMPT,
    });
    expect(provider.calls[0].messages[1]).toEqual({ role: 'user', content: 'digest text' });

    const assistant = provider.calls[1].messages[2];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('Let me look at the routes.');
    expect(assistant.toolCalls).toEqual([
      { id: 'call-1', name: 'read_file', arguments: '{"path":"src/a.ts"}' },
    ]);

    const toolMessage = provider.calls[1].messages[3];
    expect(toolMessage).toEqual({
      role: 'tool',
      toolCallId: 'call-1',
      toolName: 'read_file',
      content: 'file contents',
    });
    expect(progress).toEqual([
      { text: 'Read src/a.ts', done: false },
      { text: 'Architecture map ready', done: true },
    ]);
  });

  it('carries reasoning into the assistant message when streamed', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'reasoning', text: 'thinking' },
        toolCall('call-1', 'read_file', { path: 'src/a.ts' }),
      ],
      [{ type: 'text', text: diagram }],
    ]);
    const executed: ToolCall[] = [];

    await generateArchitectureMap('digest text', deps(provider, executed));

    const assistant = provider.calls[1].messages[2];
    expect(assistant.reasoning).toBe('thinking');
  });

  it('reports tool errors back to the model as tool messages', async () => {
    const provider = new ScriptedProvider([
      [toolCall('call-err', 'read_file', { path: 'missing.ts' })],
      [{ type: 'text', text: diagram }],
    ]);

    const result = await generateArchitectureMap(
      'digest',
      deps(provider, [], {
        executeTool: async () => {
          throw new Error('missing');
        },
      }),
    );

    expect(result).toBe(diagram);
    const toolMessage = provider.calls[1].messages.find((message) => message.role === 'tool');
    expect(toolMessage).toEqual({
      role: 'tool',
      toolCallId: 'call-err',
      toolName: 'read_file',
      content: 'Error: missing',
    });
  });

  it('returns undefined when the provider throws', async () => {
    const provider: LLMProvider = {
      id: 'boom',
      async *chat(): AsyncIterable<StreamEvent> {
        throw new Error('nope');
      },
      listModels: async () => [],
      embed: async () => [],
    };

    const result = await generateArchitectureMap('digest', deps(provider, []));
    expect(result).toBeUndefined();
  });

  it('returns undefined when aborted before any call', async () => {
    const provider = new ScriptedProvider([[{ type: 'text', text: diagram }]]);
    const controller = new AbortController();
    controller.abort();

    const result = await generateArchitectureMap(
      'digest',
      deps(provider, [], { signal: controller.signal }),
    );

    expect(result).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it('stops after maxSteps tool rounds', async () => {
    const provider = new ScriptedProvider([
      [toolCall('c1', 'read_file', { path: 'a.ts' })],
      [toolCall('c2', 'read_file', { path: 'b.ts' })],
    ]);

    const result = await generateArchitectureMap('digest', deps(provider, [], { maxSteps: 2 }));
    expect(result).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
  });
});

describe('MAP_SYSTEM_PROMPT', () => {
  it('is exactly the required prompt', () => {
    const expected = `You are a software architect. The digest below is supporting context, not the whole picture.
Explore this codebase however you think is best to understand how it actually works.
Base every label and arrow on what you read. Trust files over the digest.

Your diagram exists so a developer who has never seen this codebase can look at it
and understand how it works. Preserve the structural understanding: the layers,
the components, their responsibilities, and how data moves between them. The result
should read like a clear explanation of the architecture, not a list of files.

Then respond with RAW Mermaid only (no prose, no code fences). Rules:
- Start with: flowchart TD
- Hierarchy with subgraphs for the main areas (Frontend, Backend, Services, Database, External Services...), nested only when clearer.
- One root node named after the project, connected to the main areas.
- Real components of THIS codebase as nodes; label every node yourself, 1-3 words; labels only, no descriptions inside nodes.
- Arrows describe behavior: reads, writes, calls, sends, emits, queries, returns. Show data movement between UI, backend, database, external APIs.
- Mark entry points, database/storage, external services explicitly.
- Never invent files/components not supported by what you read. Omit rather than guess.
- Keep it readable (~40 nodes max). Quote labels: n1["User Service"].
- No click/style/linkStyle/classDef directives, no HTML.
- End with a path map, one line per node that maps to a real folder or file:
%% PATHS
%% ui = src/components
%% db = src-tauri/src/db.rs`;

    expect(MAP_SYSTEM_PROMPT).toBe(expected);
  });
});
