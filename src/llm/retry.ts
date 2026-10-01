import { ChatMessage, ChatOptions, LLMProvider, StreamEvent } from './types';
import { isRetryableError } from './errors';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  delayFn?: (ms: number) => Promise<void>;
  retryOnEmpty?: boolean;
}

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function* chatWithRetry(
  provider: LLMProvider,
  messages: ChatMessage[],
  options: ChatOptions,
  retry: RetryOptions = {},
): AsyncGenerator<StreamEvent> {
  const attempts = retry.attempts ?? 3;
  const baseDelay = retry.baseDelayMs ?? 500;

  for (let attempt = 0; ; attempt++) {
    let forwarded = false;
    let sawContent = false;
    try {
      for await (const event of provider.chat(messages, options)) {
        forwarded = true;
        if (event.type === 'text' || event.type === 'toolCall') {
          sawContent = true;
        }
        yield event;
      }
      if (
        retry.retryOnEmpty &&
        !sawContent &&
        attempt < attempts &&
        !options.signal?.aborted
      ) {
        retry.onRetry?.(attempt + 1, new Error('empty response'), baseDelay);
        await (retry.delayFn ?? defaultDelay)(baseDelay);
        continue;
      }
      return;
    } catch (error) {
      const canRetry =
        !forwarded &&
        attempt < attempts &&
        isRetryableError(error) &&
        !options.signal?.aborted;
      if (!canRetry) {
        throw error;
      }
      const delayMs = baseDelay * Math.pow(3, attempt);
      retry.onRetry?.(attempt + 1, error, delayMs);
      await (retry.delayFn ?? defaultDelay)(delayMs);
    }
  }
}
