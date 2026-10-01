import { describe, expect, it } from 'vitest';
import { CONNECTIONS_KEY, ConnectionsStore, connectionQualifies } from '../src/session/connections';
import { findPreset } from '../src/llm/presets';

function memento(initial?: unknown) {
  let value = initial;
  return {
    state: {
      get: <T>() => value as T | undefined,
      update: async (_key: string, next: unknown) => {
        value = next;
      },
    },
    stored: () => value,
  };
}

describe('connectionQualifies', () => {
  it('requires a key only for presets that need one', () => {
    expect(connectionQualifies(findPreset('openai')!, true)).toBe(true);
    expect(connectionQualifies(findPreset('openai')!, false)).toBe(false);
    expect(connectionQualifies(findPreset('ollama')!, false)).toBe(true);
  });
});

describe('ConnectionsStore', () => {
  it('starts empty when nothing is stored', () => {
    const store = new ConnectionsStore(memento().state as never);
    expect(store.list()).toEqual([]);
    expect(store.get('openai')).toBeUndefined();
  });

  it('adds a connection and updates it in place', async () => {
    const memory = memento();
    const store = new ConnectionsStore(memory.state as never);
    await store.addOrUpdate('openai', '', 'gpt-4o');
    expect(store.list()).toEqual([{ preset: 'openai', baseUrl: '', lastModel: 'gpt-4o' }]);

    await store.addOrUpdate('openai', 'https://proxy.example/v1', 'gpt-4o-mini');
    expect(store.list()).toEqual([
      { preset: 'openai', baseUrl: 'https://proxy.example/v1', lastModel: 'gpt-4o-mini' },
    ]);
    expect(store.get('openai')?.lastModel).toBe('gpt-4o-mini');
  });

  it('keeps multiple connections and trims values', async () => {
    const memory = memento();
    const store = new ConnectionsStore(memory.state as never);
    await store.addOrUpdate('openai', '', 'gpt-4o');
    await store.addOrUpdate('anthropic', '  ', '  claude-sonnet-4-5  ');
    expect(store.list()).toEqual([
      { preset: 'openai', baseUrl: '', lastModel: 'gpt-4o' },
      { preset: 'anthropic', baseUrl: '', lastModel: 'claude-sonnet-4-5' },
    ]);
  });

  it('removes only the requested connection', async () => {
    const memory = memento();
    const store = new ConnectionsStore(memory.state as never);
    await store.addOrUpdate('openai', '', 'gpt-4o');
    await store.addOrUpdate('anthropic', '', 'claude-sonnet-4-5');
    await store.remove('openai');
    expect(store.list()).toEqual([
      { preset: 'anthropic', baseUrl: '', lastModel: 'claude-sonnet-4-5' },
    ]);
    await store.remove('missing');
    expect(store.list()).toHaveLength(1);
  });

  it('ignores malformed stored entries', () => {
    const memory = memento([
      { preset: 'openai', baseUrl: '', lastModel: 'gpt-4o' },
      { preset: '', baseUrl: '', lastModel: 'x' },
      null,
      'nope',
    ]);
    const store = new ConnectionsStore(memory.state as never);
    expect(store.list()).toEqual([{ preset: 'openai', baseUrl: '', lastModel: 'gpt-4o' }]);
  });

  it('uses the devFirst.connections storage key', async () => {
    const memory = memento();
    const store = new ConnectionsStore(memory.state as never);
    await store.addOrUpdate('ollama', '', 'llama3.2');
    expect(memory.stored()).toBeDefined();
    expect(CONNECTIONS_KEY).toBe('devFirst.connections');
    expect((memory.stored() as Array<{ preset: string }>)[0].preset).toBe('ollama');
  });
});
