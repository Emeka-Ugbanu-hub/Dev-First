import { afterEach, describe, expect, it } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { OpenAIProvider } from '../src/llm/providers/openai';
import { AnthropicProvider } from '../src/llm/providers/anthropic';
import { GeminiProvider } from '../src/llm/providers/gemini';
import { SessionStore, StoredSession } from '../src/session/SessionStore';
import { ChatMessage, StreamEvent, ToolDef } from '../src/llm/types';

interface MockServer {
  url: string;
  requests: Array<{ path: string; body: any; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}

function startMockServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        body: body ? JSON.parse(body) : undefined,
        headers: req.headers,
      });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function sse(res: ServerResponse, chunks: string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of chunks) {
    res.write(chunk);
  }
  res.end();
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

const readTool: ToolDef = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

let mock: MockServer | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe('OpenAIProvider', () => {
  it('streams text and assembles tool call deltas', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    });

    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: `${mock.url}/v1` });
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const events = await collect(provider.chat(messages, { model: 'gpt-test', tools: [readTool] }));

    expect(events.filter((event) => event.type === 'text').map((event) => (event as any).text).join('')).toBe('Hello');
    const toolCall = events.find((event) => event.type === 'toolCall') as any;
    expect(toolCall.toolCall.name).toBe('read_file');
    expect(JSON.parse(toolCall.toolCall.arguments)).toEqual({ path: 'a.ts' });

    const request = mock.requests[0];
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer test-key');
    expect(request.body.stream).toBe(true);
    expect(request.body.tools[0].function.name).toBe('read_file');
  });

  it('serializes assistant tool calls and tool results', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    await collect(
      provider.chat(
        [
          { role: 'user', content: 'do it' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_9', name: 'read_file', arguments: '{"path":"x"}' }],
          },
          { role: 'tool', toolCallId: 'call_9', toolName: 'read_file', content: 'file body' },
        ],
        { model: 'm' },
      ),
    );

    const sent = mock.requests[0].body.messages;
    expect(sent[1].role).toBe('assistant');
    expect(sent[1].tool_calls[0].id).toBe('call_9');
    expect(sent[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_9', content: 'file body' });
  });
});

describe('Ollama reasoning metadata requests', () => {
  it('uses the native chat API so the advertised thinking level is honored', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end('{"message":{"thinking":"step","content":"answer"},"done":true}\n');
    });
    const provider = new OpenAIProvider({ apiKey: 'not-needed', baseUrl: `${mock.url}/v1`, ollama: true });
    const events = await collect(provider.chat(
      [{ role: 'user', content: 'inspect', images: ['data:image/png;base64,aGVsbG8='] }],
      { model: 'qwen3:8b', reasoning: { enabled: true, effort: 'high' } },
    ));

    expect(mock.requests[0].path).toBe('/api/chat');
    expect(mock.requests[0].body.think).toBe('high');
    expect(mock.requests[0].body.messages[0].images).toEqual(['aGVsbG8=']);
    expect(events).toContainEqual({ type: 'reasoning', text: 'step' });
    expect(events).toContainEqual({ type: 'text', text: 'answer' });
  });
});

describe('AnthropicProvider', () => {
  it('streams text and tool_use input json', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"edit_file"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"b.ts\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":1}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    });

    const provider = new AnthropicProvider({ apiKey: 'test-key', baseUrl: mock.url });
    const events = await collect(
      provider.chat(
        [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        { model: 'claude-test', tools: [readTool] },
      ),
    );

    expect(events.filter((event) => event.type === 'text').map((event) => (event as any).text).join('')).toBe('Hi');
    const toolCall = events.find((event) => event.type === 'toolCall') as any;
    expect(toolCall.toolCall.id).toBe('toolu_1');
    expect(JSON.parse(toolCall.toolCall.arguments)).toEqual({ path: 'b.ts' });

    const request = mock.requests[0];
    expect(request.path).toBe('/v1/messages');
    expect(request.headers['x-api-key']).toBe('test-key');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    const system = request.body.system;
    expect(Array.isArray(system) ? system[0].text : system).toBe('be brief');
    expect(request.body.messages).toHaveLength(1);
    expect(request.body.tools[0].input_schema.required).toEqual(['path']);
  });

  it('merges consecutive tool results into one user message', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', arguments: '{}' }] },
          { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'b', arguments: '{}' }] },
          { role: 'tool', toolCallId: 't1', toolName: 'a', content: 'r1' },
          { role: 'tool', toolCallId: 't2', toolName: 'b', content: 'r2' },
        ],
        { model: 'm' },
      ),
    );
    const sent = mock.requests[0].body.messages;
    const last = sent[sent.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toHaveLength(2);
    expect(last.content[0].type).toBe('tool_result');
    expect(last.content[1].tool_use_id).toBe('t2');
  });
});

describe('Anthropic interleaved-thinking beta header', () => {
  it('sends the beta header when thinking is on and omits it when off', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'claude-sonnet-4-6', reasoning: { enabled: true, effort: 'medium' } },
      ),
    );
    expect(mock.requests[0].headers['anthropic-beta']).toBe(
      'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    );

    await collect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-6' }));
    expect(mock.requests[1].headers['anthropic-beta']).toBeUndefined();
  });

  it('retries once without the beta header when it is rejected', async () => {
    mock = await startMockServer((_req, res) => {
      if (mock && mock.requests.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Unexpected value for the anthropic-beta header' },
          }),
        );
        return;
      }
      sse(res, [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    const events = await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'claude-sonnet-4-6', reasoning: { enabled: true, effort: 'high' } },
      ),
    );

    expect(events).toContainEqual({ type: 'text', text: 'ok' });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].headers['anthropic-beta']).toBeDefined();
    expect(mock.requests[1].headers['anthropic-beta']).toBeUndefined();
  });

  it('does not retry unrelated 400 errors', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: 'max_tokens: must be greater than 0' } }));
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await expect(
      collect(
        provider.chat(
          [{ role: 'user', content: 'hi' }],
          { model: 'claude-sonnet-4-6', reasoning: { enabled: true, effort: 'high' } },
        ),
      ),
    ).rejects.toThrow('max_tokens');
    expect(mock.requests).toHaveLength(1);
  });
});

describe('GeminiProvider', () => {
  it('streams text and function calls', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hey"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" there"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_files","args":{"path":"src"}}}]}}]}\n\n',
      ]);
    });

    const provider = new GeminiProvider({ apiKey: 'test-key', baseUrl: mock.url });
    const events = await collect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'gemini-test', tools: [readTool] }));

    expect(events.filter((event) => event.type === 'text').map((event) => (event as any).text).join('')).toBe('Hey there');
    const toolCall = events.find((event) => event.type === 'toolCall') as any;
    expect(toolCall.toolCall.name).toBe('list_files');
    expect(JSON.parse(toolCall.toolCall.arguments)).toEqual({ path: 'src' });

    const request = mock.requests[0];
    expect(request.path).toContain('/v1beta/models/gemini-test:streamGenerateContent');
    expect(request.headers['x-goog-api-key']).toBe('test-key');
    expect(request.body.tools[0].functionDeclarations[0].parameters.type).toBe('OBJECT');
  });

  it('serializes tool results as functionResponse parts', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"candidates":[{"content":{"parts":[{"text":"done"}]}}]}\n\n']);
    });
    const provider = new GeminiProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'g1', name: 'list_files', arguments: '{"path":"src"}' }] },
          { role: 'tool', toolCallId: 'g1', toolName: 'list_files', content: 'a.ts' },
        ],
        { model: 'm' },
      ),
    );
    const contents = mock.requests[0].body.contents;
    expect(contents[1].role).toBe('model');
    expect(contents[1].parts[0].functionCall.name).toBe('list_files');
    expect(contents[2].parts[0].functionResponse.name).toBe('list_files');
    expect(contents[2].parts[0].functionResponse.response.result).toBe('a.ts');
  });
});

describe('adaptive reasoning payloads', () => {
  it('sends adaptive thinking for Anthropic adaptive models at high effort', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'claude-sonnet-4-6', reasoning: { enabled: true, effort: 'high', kind: 'anthropic-adaptive' } },
      ),
    );
    expect(mock.requests[0].body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(mock.requests[0].body.effort).toBe('high');
  });

  it('leaves the adaptive payload untouched when thinking is off', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'claude-sonnet-4-6', reasoning: { enabled: false, effort: 'high', kind: 'anthropic-adaptive' } },
      ),
    );
    expect(mock.requests[0].body.thinking).toBeUndefined();
    expect(mock.requests[0].body.effort).toBeUndefined();
  });

  it('keeps the fixed Anthropic budget below the adaptive threshold', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'claude-sonnet-4-6', reasoning: { enabled: true, effort: 'medium', kind: 'anthropic-adaptive' } },
      ),
    );
    expect(mock.requests[0].body.thinking).toMatchObject({ type: 'enabled' });
    expect(mock.requests[0].body.thinking.budget_tokens).toBe(4096);
  });

  it('sends a dynamic Gemini thinking budget at max effort', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n']);
    });
    const provider = new GeminiProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'gemini-3-pro', reasoning: { enabled: true, effort: 'max', kind: 'gemini-dynamic' } },
      ),
    );
    expect(mock.requests[0].body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: -1,
      includeThoughts: true,
    });
  });

  it('keeps the fixed Gemini budget below the adaptive threshold', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n']);
    });
    const provider = new GeminiProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'gemini-3-pro', reasoning: { enabled: true, effort: 'low', kind: 'gemini-dynamic' } },
      ),
    );
    expect(mock.requests[0].body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 2048,
      includeThoughts: true,
    });
  });

  it('leaves OpenAI reasoning payloads unchanged', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'gpt-5', reasoning: { enabled: true, effort: 'high', kind: 'toggle' } },
      ),
    );
    expect(mock.requests[0].body.reasoning_effort).toBe('high');
    expect(mock.requests[0].body.thinking).toBeUndefined();
  });

  it('leaves DeepSeek reasoning payloads unchanged', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1`, deepSeek: true });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'deepseek-reasoner', reasoning: { enabled: true, effort: 'high' } },
      ),
    );
    expect(mock.requests[0].body.thinking).toEqual({ type: 'enabled' });
    expect(mock.requests[0].body.reasoning_effort).toBe('high');
  });

  it('omits an explicit effort for default and auto', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'qwen3', reasoning: { enabled: true, effort: 'default', kind: 'toggle' } },
      ),
    );
    expect(mock.requests[0].body.reasoning_effort).toBeUndefined();
  });

  it('retries once without reasoning when the endpoint rejects it', async () => {
    mock = await startMockServer((_req, res) => {
      if (mock && mock.requests.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'reasoning_effort is not supported for this model' } }));
        return;
      }
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    const events = await collect(
      provider.chat(
        [{ role: 'user', content: 'hi' }],
        { model: 'custom-model', reasoning: { enabled: true, effort: 'high' } },
      ),
    );

    expect(events).toContainEqual({ type: 'text', text: 'ok' });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].body.reasoning_effort).toBe('high');
    expect(mock.requests[1].body.reasoning_effort).toBeUndefined();
  });

  it('only retries reasoning rejections once', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'thinking is unsupported' } }));
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    await expect(
      collect(
        provider.chat(
          [{ role: 'user', content: 'hi' }],
          { model: 'custom-model', reasoning: { enabled: true, effort: 'high' } },
        ),
      ),
    ).rejects.toThrow('thinking is unsupported');
    expect(mock.requests).toHaveLength(2);
  });

  it('does not retry unrelated 400 errors', async () => {
    mock = await startMockServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model not found' } }));
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    await expect(
      collect(
        provider.chat(
          [{ role: 'user', content: 'hi' }],
          { model: 'custom-model', reasoning: { enabled: true, effort: 'high' } },
        ),
      ),
    ).rejects.toThrow('model not found');
    expect(mock.requests).toHaveLength(1);
  });
});

describe('DeepSeek reasoning replay', () => {
  it('replays accumulated reasoning on assistant wire messages', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({
      apiKey: 'k',
      baseUrl: `${mock.url}/v1`,
      deepSeek: true,
      providerId: 'deepseek',
    });
    await collect(
      provider.chat(
        [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: 'checking',
            reasoning: 'first think then act',
            toolCalls: [{ id: 't1', name: 'read_file', arguments: '{"path":"a"}' }],
          },
          { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'body' },
        ],
        { model: 'deepseek-reasoner' },
      ),
    );

    const sent = mock.requests[0].body.messages;
    expect(sent[1].reasoning_content).toBe('first think then act');
    expect(sent[1].content).toBe('checking');
  });

  it('pads missing reasoning with an empty string so tool conversations do not 400', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1`, deepSeek: true });
    await collect(
      provider.chat(
        [
          { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: '{}' }] },
          { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'body' },
        ],
        { model: 'deepseek-reasoner' },
      ),
    );

    expect(mock.requests[0].body.messages[0].reasoning_content).toBe('');
  });

  it('detects DeepSeek models by id even without the preset flag', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1`, providerId: 'openrouter' });
    await collect(
      provider.chat(
        [
          {
            role: 'assistant',
            content: 'answer',
            reasoning: 'router thought',
            toolCalls: [{ id: 't1', name: 'read_file', arguments: '{}' }],
          },
        ],
        { model: 'deepseek/deepseek-v3.2' },
      ),
    );

    expect(mock.requests[0].body.messages[0].reasoning_content).toBe('router thought');
  });

  it('leaves other OpenAI-compatible models byte-identical', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    await collect(
      provider.chat(
        [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            reasoning: 'hidden',
            toolCalls: [{ id: 't1', name: 'read_file', arguments: '{}' }],
          },
        ],
        { model: 'gpt-test' },
      ),
    );

    expect(mock.requests[0].body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });
  });

  it('replays reasoning restored from a session round-trip', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'df-replay-'));
    try {
      const store = new SessionStore(dir);
      const stored: StoredSession = {
        id: 'replay',
        title: 'Replay',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        plan: null,
        todos: [],
        planVersion: 0,
        lastRequest: '',
        contextTokens: 0,
        conversation: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            reasoning: 'restored thought',
            toolCalls: [{ id: 't1', name: 'read_file', arguments: '{}' }],
          },
          { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'body' },
        ],
      };
      await store.save(stored);
      const loaded = await store.load('replay');

      mock = await startMockServer((_req, res) => {
        sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
      });
      const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1`, deepSeek: true });
      await collect(provider.chat(loaded!.conversation, { model: 'deepseek-reasoner' }));

      expect(mock.requests[0].body.messages[1].reasoning_content).toBe('restored thought');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Anthropic empty content filtering', () => {
  it('drops empty messages and keeps tool-only assistant turns', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '' },
          { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: '{"path":"a"}' }] },
          { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: '' },
          { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'body' },
          { role: 'user', content: '' },
        ],
        { model: 'm' },
      ),
    );

    const sent = mock.requests[0].body.messages;
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ role: 'user', content: 'go' });
    expect(sent[1].content.map((part: any) => part.type)).toEqual(['tool_use']);
    expect(sent[2].content.map((part: any) => part.type)).toEqual(['tool_result']);
    expect(sent[2].content[0].content).toBe('body');
  });

  it('removes empty text parts from array-style content', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [{ role: 'user', content: '', images: ['data:image/png;base64,aGVsbG8='] }],
        { model: 'm' },
      ),
    );

    const sent = mock.requests[0].body.messages;
    expect(sent).toHaveLength(1);
    expect(sent[0].content.map((part: any) => part.type)).toEqual(['image']);
  });
});

describe('Anthropic cache breakpoints', () => {
  it('marks the last two conversation messages without duplicates', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' },
          { role: 'user', content: 'three' },
        ],
        { model: 'm', tools: [readTool] },
      ),
    );

    const body = mock.requests[0].body;
    expect(body.messages[0].content).toBe('one');
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages[2].content).toEqual([
      { type: 'text', text: 'three', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(body).match(/"cache_control"/g)).toHaveLength(4);
  });

  it('omits message cache markers when caching is disabled', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(
      provider.chat(
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' },
        ],
        { model: 'm', tools: [readTool], cache: false },
      ),
    );

    expect(JSON.stringify(mock.requests[0].body)).not.toContain('cache_control');
  });
});

describe('temperature gating', () => {
  it('omits temperature for OpenAI reasoning models but keeps it otherwise', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    for (const model of ['o3-mini', 'gpt-5', 'gpt-4o']) {
      await collect(provider.chat([{ role: 'user', content: 'hi' }], { model, temperature: 0.4 }));
    }

    expect(mock.requests[0].body.temperature).toBeUndefined();
    expect(mock.requests[1].body.temperature).toBeUndefined();
    expect(mock.requests[2].body.temperature).toBe(0.4);
  });

  it('omits temperature for Claude models and keeps it for other providers', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const anthropic = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(anthropic.chat([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-6', temperature: 0.4 }));
    await collect(anthropic.chat([{ role: 'user', content: 'hi' }], { model: 'custom-compatible', temperature: 0.4 }));

    const gemini = new GeminiProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(gemini.chat([{ role: 'user', content: 'hi' }], { model: 'gemini-test', temperature: 0.4 }));

    expect(mock.requests[0].body.temperature).toBeUndefined();
    expect(mock.requests[1].body.temperature).toBe(0.4);
    expect(mock.requests[2].body.generationConfig.temperature).toBe(0.4);
  });
});

describe('exact usage accounting', () => {
  it('requests stream usage and emits exact OpenAI token counts from the final chunk', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":123,"completion_tokens":45,"prompt_tokens_details":{"cached_tokens":7},"completion_tokens_details":{"reasoning_tokens":11}}}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    const events = await collect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'gpt-test' }));

    expect(mock.requests[0].body.stream_options).toEqual({ include_usage: true });
    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 123,
      outputTokens: 45,
      reasoningTokens: 11,
      cachedTokens: 7,
    });
  });

  it('retries once without stream_options when the endpoint rejects it', async () => {
    mock = await startMockServer((_req, res) => {
      if (mock && mock.requests.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stream_options is not supported by this endpoint' } }));
        return;
      }
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    const events = await collect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'custom-model' }));

    expect(events).toContainEqual({ type: 'text', text: 'ok' });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].body.stream_options).toEqual({ include_usage: true });
    expect(mock.requests[1].body.stream_options).toBeUndefined();
  });

  it('skips stream usage for DeepSeek', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    });
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1`, deepSeek: true });
    await collect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'deepseek-reasoner' }));

    expect(mock.requests[0].body.stream_options).toBeUndefined();
  });

  it('emits Anthropic input/cache usage from message_start and output from message_delta', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":5}}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":40}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]);
    });
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    const events = await collect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'claude-test' }));

    expect(events).toContainEqual({ type: 'usage', inputTokens: 100, cachedTokens: 25 });
    expect(events).toContainEqual({ type: 'usage', outputTokens: 40 });
  });

  it('emits Gemini usage metadata', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, [
        'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":3,"thoughtsTokenCount":2,"cachedContentTokenCount":1}}\n\n',
      ]);
    });
    const provider = new GeminiProvider({ apiKey: 'k', baseUrl: mock.url });
    const events = await collect(provider.chat([{ role: 'user', content: 'hi' }], { model: 'gemini-test' }));

    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 12,
      outputTokens: 3,
      reasoningTokens: 2,
      cachedTokens: 1,
    });
  });
});

describe('surrogate sanitization', () => {
  it('replaces lone surrogates in outgoing text and tool results for every provider', async () => {
    mock = await startMockServer((_req, res) => {
      sse(res, ['data: {"type":"message_stop"}\n\n']);
    });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a\uD800b' },
      { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: '\uDC00z' },
    ];

    const openai = new OpenAIProvider({ apiKey: 'k', baseUrl: `${mock.url}/v1` });
    await collect(openai.chat(messages, { model: 'm' }));
    const anthropic = new AnthropicProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(anthropic.chat(messages, { model: 'm' }));
    const gemini = new GeminiProvider({ apiKey: 'k', baseUrl: mock.url });
    await collect(gemini.chat(messages, { model: 'm' }));

    expect(mock.requests[0].body.messages[0].content).toBe('a\uFFFDb');
    expect(mock.requests[0].body.messages[1].content).toBe('\uFFFDz');
    expect(mock.requests[1].body.messages[0].content[0].text).toBe('a\uFFFDb');
    expect(mock.requests[1].body.messages[1].content[0].content).toBe('\uFFFDz');
    expect(mock.requests[2].body.contents[0].parts[0].text).toBe('a\uFFFDb');
    expect(mock.requests[2].body.contents[0].parts[1].functionResponse.response.result).toBe('\uFFFDz');
  });
});
