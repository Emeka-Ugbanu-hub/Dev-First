export async function* sseLines(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) {
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          yield line;
        }
      }
    }
    const rest = buffer.replace(/\r$/, '').trim();
    if (rest.length > 0) {
      yield rest;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function formatHttpError(response: Response): Promise<string> {
  let detail = '';
  try {
    detail = await response.text();
  } catch {
    detail = '';
  }
  const trimmed = detail.length > 800 ? `${detail.slice(0, 800)}...` : detail;
  return `HTTP ${response.status} ${response.statusText}${trimmed ? `: ${trimmed}` : ''}`;
}

export function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}
