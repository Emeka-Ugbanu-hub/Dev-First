import { describe, expect, it } from 'vitest';
import {
  buildCompactedMessages,
  checkCompaction,
  chooseRecentStart,
  estimateTokens,
} from '../src/agent/compaction';
import { ChatMessage } from '../src/llm/types';

const system: ChatMessage = { role: 'system', content: 'system prompt' };
const spec: ChatMessage = { role: 'user', content: 'approved plan' };

function conversation(): ChatMessage[] {
  return [
    system,
    spec,
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: '{"path":"a"}' }] },
    { role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'file contents' },
    { role: 'assistant', content: 'editing now' },
    { role: 'user', content: 'keep going' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'edit_file', arguments: '{"path":"a"}' }] },
    { role: 'tool', toolCallId: 't2', toolName: 'edit_file', content: 'applied' },
  ];
}

describe('estimateTokens', () => {
  it('scales with content length', () => {
    const small = estimateTokens([{ role: 'user', content: 'hi' }]);
    const large = estimateTokens([{ role: 'user', content: 'x'.repeat(4000) }]);
    expect(large).toBeGreaterThan(small + 900);
  });

  it('counts tool call arguments', () => {
    const withCalls = estimateTokens([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't', name: 'edit_file', arguments: `{"path":"${'x'.repeat(400)}"}` }],
      },
    ]);
    expect(withCalls).toBeGreaterThan(90);
  });
});

describe('chooseRecentStart', () => {
  it('never starts on a tool message without its assistant parent', () => {
    const messages = conversation();
    const start = chooseRecentStart(messages, 1);
    expect(messages[start].role).not.toBe('tool');
  });

  it('keeps the system prompt and spec outside the compacted range', () => {
    const messages = conversation();
    const start = chooseRecentStart(messages, 1);
    expect(start).toBeGreaterThanOrEqual(2);
  });

  it('keeps everything when the budget is large', () => {
    const messages = conversation();
    expect(chooseRecentStart(messages, 1_000_000)).toBe(2);
  });
});

describe('buildCompactedMessages', () => {
  it('keeps head, inserts the summary, keeps the recent tail', () => {
    const messages = conversation();
    const start = chooseRecentStart(messages, 20);
    const compacted = buildCompactedMessages(messages, 'summary text', start);
    expect(compacted[0]).toEqual(system);
    expect(compacted[1]).toEqual(spec);
    expect(compacted[2].content).toContain('summary text');
    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[compacted.length - 1]).toEqual(messages[messages.length - 1]);
  });
});

describe('checkCompaction', () => {
  it('does not trigger for small conversations', () => {
    const check = checkCompaction(conversation(), 128_000);
    expect(check.needed).toBe(false);
  });

  it('triggers above the ratio', () => {
    const big: ChatMessage[] = [system, spec, { role: 'user', content: 'x'.repeat(400_000) }];
    const check = checkCompaction(big, 100_000);
    expect(check.needed).toBe(true);
    expect(check.recentStart).toBeGreaterThanOrEqual(2);
  });
});
