import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderTimeoutError, ResponseStreamError, isRetryableError } from '../src/llm/errors';
import { fetchWithTimeouts } from '../src/llm/timeout';
import { chatWithRetry } from '../src/llm/retry';
import { LLMProvider, StreamEvent } from '../src/llm/types';

function stalledResponse(firstChunk?: string): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent && firstChunk) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(firstChunk));
      }
      return new Promise<void>(() => undefined);
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

function flowingResponse(chunks: string[], gapMs: number): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(chunks[index++]));
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWithTimeouts', () => {
  it('aborts when response headers never arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    await expect(fetchWithTimeouts('https://example.test', {}, { headerMs: 20, idleMs: 0 })).rejects.toBeInstanceOf(
      HeaderTimeoutError,
    );
  });

  it('aborts an SSE body that stalls after the last chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stalledResponse('data: hi\n\n')));
    const response = await fetchWithTimeouts('https://example.test', {}, { headerMs: 0, idleMs: 25 });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: hi\n\n');
    await expect(reader.read()).rejects.toBeInstanceOf(ResponseStreamError);
  });

  it('keeps a flowing SSE stream alive by resetting the idle timer per chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => flowingResponse(['a', 'b', 'c', 'd'], 10)));
    const response = await fetchWithTimeouts('https://example.test', {}, { headerMs: 0, idleMs: 30 });
    expect(await response.text()).toBe('abcd');
  });

  it('returns non-SSE responses untouched', async () => {
    const original = new Response('{}', { headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async () => original));
    const response = await fetchWithTimeouts('https://example.test', {}, { headerMs: 0, idleMs: 10 });
    expect(response).toBe(original);
  });

  it('disables both timeouts when the values are zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return stalledResponse('data: one\n\n');
      }),
    );
    const response = await fetchWithTimeouts('https://example.test', {}, { headerMs: 0, idleMs: 0 });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await reader.cancel();
  });

  it('marks timeout errors as retryable for chatWithRetry', async () => {
    expect(isRetryableError(new HeaderTimeoutError())).toBe(true);
    expect(isRetryableError(new ResponseStreamError())).toBe(true);

    let attempts = 0;
    const provider: LLMProvider = {
      id: 'fake',
      async *chat() {
        attempts++;
        if (attempts < 2) {
          throw new HeaderTimeoutError('headers stalled');
        }
        yield { type: 'text', text: 'ok' } as StreamEvent;
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const events: StreamEvent[] = [];
    for await (const event of chatWithRetry(
      provider,
      [{ role: 'user', content: 'hi' }],
      { model: 'm' },
      { delayFn: async () => undefined },
    )) {
      events.push(event);
    }
    expect(attempts).toBe(2);
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
