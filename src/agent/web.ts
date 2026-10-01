const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Dev-First/0.1';
const HONEST_USER_AGENT = 'Dev-First/0.1 (coding agent)';
const ACCEPT_HEADER =
  'text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.1';
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;

export function clampTimeoutSeconds(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.floor(number)));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutSeconds: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), clampTimeoutSeconds(timeoutSeconds) * 1000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchUrl(
  url: string,
  maxChars: number,
  signal?: AbortSignal,
  timeoutSeconds?: number,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Error: invalid URL "${url}".`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Error: only http(s) URLs are supported.`;
  }
  const headers = { 'user-agent': USER_AGENT, accept: ACCEPT_HEADER };
  let response: Response;
  try {
    response = await fetchWithTimeout(parsed.toString(), { redirect: 'follow', headers }, timeoutSeconds, signal);
  } catch (error) {
    return `Error: request failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (response.status === 403 && response.headers.get('cf-mitigated')) {
    try {
      response = await fetchWithTimeout(
        parsed.toString(),
        { redirect: 'follow', headers: { 'user-agent': HONEST_USER_AGENT, accept: ACCEPT_HEADER } },
        timeoutSeconds,
        signal,
      );
    } catch (error) {
      return `Error: request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!response.ok) {
    return `Error: HTTP ${response.status} ${response.statusText}`;
  }
  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  const text = contentType.includes('html') ? htmlToMarkdown(body) : body;
  const limit = Math.max(1000, Math.min(maxChars || 30_000, 200_000));
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated at ${limit} chars]` : text;
}

export async function webSearch(query: string, maxResults: number, signal?: AbortSignal): Promise<string> {
  const body = new URLSearchParams({ q: query }).toString();
  let response: Response;
  try {
    response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'user-agent': USER_AGENT,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal,
    });
  } catch (error) {
    return `Error: search request failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!response.ok) {
    return `Error: search failed with HTTP ${response.status}.`;
  }
  const html = await response.text();
  const results = parseDuckDuckGoResults(html, Math.min(maxResults || 5, 10));
  if (results.length === 0) {
    return 'No results found.';
  }
  return results
    .map((result, i) => `${i + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ''}`)
    .join('\n\n');
}

export function parseDuckDuckGoResults(
  html: string,
  limit: number,
): Array<{ title: string; url: string; snippet: string }> {
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<(?:a|div)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
  const snippets: Array<{ index: number; text: string }> = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push({ index: snippetMatch.index, text: stripHtml(snippetMatch[1]) });
  }
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  let match: RegExpExecArray | null;
  let cursor = 0;
  while ((match = linkRegex.exec(html)) !== null && results.length < limit) {
    const url = normalizeDuckDuckGoUrl(match[1]);
    const title = stripHtml(match[2]) || htmlToMarkdown(match[2]);
    if (!url || !title) {
      continue;
    }
    while (cursor < snippets.length && snippets[cursor].index < match.index) {
      cursor++;
    }
    const snippet =
      cursor < snippets.length && snippets[cursor].index > match.index ? snippets[cursor++].text : '';
    results.push({ title, url, snippet });
  }
  return results;
}

function normalizeDuckDuckGoUrl(raw: string): string {
  let value = decodeEntities(raw).trim();
  if (value.startsWith('//')) {
    value = `https:${value}`;
  }
  try {
    const url = new URL(value, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    if (target) {
      return decodeURIComponent(target);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

const BLOCK_TAGS = 'p|div|section|article|header|footer';

export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  text = text.replace(
    /<pre[^>]*>\s*<code[^>]*class="[^"]*language-([\w-]+)[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, language, code) => `\n\n\`\`\`${language}\n${decodeEntities(stripTags(code))}\n\`\`\`\n\n`,
  );
  text = text.replace(
    /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, code) => `\n\n\`\`\`\n${decodeEntities(stripTags(code))}\n\`\`\`\n\n`,
  );
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => {
    return `\n\n${'#'.repeat(Number(level))} ${stripTags(content).trim()}\n\n`;
  });
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, content) => {
    return `\n\n${stripTags(content)
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => `\n- ${stripTags(content).trim()}`);
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
    const labelText = stripTags(label).trim();
    return href ? `[${labelText}](${decodeEntities(href)})` : labelText;
  });
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, content) => `**${stripTags(content).trim()}**`);
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, content) => `*${stripTags(content).trim()}*`);
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, code) => `\`${decodeEntities(stripTags(code))}\``);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(new RegExp(`</?(?:${BLOCK_TAGS})[^>]*>`, 'gi'), '\n\n');
  text = stripTags(text);

  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

export function stripHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const text = withBreaks.replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    try {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) {
        return String.fromCodePoint(parseInt(entity.slice(1), 10));
      }
      return named[entity] ?? match;
    } catch {
      return match;
    }
  });
}
