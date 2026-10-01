export interface FimRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prefix: string;
  suffix: string;
  signal: AbortSignal;
}

export function buildFimPrompt(prefix: string, suffix: string): { prompt: string; suffix: string } {
  const prompt = trimToBoundary(prefix, 2000, 'start');
  const tail = trimToBoundary(suffix, 800, 'end');
  return { prompt, suffix: tail };
}

function trimToBoundary(text: string, max: number, side: 'start' | 'end'): string {
  if (text.length <= max) {
    return text;
  }
  const slice = side === 'start' ? text.slice(text.length - max) : text.slice(0, max);
  const newline = side === 'start' ? slice.indexOf('\n') : slice.lastIndexOf('\n');
  if (newline === -1) {
    return slice;
  }
  return side === 'start' ? slice.slice(newline + 1) : slice.slice(0, newline);
}

export function parseFimResponse(json: unknown): string | undefined {
  const choice = (json as any)?.choices?.[0];
  if (!choice) {
    return undefined;
  }
  const text =
    typeof choice.text === 'string'
      ? choice.text
      : typeof choice.message?.content === 'string'
        ? choice.message.content
        : undefined;
  if (!text) {
    return undefined;
  }
  const cleaned = text.replace(/^```[\w-]*\n/, '').replace(/\n```$/, '');
  return cleaned.trim() ? cleaned : undefined;
}

export async function fetchFim(request: FimRequest): Promise<string | undefined> {
  const { prompt, suffix } = buildFimPrompt(request.prefix, request.suffix);
  if (!prompt.trim()) {
    return undefined;
  }
  const response = await fetch(`${request.baseUrl.replace(/\/+$/, '')}/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${request.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      prompt,
      suffix,
      max_tokens: 256,
      temperature: 0.2,
      stop: ['\n\n\n'],
    }),
    signal: request.signal,
  });
  if (!response.ok) {
    return undefined;
  }
  const json = await response.json();
  return parseFimResponse(json);
}
