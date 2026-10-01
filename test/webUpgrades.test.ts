import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampTimeoutSeconds, fetchUrl, htmlToMarkdown, parseDuckDuckGoResults } from '../src/agent/web';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('htmlToMarkdown', () => {
  it('maps headings, links, lists and code to markdown', () => {
    const html =
      '<html><head><style>body{color:red}</style></head><body>' +
      '<script>alert(1)</script>' +
      '<h1>Title</h1><p>See <a href="https://x.dev">docs</a>.</p>' +
      '<ul><li>one</li><li>two</li></ul>' +
      '<pre><code class="language-ts">const a = 1;</code></pre>' +
      '</body></html>';
    const markdown = htmlToMarkdown(html);
    expect(markdown).toContain('# Title');
    expect(markdown).toContain('[docs](https://x.dev)');
    expect(markdown).toContain('- one\n- two');
    expect(markdown).toContain('```ts\nconst a = 1;\n```');
    expect(markdown).not.toContain('alert');
    expect(markdown).not.toContain('color');
  });
});

describe('timeout clamping', () => {
  it('defaults to 30s and clamps to 120s', () => {
    expect(clampTimeoutSeconds(undefined)).toBe(30);
    expect(clampTimeoutSeconds(0)).toBe(30);
    expect(clampTimeoutSeconds(-5)).toBe(30);
    expect(clampTimeoutSeconds(10)).toBe(10);
    expect(clampTimeoutSeconds('45')).toBe(45);
    expect(clampTimeoutSeconds(500)).toBe(120);
  });
});

describe('fetchUrl', () => {
  it('negotiates text/markdown and converts html responses', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('<h2>Hello</h2><p>Use <code>npm test</code>.</p>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchUrl('https://example.com/docs', 30_000);
    expect(result).toContain('## Hello');
    expect(result).toContain('`npm test`');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(String(init.headers && (init.headers as Record<string, string>).accept)).toContain('text/markdown');
  });

  it('retries a Cloudflare 403 once with an honest user agent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('blocked', { status: 403, headers: { 'cf-mitigated': 'challenge' } }))
      .mockResolvedValueOnce(
        new Response('<h1>Recovered</h1>', { status: 200, headers: { 'content-type': 'text/html' } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchUrl('https://example.com/page', 30_000);
    expect(result).toContain('# Recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1] as RequestInit;
    const second = fetchMock.mock.calls[1][1] as RequestInit;
    expect((first.headers as Record<string, string>)['user-agent']).toContain('Mozilla/5.0');
    expect((second.headers as Record<string, string>)['user-agent']).toBe('Dev-First/0.1 (coding agent)');
  });

  it('does not retry a 403 without cf-mitigated', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchUrl('https://example.com/page', 30_000);
    expect(result).toContain('HTTP 403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('duckduckgo parsing', () => {
  const html = [
    '<div class="result__body">',
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>',
    '<a class="result__snippet" href="x">Read the <b>docs</b> here.</a>',
    '</div>',
    '<div class="result__body">',
    '<a class="result__a" href="https://second.example/page">Second <em>result</em></a>',
    '<div class="result__snippet">Another result.</div>',
    '</div>',
  ].join('\n');

  it('pairs titles with their snippets and unwraps redirect urls', () => {
    const results = parseDuckDuckGoResults(html, 5);
    expect(results).toEqual([
      { title: 'Example Docs', url: 'https://example.com/docs', snippet: 'Read the docs here.' },
      { title: 'Second result', url: 'https://second.example/page', snippet: 'Another result.' },
    ]);
  });

  it('caps the number of results', () => {
    expect(parseDuckDuckGoResults(html, 1)).toHaveLength(1);
  });
});
