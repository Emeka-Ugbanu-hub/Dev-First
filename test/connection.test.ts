import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
  secrets: {} as Record<string, string>,
  state: {} as Record<string, unknown>,
  updates: [] as Array<{ key: string; value: unknown }>,
  deleted: [] as string[],
}));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => env.config[key] ?? fallback,
        update: async (key: string, value: unknown) => {
          env.config[key] = value;
          env.updates.push({ key, value });
        },
      }),
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-connection-test' } }],
      asRelativePath: (value: string) => value,
    },
    window: {
      onDidChangeTextEditorSelection: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
    },
    commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
    ConfigurationTarget: { Global: 1 },
  };
});

import type { HostMessage } from '../src/shared/protocol';
import { SessionController } from '../src/session/SessionController';

function createController(posted: HostMessage[]): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: '/tmp/dev-first-connection-test' },
    globalStorageUri: { fsPath: '/tmp/dev-first-connection-test-global' },
    secrets: {
      get: async (key: string) => env.secrets[key] ?? env.secret,
      store: async (key: string, value: string) => {
        env.secrets[key] = value;
      },
      delete: async (key: string) => {
        delete env.secrets[key];
        env.deleted.push(key);
      },
    },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: {
      get: (key: string) => env.state[key],
      update: async (key: string, value: unknown) => {
        env.state[key] = value;
      },
    },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
  } as never;
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

function connectionNotices(posted: HostMessage[]): Array<{ id: string }> {
  return posted
    .filter((message): message is Extract<HostMessage, { type: 'addMessage' }> => message.type === 'addMessage')
    .map((message) => message.message)
    .filter((message) => message.role === 'notice' && message.action === 'openSettings');
}

function latestState(posted: HostMessage[]) {
  return posted.filter((message) => message.type === 'state').at(-1)?.state;
}

function latestConnection(posted: HostMessage[]) {
  return posted.filter((message) => message.type === 'connection').at(-1)?.connection;
}

describe('SessionController connection UX', () => {
  beforeEach(() => {
    env.config = {};
    env.secret = undefined;
    env.secrets = {};
    env.state = {};
    env.updates = [];
    env.deleted = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the openSettings host message when the webview asks for it', async () => {
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'openSettings' });
    expect(posted).toContainEqual({ type: 'openSettings' });
    controller.dispose();
  });

  it('adds an actionable, preset-driven notice when no key is present', async () => {
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'sendMessage', text: 'hello' });
    const notice = posted
      .filter(
        (message): message is Extract<HostMessage, { type: 'addMessage' }> =>
          message.type === 'addMessage',
      )
      .map((message) => message.message)
      .find((message) => message.role === 'notice');
    expect(notice?.text).toBe('Connect OpenAI — add your API key in Settings → Provider.');
    expect(notice?.action).toBe('openSettings');
    controller.dispose();
  });

  it('removes the connection notice after a successful connect', async () => {
    env.config = { preset: 'openai' };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }] }) }));
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'sendMessage', text: 'hello' });
    const notice = connectionNotices(posted)[0];
    expect(notice).toBeDefined();
    await controller.handleMessage({ type: 'connect', preset: 'openai', apiKey: 'sk-test' });
    expect(posted).toContainEqual({ type: 'removeMessage', id: notice.id });
    controller.dispose();
  });

  it('removes a stale notice on keyless connect', async () => {
    env.config = { preset: 'openai' };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [{ id: 'llama3.2' }] }) }));
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'sendMessage', text: 'hello' });
    const notice = connectionNotices(posted)[0];
    expect(notice).toBeDefined();
    await controller.handleMessage({ type: 'connect', preset: 'ollama' });
    expect(posted).toContainEqual({ type: 'removeMessage', id: notice.id });
    controller.dispose();
  });

  it('keeps auth failures as hard errors without removing the notice', async () => {
    env.config = { preset: 'openai' };
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid API key',
    }));
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'sendMessage', text: 'hello' });
    const notice = connectionNotices(posted)[0];
    expect(notice).toBeDefined();
    await controller.handleMessage({ type: 'connect', preset: 'openai', apiKey: 'sk-bad' });
    expect(posted).toContainEqual(expect.objectContaining({ type: 'connectResult', ok: false }));
    expect(posted.some((message) => message.type === 'removeMessage' && message.id === notice.id)).toBe(false);
    controller.dispose();
  });

  it('stores each successful connection and reports them in state', async () => {
    env.config = { preset: 'openai' };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }] }) }));
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'connect', preset: 'openai', apiKey: 'sk-openai' });
    await controller.handleMessage({ type: 'connect', preset: 'anthropic', apiKey: 'sk-anthropic' });
    expect(env.state['devFirst.connections']).toEqual([
      { preset: 'openai', baseUrl: '', lastModel: 'gpt-4o' },
      { preset: 'anthropic', baseUrl: '', lastModel: 'claude-sonnet-4-5' },
    ]);
    expect(latestState(posted)?.connections).toEqual([
      { preset: 'openai', label: 'OpenAI', model: 'gpt-4o', active: false },
      { preset: 'anthropic', label: 'Anthropic', model: 'claude-sonnet-4-5', active: true },
    ]);
    controller.dispose();
  });

  it('disconnectProvider deletes the key and auto-switches to the next connection', async () => {
    env.config = { preset: 'openai' };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }] }) }));
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'connect', preset: 'openai', apiKey: 'sk-openai' });
    await controller.handleMessage({ type: 'connect', preset: 'anthropic', apiKey: 'sk-anthropic' });
    env.updates = [];
    await controller.handleMessage({ type: 'disconnectProvider', preset: 'anthropic' });
    expect(env.deleted).toContain('devFirst.apiKey.anthropic');
    expect(env.state['devFirst.connections']).toEqual([
      { preset: 'openai', baseUrl: '', lastModel: 'gpt-4o' },
    ]);
    expect(env.updates).toContainEqual({ key: 'preset', value: 'openai' });
    expect(env.updates).toContainEqual({ key: 'model', value: 'gpt-4o' });
    expect(posted).toContainEqual(expect.objectContaining({ type: 'models', preset: 'openai' }));
    expect(latestConnection(posted)).toEqual(
      expect.objectContaining({ preset: 'openai', model: 'gpt-4o', connected: true }),
    );
    expect(latestState(posted)?.connections).toEqual([
      { preset: 'openai', label: 'OpenAI', model: 'gpt-4o', active: true },
    ]);
    controller.dispose();
  });

  it('disconnectProvider on the last connection clears the model', async () => {
    env.config = { preset: 'openai' };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }] }) }));
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'connect', preset: 'openai', apiKey: 'sk-openai' });
    env.updates = [];
    await controller.handleMessage({ type: 'disconnectProvider', preset: 'openai' });
    expect(env.deleted).toContain('devFirst.apiKey.openai');
    expect(env.state['devFirst.connections']).toEqual([]);
    expect(env.updates).toContainEqual({ key: 'model', value: '' });
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'connection', connection: expect.objectContaining({ model: '', connected: false, needsKey: true }) }),
    );
    expect(latestState(posted)?.connections).toEqual([]);
    controller.dispose();
  });

  it('setProvider switches provider settings and requests models for it', async () => {
    env.config = { preset: 'openai' };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'connect', preset: 'openai', apiKey: 'sk-openai' });
    await controller.handleMessage({ type: 'connect', preset: 'anthropic', apiKey: 'sk-anthropic' });
    env.updates = [];
    fetchMock.mockClear();
    await controller.handleMessage({ type: 'setProvider', preset: 'openai', model: 'gpt-4o' });
    expect(env.updates).toContainEqual({ key: 'preset', value: 'openai' });
    expect(env.updates).toContainEqual({ key: 'model', value: 'gpt-4o' });
    expect(fetchMock).toHaveBeenCalled();
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'models', preset: 'openai', models: expect.arrayContaining(['gpt-4o']) }),
    );
  });

  it('setProvider updates the connection last model and keeps the key', async () => {
    env.config = { preset: 'openai' };
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-4o' }] }) }));
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'connect', preset: 'openai', apiKey: 'sk-openai' });
    await controller.handleMessage({ type: 'setProvider', preset: 'openai', model: 'gpt-4o-mini' });
    expect(env.state['devFirst.connections']).toEqual([
      { preset: 'openai', baseUrl: '', lastModel: 'gpt-4o-mini' },
    ]);
    expect(env.secrets['devFirst.apiKey.openai']).toBe('sk-openai');
    controller.dispose();
  });

  it('migrates a pre-existing keyed connection into the connections store', async () => {
    env.config = { preset: 'openai', baseUrl: 'https://proxy.example/v1', model: 'gpt-4o' };
    env.secrets['devFirst.apiKey.openai'] = 'sk-legacy';
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.refreshConnectionState();
    expect(env.state['devFirst.connections']).toEqual([
      { preset: 'openai', baseUrl: 'https://proxy.example/v1', lastModel: 'gpt-4o' },
    ]);
    expect(latestState(posted)?.connections).toEqual([
      { preset: 'openai', label: 'OpenAI', model: 'gpt-4o', active: true },
    ]);
    controller.dispose();
  });

  it('migrates a keyless active preset without a stored key', async () => {
    env.config = { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' };
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.refreshConnectionState();
    expect(env.state['devFirst.connections']).toEqual([
      { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', lastModel: 'llama3.2' },
    ]);
    controller.dispose();
  });

  it('does not duplicate an existing connection during migration', async () => {
    env.config = { preset: 'openai', baseUrl: 'https://ignored.example/v1', model: 'gpt-4o' };
    env.secrets['devFirst.apiKey.openai'] = 'sk-legacy';
    env.state['devFirst.connections'] = [
      { preset: 'openai', baseUrl: 'https://kept.example/v1', lastModel: 'gpt-4o-mini' },
    ];
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.refreshConnectionState();
    expect(env.state['devFirst.connections']).toEqual([
      { preset: 'openai', baseUrl: 'https://kept.example/v1', lastModel: 'gpt-4o-mini' },
    ]);
    controller.dispose();
  });

  it('synthesizes the active connection when the store is missing it', async () => {
    env.config = { preset: 'openai', baseUrl: 'https://proxy.example/v1', model: 'gpt-4o' };
    env.secrets['devFirst.apiKey.openai'] = 'sk-legacy';
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.refreshConnectionState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    env.state['devFirst.connections'] = [];
    const state = controller.getState();
    expect(state.connections).toEqual([
      { preset: 'openai', label: 'OpenAI', model: 'gpt-4o', active: true },
    ]);
    expect(state.connection).toEqual(expect.objectContaining({ preset: 'openai', connected: true }));
    controller.dispose();
  });

  it('does not synthesize a key-requiring connection without a key', async () => {
    env.config = { preset: 'openai', model: 'gpt-4o' };
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.refreshConnectionState();
    expect(controller.getState().connections).toEqual([]);
    controller.dispose();
  });
});
