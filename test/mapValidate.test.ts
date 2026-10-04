import { describe, expect, it } from 'vitest';
import { validateMermaidMap } from '../src/architecture/mapValidate';

const base = [
  'flowchart TD',
  '  root["App"]',
  '  root --> api["API"]',
  '  api --> db["Database"]',
].join('\n');

function existsIn(paths: string[]): (relativePath: string) => boolean {
  return (relativePath) => paths.includes(relativePath);
}

describe('validateMermaidMap', () => {
  it('accepts a clean map and extracts the PATHS block', () => {
    const raw = `${base}\n%% PATHS\n%% root = ./src\n%% api = src/api\n%% db = src/db.ts\n`;
    const result = validateMermaidMap(raw, existsIn(['src', 'src/api', 'src/db.ts']));

    expect(result).toBeDefined();
    expect(result?.mermaid).toBe(base);
    expect(result?.paths).toEqual({ root: 'src', api: 'src/api', db: 'src/db.ts' });
    expect(result?.mermaid).not.toContain('%%');
  });

  it('strips markdown fences', () => {
    const fenced = '```mermaid\n' + base + '\n```';
    const result = validateMermaidMap(fenced, () => true);
    expect(result?.mermaid).toBe(base);
    expect(result?.paths).toEqual({});

    const tilde = '~~~\n' + base + '\n~~~';
    expect(validateMermaidMap(tilde, () => true)?.mermaid).toBe(base);
  });

  it('accepts graph as the opening keyword', () => {
    const raw = 'graph LR\n  a["A"] --> b["B"]';
    expect(validateMermaidMap(raw, () => true)?.mermaid).toBe(raw);
  });

  it('rejects prose and empty input', () => {
    expect(validateMermaidMap(`Here is the map:\n${base}`, () => true)).toBeUndefined();
    expect(validateMermaidMap('', () => true)).toBeUndefined();
    expect(validateMermaidMap('Just some text', () => true)).toBeUndefined();
  });

  it('rejects click, style, linkStyle, classDef, and HTML directives', () => {
    expect(validateMermaidMap(`${base}\n  click api "http://x"`, () => true)).toBeUndefined();
    expect(validateMermaidMap(`${base}\n  style api fill:#fff`, () => true)).toBeUndefined();
    expect(validateMermaidMap(`${base}\n  linkStyle 0 stroke:#000`, () => true)).toBeUndefined();
    expect(validateMermaidMap(`${base}\n  classDef bad fill:#f00`, () => true)).toBeUndefined();
    expect(validateMermaidMap(`${base}\n  script <script>alert(1)</script>`, () => true)).toBeUndefined();
    expect(validateMermaidMap(`${base}\n  html <div>oops</div>`, () => true)).toBeUndefined();
  });

  it('rejects unbalanced brackets and quotes', () => {
    expect(validateMermaidMap('flowchart TD\n  a["oops]', () => true)).toBeUndefined();
    expect(validateMermaidMap('flowchart TD\n  a("oops"', () => true)).toBeUndefined();
    expect(validateMermaidMap('flowchart TD\n  a["oops"', () => true)).toBeUndefined();
    expect(validateMermaidMap('flowchart TD\n  a["oops"]', () => true)).toBeDefined();
  });

  it('drops paths that fail the exists check', () => {
    const raw = `${base}\n%% PATHS\n%% root = src\n%% api = src/gone\n%% db = src/db.ts\n`;
    const result = validateMermaidMap(raw, existsIn(['src', 'src/db.ts']));
    expect(result?.paths).toEqual({ root: 'src', db: 'src/db.ts' });
  });

  it('normalizes backslashes, leading ./, and quoted paths', () => {
    const raw = `${base}\n%% PATHS\n%% a = "src/app.ts"\n%% b = src\\win\\file.ts\n%% c = ./src/c.ts\n%% d = src\\nested\\util.ts\n`;
    const result = validateMermaidMap(raw, () => true);
    expect(result?.paths).toEqual({
      a: 'src/app.ts',
      b: 'src/win/file.ts',
      c: 'src/c.ts',
      d: 'src/nested/util.ts',
    });
  });

  it('rejects %% lines outside the PATHS block and malformed PATHS lines', () => {
    expect(validateMermaidMap(`${base}\n%% stray comment`, () => true)).toBeUndefined();
    expect(validateMermaidMap(`%% stray comment\n${base}`, () => true)).toBeUndefined();
    expect(validateMermaidMap(`${base}\n%% PATHS\n%% not a path`, () => true)).toBeUndefined();
    expect(validateMermaidMap(`${base}\n%% PATHS\n%% ok = src/a.ts\nprose`, () => true)).toBeUndefined();
  });

  it('counts brackets inside quoted labels without unbalancing', () => {
    const raw = 'flowchart TD\n  a["Price (USD)"]\n  b["List [x]"]\n';
    const result = validateMermaidMap(raw, () => true);
    expect(result?.mermaid).toBe(raw.trim());
  });
});
