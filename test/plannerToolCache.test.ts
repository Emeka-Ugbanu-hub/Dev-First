import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  secret: undefined as string | undefined,
  root: '',
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
      onDidChangeConfiguration: () => disposable,
      workspaceFolders: [{ uri: { get fsPath() { return env.root; } } }],
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
import type { PlannerCallbacks } from '../src/planner/PlannerService';
import { PlannerService } from '../src/planner/PlannerService';
import { SessionController } from '../src/session/SessionController';

function createController(posted: HostMessage[]): SessionController {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: env.root },
    globalStorageUri: { fsPath: `/tmp/dev-first-planner-cache-${Math.random().toString(36).slice(2)}` },
    secrets: { get: async () => env.secret, store: async () => undefined },
    workspaceState: { get: () => undefined, update: async () => undefined },
    globalState: { get: () => undefined, update: async () => undefined },
  } as never;
  const diffManager = {
    onDidChangePendingChanges: () => ({ dispose() {} }),
    getChangeSummaries: () => [],
    getCurrentRunId: () => undefined,
    hasPendingChanges: () => false,
    setRunContext: () => undefined,
    setFileSummaries: () => undefined,
  } as never;
  return new SessionController(context, (message) => posted.push(message), diffManager);
}

function routeSse(): string {
  const chunk = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'route',
              function: {
                name: 'classify_route',
                arguments: JSON.stringify({ route: 'new-task', mode: 'lite' }),
              },
            },
          ],
        },
      },
    ],
  });
  return `data: ${chunk}\n\ndata: [DONE]\n\n`;
}

beforeEach(async () => {
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-planner-cache-'));
  await fs.mkdir(path.join(env.root, 'src'), { recursive: true });
  await fs.writeFile(path.join(env.root, 'src', 'auth.ts'), 'const token = "secret";\n', 'utf-8');
  env.config = { preset: 'openai', model: 'gpt-4o' };
  env.secret = 'sk-test';
  vi.stubGlobal('fetch', async (url: string | URL) => {
    if (String(url).includes('chat/completions')) {
      return new Response(routeSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(env.root, { recursive: true, force: true });
});

describe('planner read-only ToolBox reuse', () => {
  it('shares the dedup cache within a planning route and resets between user turns', async () => {
    const results: string[] = [];
    const planSpy = vi.spyOn(PlannerService.prototype, 'plan').mockImplementation(
      async (_conversation, _plan, _version, callbacks: PlannerCallbacks) => {
        results.push(await callbacks.executeTool({
          id: `read-${results.length}-a`,
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/auth.ts' }),
        }));
        results.push(await callbacks.executeTool({
          id: `read-${results.length}-b`,
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/auth.ts' }),
        }));
        return { text: 'Auth is JWT based.', exhausted: false };
      },
    );
    const controller = createController([]);

    await controller.handleMessage({ type: 'sendMessage', text: 'how does auth work?' });
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('const token');
    expect(results[1].startsWith('[DEDUP]')).toBe(true);
    expect(results[1]).not.toContain('const token');

    await controller.handleMessage({ type: 'sendMessage', text: 'how does auth work again?' });
    expect(results).toHaveLength(4);
    // A new user turn gets a fresh planning ToolBox.
    expect(results[2]).toContain('const token');
    expect(results[2].startsWith('[DEDUP]')).toBe(false);
    expect(results[3].startsWith('[DEDUP]')).toBe(true);

    expect(planSpy).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('invalidates active planner and executor caches together', () => {
    const controller = createController([]);
    const planner = { resetReadCache: vi.fn() };
    const executor = { resetReadCache: vi.fn() };
    const internals = controller as unknown as {
      activePlannerToolbox: unknown;
      activeExecutorToolbox: unknown;
      invalidateActiveCaches: () => void;
    };
    internals.activePlannerToolbox = planner;
    internals.activeExecutorToolbox = executor;

    internals.invalidateActiveCaches();

    expect(planner.resetReadCache).toHaveBeenCalledTimes(1);
    expect(executor.resetReadCache).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});
