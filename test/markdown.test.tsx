import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../webview/src/lib/markdown';

function render(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe('Markdown', () => {
  it('renders headings and paragraphs', () => {
    const html = render('# Title\n\nHello world');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('Hello world');
  });

  it('renders gfm tables', () => {
    const html = render('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders fenced code blocks with highlighting', () => {
    const html = render('```ts\nconst x = 1;\n```');
    expect(html).toContain('code-block');
    expect(html).toContain('hljs');
    expect(html).toContain('const');
  });

  it('renders links with an href', () => {
    const html = render('[docs](https://example.com)');
    expect(html).toContain('href="https://example.com"');
  });

  it('renders inline code', () => {
    const html = render('use `npm test` to run');
    expect(html).toContain('<code>npm test</code>');
  });

  it('keeps single line breaks inside a paragraph', () => {
    const html = render('**WHAT**\nIt seeds the setting on first launch.');
    expect(html).toMatch(/<br\s*\/?>/);
    expect(html).toContain('<strong>WHAT</strong>');
  });
});
