import { describe, expect, it } from 'vitest';
import { normalizeLinks, parseLearnMore } from '../src/resources/LearnMoreService';
import { domainOf } from '../webview/src/lib/domains';

describe('normalizeLinks', () => {
  it('keeps valid links, dedupes urls, and caps the list', () => {
    const links = normalizeLinks([
      { title: 'A', url: 'https://a.dev', why: ' because ' },
      { title: 'A again', url: 'https://a.dev' },
      { title: 'B', url: 'https://b.dev' },
      { title: 'C', url: 'https://c.dev' },
      { title: 'D', url: 'https://d.dev' },
      { title: 'E', url: 'https://e.dev' },
      { title: 'bad', url: 'javascript:alert(1)' },
      { url: 'https://no-title.dev' },
      'nope',
    ]);
    expect(links.map((link) => link.url)).toEqual([
      'https://a.dev',
      'https://b.dev',
      'https://c.dev',
      'https://d.dev',
    ]);
    expect(links[0].why).toBe('because');
    expect(links[1].why).toBeUndefined();
  });
});

describe('parseLearnMore', () => {
  it('parses fenced JSON output', () => {
    const parsed = parseLearnMore(
      '```json\n{"chosen":[{"title":"Docs","url":"https://docs.dev","why":"official"}],"alternatives":[]}\n```',
    );
    expect(parsed?.chosen).toHaveLength(1);
    expect(parsed?.alternatives).toHaveLength(0);
  });

  it('returns undefined for empty or invalid output', () => {
    expect(parseLearnMore('no json here')).toBeUndefined();
    expect(parseLearnMore('{"chosen":[],"alternatives":[]}')).toBeUndefined();
  });
});

describe('domainOf', () => {
  it('strips protocol and www', () => {
    expect(domainOf('https://www.example.com/path')).toBe('example.com');
    expect(domainOf('https://docs.python.org/3/')).toBe('docs.python.org');
    expect(domainOf('not a url')).toBe('not a url');
  });
});
