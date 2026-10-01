import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secrets: {} as Record<string, string>,
  globalState: {} as Record<string, unknown>,
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => env.config[key] ?? fallback,
    }),
  },
}));

import { activeProvider } from '../src/llm/activeProvider';

function context() {
  return {
    secrets: {
      get: async (key: string) => env.secrets[key],
    },
    globalState: {
      get: (key: string) => env.globalState[key],
      update: async (key: string, value: unknown) => {
        env.globalState[key] = value;
      },
    },
  } as never;
}

function connect(preset: string, baseUrl: string, model: string): void {
  const entries = (env.globalState['devFirst.connections'] as unknown[]) ?? [];
  env.globalState['devFirst.connections'] = [...entries, { preset, baseUrl, lastModel: model }];
}

describe('activeProvider', () => {
  beforeEach(() => {
    env.config = {};
    env.secrets = {};
    env.globalState = {};
  });

  it('resolves the configured preset with its stored key', async () => {
    env.config = { preset: 'openai', model: 'gpt-4o', baseUrl: '' };
    env.secrets['devFirst.apiKey.openai'] = 'sk-test';
    const active = await activeProvider(context());
    expect(active?.preset.id).toBe('openai');
    expect(active?.label).toBe('OpenAI');
    expect(active?.provider.id).toBe('openai');
    expect(active?.model).toBe('gpt-4o');
    expect(active?.apiKey).toBe('sk-test');
  });

  it('resolves keyless presets without a secret', async () => {
    env.config = { preset: 'ollama', model: 'llama3.2', baseUrl: '' };
    const active = await activeProvider(context());
    expect(active?.preset.id).toBe('ollama');
    expect(active?.provider.id).toBe('openai');
    expect(active?.apiKey).toBeUndefined();
  });

  it('falls back to the first stored connection when the configured preset has no key', async () => {
    env.config = { preset: 'openai', model: 'gpt-4o', baseUrl: '' };
    connect('ollama', 'http://localhost:11434/v1', 'llama3.2');
    const active = await activeProvider(context());
    expect(active?.preset.id).toBe('ollama');
    expect(active?.label).toBe('Ollama');
    expect(active?.model).toBe('llama3.2');
    expect(active?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('falls back when the configured preset is unknown', async () => {
    env.config = { preset: 'gone', model: '', baseUrl: '' };
    env.secrets['devFirst.apiKey.openai'] = 'sk-test';
    connect('openai', '', 'gpt-4o');
    const active = await activeProvider(context());
    expect(active?.preset.id).toBe('openai');
    expect(active?.provider.id).toBe('openai');
  });

  it('skips stored connections whose keys are missing and picks the next one', async () => {
    env.config = { preset: 'openai', model: 'gpt-4o', baseUrl: '' };
    connect('anthropic', '', 'claude-sonnet-4-5');
    connect('groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b');
    env.secrets['devFirst.apiKey.groq'] = 'gsk-test';
    const active = await activeProvider(context());
    expect(active?.preset.id).toBe('groq');
    expect(active?.provider.id).toBe('openai');
    expect(active?.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('returns undefined when nothing is connected', async () => {
    env.config = { preset: 'openai', model: 'gpt-4o', baseUrl: '' };
    const active = await activeProvider(context());
    expect(active).toBeUndefined();
  });

  it('uses the preset default model when a stored connection has none', async () => {
    env.config = { preset: 'missing', model: '', baseUrl: '' };
    connect('anthropic', '', '');
    env.secrets['devFirst.apiKey.anthropic'] = 'sk-ant';
    const active = await activeProvider(context());
    expect(active?.model).toBe('claude-sonnet-4-5');
    expect(active?.provider.id).toBe('anthropic');
  });
});
