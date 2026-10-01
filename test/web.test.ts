import { describe, expect, it } from 'vitest';
import { stripHtml } from '../src/agent/web';

describe('stripHtml', () => {
  it('removes scripts and styles', () => {
    const html = '<html><head><style>body{color:red}</style></head><body><script>alert(1)</script><p>Hello</p></body></html>';
    const text = stripHtml(html);
    expect(text).toBe('Hello');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color');
  });

  it('turns block boundaries into newlines', () => {
    const text = stripHtml('<p>one</p><p>two</p><div>three</div>');
    expect(text.split('\n').map((line) => line.trim())).toEqual(['one', 'two', 'three']);
  });

  it('decodes common entities', () => {
    expect(stripHtml('<p>a &amp; b &lt; c &gt; d &#39;e&#39; &quot;f&quot;</p>')).toBe(
      `a & b < c > d 'e' "f"`,
    );
  });

  it('collapses whitespace', () => {
    const text = stripHtml('<p>a</p>\n\n\n\n<p>b</p>');
    expect(text).toBe('a\n\nb');
  });
});
