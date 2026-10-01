import { describe, expect, it } from 'vitest';
import { chatWithRetry } from '../src/llm/retry';
import { HttpError } from '../src/llm/errors';
import { LLMProvider, StreamEvent } from '../src/llm/types';

interface FakeProvider extends LLMProvider {
  attempts: number;
}

function makeProvider(failures: number, error: unknown, events: StreamEvent[] = []): FakeProvider {
  const provider: FakeProvider = {
    id: 'fake',
    attempts: 0,
    async *chat() {
      provider.attempts++;
      if (provider.attempts <= failures) {
        throw error;
      }
      for (const event of events) {
        yield event;
      }
    },
    async listModels() {
      return [];
    },
    async embed() {
      return [];
    },
  };
  return provider;
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

const noDelay = async () => undefined;

describe('chatWithRetry', () => {
  it('retries transient errors and then succeeds', async () => {
    const provider = makeProvider(2, new HttpError(429, 'rate limited'), [{ type: 'text', text: 'ok' }]);
    const events = await collect(
      chatWithRetry(provider, [{ role: 'user', content: 'hi' }], { model: 'm' }, { delayFn: noDelay }),
    );
    expect(provider.attempts).toBe(3);
    expect(events).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('does not retry non-retryable errors', async () => {
    const provider = makeProvider(1, new HttpError(400, 'bad request'));
    await expect(
      collect(chatWithRetry(provider, [{ role: 'user', content: 'hi' }], { model: 'm' }, { delayFn: noDelay })),
    ).rejects.toThrow('bad request');
    expect(provider.attempts).toBe(1);
  });

  it('does not retry after events were forwarded', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      id: 'fake',
      async *chat() {
        attempts++;
        yield { type: 'text', text: 'partial' } as StreamEvent;
        throw new HttpError(500, 'stream died');
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    await expect(
      collect(chatWithRetry(provider, [{ role: 'user', content: 'hi' }], { model: 'm' }, { delayFn: noDelay })),
    ).rejects.toThrow('stream died');
    expect(attempts).toBe(1);
  });

  it('gives up after the attempt limit', async () => {
    const provider = makeProvider(10, new HttpError(503, 'unavailable'));
    await expect(
      collect(
        chatWithRetry(
          provider,
          [{ role: 'user', content: 'hi' }],
          { model: 'm' },
          { attempts: 3, delayFn: noDelay },
        ),
      ),
    ).rejects.toThrow('unavailable');
    expect(provider.attempts).toBe(4);
  });

  it('retries empty responses when retryOnEmpty is set', async () => {
    let attempts = 0;
    const provider: LLMProvider = {
      id: 'fake',
      async *chat() {
        attempts++;
        if (attempts < 2) {
          yield { type: 'done' } as StreamEvent;
          return;
        }
        yield { type: 'text', text: 'finally' } as StreamEvent;
        yield { type: 'done' } as StreamEvent;
      },
      async listModels() {
        return [];
      },
      async embed() {
        return [];
      },
    };
    const events = await collect(
      chatWithRetry(
        provider,
        [{ role: 'user', content: 'hi' }],
        { model: 'm' },
        { retryOnEmpty: true, delayFn: noDelay },
      ),
    );
    expect(attempts).toBe(2);
    expect(events.some((event) => event.type === 'text')).toBe(true);
  });

  it('does not retry network TypeErrors more than the limit', async () => {
    const provider = makeProvider(10, new TypeError('fetch failed'));
    await expect(
      collect(
        chatWithRetry(provider, [{ role: 'user', content: 'hi' }], { model: 'm' }, { attempts: 1, delayFn: noDelay }),
      ),
    ).rejects.toThrow('fetch failed');
    expect(provider.attempts).toBe(2);
  });
});
