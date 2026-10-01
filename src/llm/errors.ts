export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class HeaderTimeoutError extends Error {
  constructor(message = 'Timed out waiting for response headers.') {
    super(message);
    this.name = 'HeaderTimeoutError';
  }
}

export class ResponseStreamError extends Error {
  constructor(message = 'Response stream stalled.') {
    super(message);
    this.name = 'ResponseStreamError';
  }
}

const OVERFLOW_PATTERNS = [
  /context.{0,20}(window|length|limit)/i,
  /maximum.{0,20}(context|token)/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input.{0,10}too long/i,
  /exceeds.{0,20}(context|token)/i,
];

export function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof HttpError && error.status !== 400 && error.status !== 413) {
    return false;
  }
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(error.message));
}

const REASONING_REJECTION_PATTERNS = [/reasoning/i, /thinking/i, /unsupported/i];

export function isReasoningRejection(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    REASONING_REJECTION_PATTERNS.some((pattern) => pattern.test(error.message))
  );
}

const STREAM_OPTIONS_REJECTION_PATTERNS = [/stream_options/i, /include_usage/i];

export function isStreamOptionsRejection(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    STREAM_OPTIONS_REJECTION_PATTERNS.some((pattern) => pattern.test(error.message))
  );
}

const BETA_HEADER_REJECTION_PATTERNS = [/beta/i, /header/i, /interleaved/i];

export function isBetaHeaderRejection(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    BETA_HEADER_REJECTION_PATTERNS.some((pattern) => pattern.test(error.message))
  );
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof HeaderTimeoutError || error instanceof ResponseStreamError) {
    return true;
  }
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('fetch failed') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('socket hang up')
    );
  }
  return false;
}
