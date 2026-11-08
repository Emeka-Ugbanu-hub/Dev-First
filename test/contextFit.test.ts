import { describe, expect, it } from 'vitest';
import { estimateRequestTokens, fitRequestToContext, requestBudget } from '../src/llm/contextFit';
import type { ChatMessage, ChatOptions } from '../src/llm/types';

function options(contextTokens: number, extra: Partial<ChatOptions> = {}): ChatOptions {
  return { model: 'test-model', contextTokens, ...extra };
}

function tokens(messages: ChatMessage[], opts: ChatOptions): number {
  return estimateRequestTokens(messages, opts);
}

function matchingToolCalls(messages: ChatMessage[]): boolean {
  const callIds = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      callIds.add(call.id);
    }
  }
  return messages.every(
    (message) => message.role !== 'tool' || !message.toolCallId || callIds.has(message.toolCallId),
  );
}

describe('fitRequestToContext', () => {
  it('leaves an under-budget request unchanged without mutating the input', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'What does this function do?' },
    ];
    const fitted = fitRequestToContext(messages, options(4096));

    expect(fitted).toEqual(messages);
    expect(fitted).not.toBe(messages);
    expect(tokens(fitted, options(4096))).toBeLessThanOrEqual(requestBudget(4096, options(4096)));
  });

  it('compacts older tool output before removing evidence', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Answer from the read results.' },
      { role: 'user', content: 'Explain the flow.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"src/a.ts"}' }] },
      { role: 'tool', toolCallId: 'call_1', toolName: 'read_file', content: 'line of code '.repeat(1000) },
    ];
    const opts = options(4096);
    const fitted = fitRequestToContext(messages, opts);
    const tool = fitted.find((message) => message.role === 'tool');

    expect(tokens(fitted, opts)).toBeLessThanOrEqual(requestBudget(4096, opts));
    expect(tool?.content).toContain('earlier tool output compacted');
    expect(fitted.some((message) => message.role === 'user')).toBe(true);
    expect(matchingToolCalls(fitted)).toBe(true);
  });

  it('compacts old tool evidence without leaving dangling tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Answer from evidence.' },
      { role: 'user', content: 'Explain both files.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'old_call', name: 'read_file', arguments: '{"path":"src/old.ts"}' }],
      },
      { role: 'tool', toolCallId: 'old_call', toolName: 'read_file', content: 'old '.repeat(3000) },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'new_call', name: 'read_file', arguments: '{"path":"src/new.ts"}' }],
      },
      { role: 'tool', toolCallId: 'new_call', toolName: 'read_file', content: 'new '.repeat(3000) },
    ];
    const opts = options(4096);
    const fitted = fitRequestToContext(messages, opts);

    expect(tokens(fitted, opts)).toBeLessThanOrEqual(requestBudget(4096, opts));
    expect(matchingToolCalls(fitted)).toBe(true);
  });

  it('removes the oldest complete tool group when many small results overflow', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Answer from evidence. '.repeat(200) },
      { role: 'user', content: 'Explain the history.' },
    ];
    for (let index = 0; index < 30; index++) {
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `call_${index}`, name: 'read_file', arguments: `{"path":"src/file${index}.ts"}` }],
      });
      messages.push({
        role: 'tool',
        toolCallId: `call_${index}`,
        toolName: 'read_file',
        content: `result ${index} `.repeat(25),
      });
    }
    const opts = options(4096);
    const fitted = fitRequestToContext(messages, opts);

    expect(tokens(fitted, opts)).toBeLessThanOrEqual(requestBudget(4096, opts));
    expect(matchingToolCalls(fitted)).toBe(true);
    expect(fitted.some((message) => message.toolCallId === 'call_0')).toBe(false);
  });

  it('compacts large system evidence while preserving the instructions', () => {
    const instructions = 'SYSTEM INSTRUCTIONS: answer only from verified evidence. '.repeat(20);
    const evidence = 'project evidence '.repeat(2000);
    const messages: ChatMessage[] = [
      { role: 'system', content: instructions },
      { role: 'system', content: evidence },
      { role: 'user', content: 'Summarize the evidence.' },
    ];
    const opts = options(4096);
    const fitted = fitRequestToContext(messages, opts);

    expect(tokens(fitted, opts)).toBeLessThanOrEqual(requestBudget(4096, opts));
    expect(fitted[0].content).toBe(instructions);
    expect(fitted[1].content).toContain('earlier context compacted');
  });

  it('compacts an oversized latest user request', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: `Question header\n${'pasted context '.repeat(2000)}` },
    ];
    const opts = options(4096);
    const fitted = fitRequestToContext(messages, opts);

    expect(tokens(fitted, opts)).toBeLessThanOrEqual(requestBudget(4096, opts));
    expect(fitted[1].content).toContain('middle of request compacted');
    expect(fitted[1].content.startsWith('Question header')).toBe(true);
  });

  it('fits a 4,096-token answer request made mostly of system evidence', () => {
    const tools = ['local_hybrid_search', 'find_and_read', 'read_file', 'find_symbol', 'document_symbols'].map(
      (name) => ({
        name,
        description: 'x'.repeat(120),
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, path: { type: 'string' } },
          required: ['query'],
        },
      }),
    );
    const messages: ChatMessage[] = [
      { role: 'system', content: 'ANSWER INSTRUCTIONS '.repeat(45) },
      { role: 'system', content: '[Pinned context] ' + 'Pinned memory line. '.repeat(100) },
      { role: 'system', content: '[Task evidence] ' + 'Relevant project evidence. '.repeat(200) },
      { role: 'system', content: '[Project bootstrap] ' + 'Bootstrap. '.repeat(60) },
      { role: 'system', content: '[Codebase evidence] ' + 'src/file.ts: function example() { ... } '.repeat(200) },
      { role: 'user', content: 'How does the session continuation work?' },
    ];
    const opts = options(4096, { tools });
    const before = tokens(messages, opts);

    expect(before).toBeGreaterThan(4096);

    const fitted = fitRequestToContext(messages, opts);
    expect(tokens(fitted, opts)).toBeLessThanOrEqual(requestBudget(4096, opts));
    expect(fitted.some((message) => message.content.includes('How does the session continuation work?'))).toBe(true);
  });

  it('compacts the first system message as a last resort', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYSTEM INSTRUCTIONS '.repeat(5000) },
      { role: 'user', content: 'Answer.' },
    ];
    const opts = options(4096);
    const fitted = fitRequestToContext(messages, opts);

    expect(tokens(fitted, opts)).toBeLessThanOrEqual(requestBudget(4096, opts));
    expect(fitted[0].content).toContain('system instructions compacted');
  });

  it('counts tool schemas against the context window', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Use a tool.' },
      { role: 'user', content: 'Find it.' },
    ];
    const withoutTools = tokens(messages, options(4096));
    const withTools = tokens(messages, options(4096, {
      tools: [{ name: 'find', description: 'x'.repeat(8000), parameters: { type: 'object', properties: {} } }],
    }));

    expect(withTools).toBeGreaterThan(withoutTools);
    expect(withTools - withoutTools).toBeGreaterThan(1000);
  });
});
