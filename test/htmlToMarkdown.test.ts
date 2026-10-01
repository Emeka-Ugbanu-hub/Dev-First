import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../webview/src/lib/htmlToMarkdown';

describe('htmlToMarkdown', () => {
  it('converts code blocks with language', () => {
    const html = '<pre><code class="hljs language-ts">const a = 1;</code></pre>';
    expect(htmlToMarkdown(html)).toBe('```ts\nconst a = 1;\n```');
  });

  it('converts inline code, bold and links', () => {
    const html = 'use <code>npm test</code> and <strong>be careful</strong> — see <a href="https://x.dev">docs</a>';
    expect(htmlToMarkdown(html)).toBe('use `npm test` and **be careful** — see [docs](https://x.dev)');
  });

  it('converts headings and lists', () => {
    const html = '<h3>Title</h3><ul><li>one</li><li>two</li></ul>';
    expect(htmlToMarkdown(html)).toBe('### Title\n\n- one\n- two');
  });

  it('converts blockquotes', () => {
    expect(htmlToMarkdown('<blockquote>quoted</blockquote>')).toBe('> quoted');
  });

  it('decodes entities and collapses blank lines', () => {
    expect(htmlToMarkdown('<p>a &amp; b</p><p>c</p>')).toBe('a & b\n\nc');
  });

  it('handles nested markup inside a paragraph', () => {
    const html = '<p>Run <code>x</code> with <strong>flag</strong>.</p>';
    expect(htmlToMarkdown(html)).toBe('Run `x` with **flag**.');
  });
});
