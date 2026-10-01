import { describe, expect, it } from 'vitest';
import { normalizeToolArguments } from '../src/util/toolArgs';

const schema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    start_line: { type: 'number' },
    replace_all: { type: 'boolean' },
    todos: { type: 'array', items: { type: 'object' } },
  },
};

describe('normalizeToolArguments', () => {
  it('parses stringified arrays to match the schema', () => {
    const raw = JSON.stringify({ todos: '[{"text":"a","status":"pending"}]' });
    const normalized = JSON.parse(normalizeToolArguments(raw, schema));
    expect(Array.isArray(normalized.todos)).toBe(true);
    expect(normalized.todos[0].text).toBe('a');
  });

  it('coerces numeric strings', () => {
    const normalized = JSON.parse(normalizeToolArguments('{"start_line":"12"}', schema));
    expect(normalized.start_line).toBe(12);
  });

  it('coerces boolean strings', () => {
    const normalized = JSON.parse(normalizeToolArguments('{"replace_all":"true"}', schema));
    expect(normalized.replace_all).toBe(true);
  });

  it('stringifies numbers for string fields', () => {
    const normalized = JSON.parse(normalizeToolArguments('{"path":123}', schema));
    expect(normalized.path).toBe('123');
  });

  it('leaves valid input untouched', () => {
    const raw = '{"path":"src/app.ts","start_line":5}';
    const normalized = JSON.parse(normalizeToolArguments(raw, schema));
    expect(normalized).toEqual({ path: 'src/app.ts', start_line: 5 });
  });

  it('returns the raw string when parsing fails', () => {
    expect(normalizeToolArguments('not json', schema)).toBe('not json');
  });
});
