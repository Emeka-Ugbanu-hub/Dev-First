import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/llm/types';
import {
  RETRIEVED_CONTEXT_HEADER,
  composePlannerRequest,
  relevanceBudget,
  selectPlannerConversation,
} from '../src/planner/relevance';
import type { SessionContextEntry } from '../src/session/SessionStore';
import { buildContextEntry, mergeContextMetadata, messageHash } from '../src/session/contextIndex';

function contextEntry(
  index: number,
  message: ChatMessage,
  update: Parameters<typeof mergeContextMetadata>[1],
): SessionContextEntry {
  return mergeContextMetadata(buildContextEntry(message, index), update);
}

describe('planner relevance selection', () => {
  it('keeps recent context and selects older messages sharing task anchors', () => {
    const messages = [
      ...Array.from({ length: 8 }, (_, index) => ({ role: 'user' as const, content: `old unrelated topic ${index}` })),
      { role: 'user' as const, content: 'Earlier scanner persistence decision for SessionController' },
      ...Array.from({ length: 8 }, (_, index) => ({ role: 'assistant' as const, content: `recent context ${index}` })),
      { role: 'user' as const, content: 'Can we continue the scanner persistence decision?' },
    ];
    const selected = selectPlannerConversation(messages);
    expect(selected).toContain(messages[8]);
    expect(selected).toContain(messages[messages.length - 1]);
    expect(selected.length).toBeLessThan(messages.length);
  });

  it('does not filter short conversations', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }];
    expect(selectPlannerConversation(messages)).toEqual(messages);
  });

  it('does not retrieve old work for a greeting', () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, index) => ({ role: 'assistant' as const, content: `old work ${index}` })),
      { role: 'user' as const, content: 'hi' },
    ];
    expect(selectPlannerConversation(messages)).toHaveLength(2);
  });

  it('keeps older decision context even when it does not share words with the latest turn', () => {
    const messages = [
      { role: 'user' as const, content: 'Approved the recovery design; keep the journal durable.' },
      ...Array.from({ length: 14 }, (_, index) => ({ role: 'assistant' as const, content: `unrelated history ${index}` })),
      { role: 'user' as const, content: 'Continue with the implementation.' },
    ];
    const selected = selectPlannerConversation(messages, 1, [contextEntry(0, messages[0], { decisionIds: ['decision-context'] })]);
    expect(selected).toContain(messages[0]);
  });

  it('ranks direct file links above text overlaps and drops unrelated history', () => {
    const linked = { role: 'user' as const, content: 'Earlier notes about the storage module.' };
    const overlap = { role: 'assistant' as const, content: 'session store review notes' };
    const messages: ChatMessage[] = [
      linked,
      overlap,
      ...Array.from({ length: 12 }, (_, index) => ({ role: 'assistant' as const, content: `unrelated history ${index}` })),
      { role: 'user' as const, content: 'continue work on src/session/SessionStore.ts' },
    ];
    const index = [
      contextEntry(0, linked, { files: ['src/session/SessionStore.ts'] }),
      contextEntry(1, overlap, { symbols: ['store'] }),
    ];
    const selected = selectPlannerConversation(messages, { maxOlder: 2, maxTokens: 2000 }, index);
    expect(selected).toContain(linked);
    expect(selected).not.toContain(messages[2]);
  });

  it('includes multiple candidates and an earlier-work summary when the top scores tie', () => {
    const first = { role: 'user' as const, content: 'Earlier pass over the storage module.' };
    const second = { role: 'assistant' as const, content: 'Also revisited the storage module.' };
    const messages: ChatMessage[] = [
      first,
      second,
      ...Array.from({ length: 10 }, (_, index) => ({ role: 'assistant' as const, content: `unrelated history ${index}` })),
      ...Array.from({ length: 3 }, (_, index) => ({ role: 'user' as const, content: `recent note ${index}` })),
      { role: 'user' as const, content: 'continue work on src/session/SessionStore.ts' },
    ];
    const index = [
      contextEntry(0, first, { files: ['src/session/SessionStore.ts'] }),
      contextEntry(1, second, { files: ['src/session/SessionStore.ts'] }),
    ];
    const result = composePlannerRequest({ conversation: messages, contextIndex: index });
    expect(result.retrieved).toBe(true);
    expect(result.ambiguous).toBe(true);
    expect(result.messages).toContain(first);
    expect(result.messages).toContain(second);
    expect(result.summary).toContain('Earlier work');
    expect(result.messages.some((message) => message.content === result.summary)).toBe(true);
  });

  it('honors the per-tier older-message budget', () => {
    const anchor = 'src/session/SessionStore.ts';
    const linked = { role: 'user' as const, content: 'Earlier notes on the storage module.' };
    const filler = Array.from({ length: 20 }, (_, index) => ({
      role: 'assistant' as const,
      content: `architecture review note ${index}`,
    }));
    const messages: ChatMessage[] = [
      linked,
      ...filler,
      { role: 'user' as const, content: `architecture review of ${anchor}` },
    ];
    const index = [contextEntry(0, linked, { files: [anchor] })];
    const selectedFor = (tier: string) =>
      selectPlannerConversation(messages, relevanceBudget(tier), index).length - 8;
    expect(selectedFor('compact')).toBe(4);
    expect(selectedFor('standard')).toBe(8);
    expect(selectedFor('large')).toBe(12);
    const tokenCapped = selectPlannerConversation(messages, { maxOlder: 8, maxTokens: 1 }, index);
    expect(tokenCapped.length - 8).toBe(1);
  });

  it('adds the retrieval header only when older messages were retrieved', () => {
    const anchor = 'src/session/SessionStore.ts';
    const linked = { role: 'user' as const, content: 'Earlier notes on the storage module.' };
    const messages: ChatMessage[] = [
      linked,
      ...Array.from({ length: 13 }, (_, index) => ({ role: 'assistant' as const, content: `unrelated history ${index}` })),
      { role: 'user' as const, content: `continue work on ${anchor}` },
    ];
    const index = [contextEntry(0, linked, { files: [anchor] })];
    const retrieved = composePlannerRequest({ conversation: messages, contextIndex: index });
    expect(retrieved.messages[0]).toEqual({ role: 'system', content: RETRIEVED_CONTEXT_HEADER });

    const short = composePlannerRequest({ conversation: messages.slice(-3), contextIndex: index });
    expect(short.messages.some((message) => message.content === RETRIEVED_CONTEXT_HEADER)).toBe(false);

    const greeting = composePlannerRequest({
      conversation: [...messages.slice(0, -1), { role: 'user', content: 'hi' }],
      contextIndex: index,
    });
    expect(greeting.retrieved).toBe(false);
    expect(greeting.messages.some((message) => message.content === RETRIEVED_CONTEXT_HEADER)).toBe(false);
  });

  it('always includes the pinned context, newest request first and exempt from budgets', () => {
    const anchor = 'src/session/SessionStore.ts';
    const linked = { role: 'user' as const, content: 'Earlier notes on the storage module.' };
    const latest = { role: 'user' as const, content: `continue work on ${anchor}` };
    const messages: ChatMessage[] = [
      linked,
      ...Array.from({ length: 12 }, (_, index) => ({ role: 'assistant' as const, content: `unrelated history ${index}` })),
      latest,
    ];
    const index = [contextEntry(0, linked, { files: [anchor] })];
    const pinned = {
      latestUserMessage: latest.content,
      changedFiles: ['src/a.ts'],
      diagnosticsSummary: '2 errors',
    };
    const result = composePlannerRequest({
      conversation: messages,
      contextIndex: index,
      budget: { maxOlder: 1, maxTokens: 1 },
      pinned,
    });
    const pinnedMessage = result.messages.find((message) => message.content.startsWith('[Pinned context'));
    expect(pinnedMessage).toBeDefined();
    expect(pinnedMessage?.content.split('\n')[1]).toBe(`Latest request: ${latest.content}`);
    expect(pinnedMessage?.content).toContain('Changed files: src/a.ts');
    expect(pinnedMessage?.content).toContain('Diagnostics: 2 errors');
    expect(result.messages).toContain(latest);
  });

  it('compacts only the selected projection, never the full conversation', () => {
    const anchor = 'src/session/SessionStore.ts';
    const linked = { role: 'user' as const, content: 'Earlier notes on the storage module.' };
    const omitted = 'unrelated history 0';
    const messages: ChatMessage[] = [
      linked,
      ...Array.from({ length: 13 }, (_, index) => ({ role: 'assistant' as const, content: `unrelated history ${index}` })),
      { role: 'user' as const, content: `continue work on ${anchor}` },
    ];
    const index = [contextEntry(0, linked, { files: [anchor] })];
    const compact = vi.fn((assembled: ChatMessage[]) => assembled);
    const result = composePlannerRequest({
      conversation: messages,
      contextIndex: index,
      pinned: { latestUserMessage: messages[messages.length - 1].content, changedFiles: [] },
      compact,
    });
    expect(compact).toHaveBeenCalledTimes(1);
    const assembled = compact.mock.calls[0][0];
    expect(assembled.length).toBeLessThan(messages.length);
    expect(assembled.some((message) => message.content === omitted)).toBe(false);
    expect(assembled.some((message) => message.content === linked.content)).toBe(true);
    expect(result.messages).toEqual(assembled);
  });

  it('retrieves archived messages when the latest turn links to them', () => {
    const archived = { role: 'user' as const, content: 'Earlier pass over src/session/SessionStore.ts.' };
    const active: ChatMessage[] = [
      ...Array.from({ length: 14 }, (_, index) => ({ role: 'assistant' as const, content: `recent work ${index}` })),
      { role: 'user' as const, content: 'continue work on src/session/SessionStore.ts' },
    ];
    const index = [contextEntry(0, archived, { files: ['src/session/SessionStore.ts'] })];
    const selected = selectPlannerConversation(active, { maxOlder: 4, maxTokens: 2000 }, [], {
      archived: [archived],
      archivedContextIndex: index,
    });
    expect(selected).toContain(archived);
  });

  it('reports deterministic hashes for messages', () => {
    const message = { role: 'user' as const, content: 'stable content' };
    expect(messageHash(message)).toBe(messageHash({ ...message }));
  });
});
