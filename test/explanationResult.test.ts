import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'fs/promises';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
}));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => env.config[key] ?? fallback,
        update: async () => undefined,
      }),
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
      workspaceFolders: [{ uri: { fsPath: '/tmp/dev-first-explanation-test' } }],
      asRelativePath: (value: string) => value,
    },
    window: {
      onDidChangeTextEditorSelection: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      visibleTextEditors: [],
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
    extensionUri: { fsPath: '/tmp/dev-first-explanation-test' },
    globalStorageUri: { fsPath: '/tmp/dev-first-explanation-test-global' },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => false,
  } as never;
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

function toolSse(name: string, payload: Record<string, unknown>): string {
  const chunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              function: { name, arguments: JSON.stringify(payload) },
            },
          ],
        },
      },
    ],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

function textSse(text: string): string {
  const chunks = text.match(/[\s\S]{1,48}/g) ?? [];
  return chunks.map((content) => {
    const chunk = JSON.stringify({ choices: [{ delta: { content } }] });
    return `data: ${chunk}\n\n`;
  }).join('') + 'data: [DONE]\n\n';
}

function stubFetch(responses: string[]): void {
  let index = 0;
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).includes('chat/completions')) {
      const response = responses[index++] ?? responses[responses.length - 1];
      return new Response(response, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200 });
  });
}

beforeEach(async () => {
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  vi.stubEnv('HOME', '/tmp/dev-first-explanation-test-home');
  await rm('/tmp/dev-first-explanation-test-global', { recursive: true, force: true });
  await rm('/tmp/dev-first-explanation-test', { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('SessionController explanation results', () => {
  it('posts an explanation as one chat message and keeps plan state untouched', async () => {
    stubFetch([
      textSse('## WHAT\nAuth is JWT based.\n\n## HOW\nThe API signs a token; middleware verifies it.\n\n## WHY\nStateless tokens avoid a session store.\n\n```mermaid\ngraph TD\n  A[Login] --> B[JWT]\n```\n\n- `src/auth.ts` — verifies credentials'),
    ]);
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'sendMessage', text: 'how does auth work?' });

    expect(controller.getState().plan).toBeNull();
    expect((controller as unknown as { planVersion: number }).planVersion).toBe(0);
    expect(posted.some((message) => message.type === 'plan')).toBe(false);

    const assistant = controller.getState().messages
      .find((message) => message.role === 'assistant' && message.text.includes('## WHAT'));
    expect(assistant?.text).toContain('## HOW');
    expect(assistant?.text).toContain('## WHY');
    expect(assistant?.text).toContain('```mermaid');
    expect(assistant?.text).toContain('- `src/auth.ts` — verifies credentials');
    controller.dispose();
  });

  it('still turns change requests into plans with a version bump', async () => {
    stubFetch([
      toolSse('submit_plan', {
        intent: 'plan',
        what: 'Add a health endpoint.',
        how: 'Register a route that returns status.',
        steps: ['Add the handler', 'Register the route'],
      }),
    ]);
    const posted: HostMessage[] = [];
    const controller = createController(posted);
    await controller.handleMessage({ type: 'sendMessage', text: 'add a health endpoint' });

    expect(controller.getState().plan?.status).toBe('draft');
    expect((controller as unknown as { planVersion: number }).planVersion).toBe(1);
    expect(posted.some((message) => message.type === 'plan' && message.plan?.intent === 'plan')).toBe(true);
    controller.dispose();
  });
});
