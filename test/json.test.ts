import { describe, expect, it } from 'vitest';
import { extractBalanced, parseJsonLoose, stripCodeFences } from '../src/util/json';

describe('stripCodeFences', () => {
  it('extracts fenced json', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('returns plain text unchanged', () => {
    expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('extractBalanced', () => {
  it('extracts an object with nested braces', () => {
    expect(extractBalanced('prefix {"a":{"b":2}} suffix')).toBe('{"a":{"b":2}}');
  });

  it('handles braces inside strings', () => {
    expect(extractBalanced('{"text":"has } brace"}')).toBe('{"text":"has } brace"}');
  });

  it('returns undefined when no json exists', () => {
    expect(extractBalanced('no json here')).toBeUndefined();
  });
});

describe('parseJsonLoose', () => {
  it('parses fenced json', () => {
    expect(parseJsonLoose('```json\n{"steps":["a"]}\n```')).toEqual({ steps: ['a'] });
  });

  it('parses json surrounded by prose', () => {
    expect(parseJsonLoose('Here is the plan: {"what":"do it"} hope that helps')).toEqual({ what: 'do it' });
  });

  it('parses json with control characters', () => {
    expect(parseJsonLoose('{"a":"b\u0000c"}')).toEqual({ a: 'bc' });
  });

  it('returns undefined for unparseable text', () => {
    expect(parseJsonLoose('just a sentence')).toBeUndefined();
  });
});
