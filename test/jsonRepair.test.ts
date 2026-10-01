import { describe, expect, it } from 'vitest';
import { parseToolArguments, repairJson } from '../src/agent/jsonRepair';

describe('repairJson', () => {
  it('strips code fences', () => {
    expect(JSON.parse(repairJson('```json\n{"path":"a.ts"}\n```'))).toEqual({ path: 'a.ts' });
  });

  it('removes trailing commas', () => {
    expect(JSON.parse(repairJson('{"a":1,}'))).toEqual({ a: 1 });
    expect(JSON.parse(repairJson('{"a":[1,2,],}'))).toEqual({ a: [1, 2] });
  });

  it('escapes unescaped newlines inside strings', () => {
    expect(JSON.parse(repairJson('{"text":"line1\nline2"}'))).toEqual({ text: 'line1\nline2' });
  });

  it('closes truncated strings and structures', () => {
    expect(JSON.parse(repairJson('{"path":"a.ts","content":"hello'))).toEqual({
      path: 'a.ts',
      content: 'hello',
    });
    expect(JSON.parse(repairJson('{"todos":[{"text":"a","status":"pending"'))).toEqual({
      todos: [{ text: 'a', status: 'pending' }],
    });
  });

  it('leaves valid json untouched', () => {
    const input = '{"a":"has, comma","b":[1,2]}';
    expect(JSON.parse(repairJson(input))).toEqual(JSON.parse(input));
  });
});

describe('parseToolArguments', () => {
  it('returns an empty object for empty input', () => {
    expect(parseToolArguments('')).toEqual({});
  });

  it('parses valid json directly', () => {
    expect(parseToolArguments('{"path":"a.ts"}')).toEqual({ path: 'a.ts' });
  });

  it('repairs fenced json with a trailing comma', () => {
    expect(parseToolArguments('```json\n{"path":"a.ts",}\n```')).toEqual({ path: 'a.ts' });
  });

  it('throws a descriptive error telling the model to re-emit', () => {
    expect(() => parseToolArguments('totally not json')).toThrow(/valid JSON/);
  });
});
