import { HeaderTimeoutError, ResponseStreamError } from './errors';

export interface FetchTimeouts {
  headerMs: number;
  idleMs: number;
}

export interface FetchTimeoutOptions extends FetchTimeouts {
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

export function resolveTimeouts(timeouts?: Partial<FetchTimeouts>): FetchTimeouts {
  return {
    headerMs: Math.max(0, timeouts?.headerMs ?? DEFAULT_TIMEOUT_MS),
    idleMs: Math.max(0, timeouts?.idleMs ?? DEFAULT_TIMEOUT_MS),
  };
}

export async function fetchWithTimeouts(
  url: string,
  init: RequestInit,
  opts: FetchTimeoutOptions,
): Promise<Response> {
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.headerMs > 0) {
    headerTimer = setTimeout(
      () => controller.abort(new HeaderTimeoutError(`No response headers after ${opts.headerMs}ms.`)),
      opts.headerMs,
    );
  }

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof HeaderTimeoutError) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(headerTimer);
  }

  const contentType = response.headers?.get?.('content-type') ?? '';
  if (opts.idleMs > 0 && response.body && contentType.includes('text/event-stream')) {
    return withIdleTimeout(response, opts.idleMs);
  }
  return response;
}

function withIdleTimeout(response: Response, idleMs: number): Response {
  const reader = response.body!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const fail = () => {
    if (finished) {
      return;
    }
    finished = true;
    clear();
    const error = new ResponseStreamError(`No stream data for ${idleMs}ms.`);
    void reader.cancel(error).catch(() => undefined);
    try {
      controller?.error(error);
    } catch {}
  };
  const arm = () => {
    clear();
    timer = setTimeout(fail, idleMs);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      arm();
    },
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (finished) {
          return;
        }
        clear();
        if (done) {
          finished = true;
          try {
            streamController.close();
          } catch {}
          return;
        }
        arm();
        streamController.enqueue(value);
      } catch (error) {
        if (finished) {
          return;
        }
        finished = true;
        clear();
        try {
          streamController.error(error);
        } catch {}
      }
    },
    cancel(reason) {
      finished = true;
      clear();
      void reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
