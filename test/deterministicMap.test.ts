import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FileFacts } from '../src/scan/duplication';
import { buildDeterministicMap } from '../src/architecture/deterministicMap';

let root: string;

function fact(file: string, overrides: Partial<FileFacts> = {}): FileFacts {
  return {
    file,
    imports: [],
    rustModules: [],
    tauriCommandRegistrations: [],
    exports: [],
    handlers: [],
    constants: [],
    moduleCaches: [],
    listeners: [],
    storageKeys: [],
    functions: [],
    types: [],
    httpClients: [],
    httpCalls: [],
    scopedHttpClients: [],
    mutableState: [],
    stateWrites: [],
    sql: [],
    secrets: [],
    ...overrides,
  } as FileFacts;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-arch-map-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('buildDeterministicMap', () => {
  it('groups the essential layers and links webview messages to host handlers', async () => {
    await fs.mkdir(path.join(root, 'webview/src/components'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/webview'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/session'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/agent'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'webview/src/components/InputBox.tsx'),
      "post({ type: 'sendMessage', text });\n",
      'utf-8',
    );
    await fs.writeFile(
      path.join(root, 'src/session/SessionController.ts'),
      "switch (message.type) { case 'sendMessage': break; default: break; }\n",
      'utf-8',
    );
    await fs.writeFile(path.join(root, 'src/webview/ChatViewProvider.ts'), 'export const view = 1;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'src/agent/AgentService.ts'), 'export const agent = 1;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'src/session/SessionStore.ts'), 'export const store = 1;\n', 'utf-8');
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ engines: { vscode: '^1.97.0' }, devDependencies: { react: '^18.3.1' } }),
      'utf-8',
    );

    const result = await buildDeterministicMap([
      fact(path.join(root, 'webview/src/components/InputBox.tsx')),
      fact(path.join(root, 'src/webview/ChatViewProvider.ts')),
      fact(path.join(root, 'src/session/SessionController.ts'), {
        imports: [{ specifier: '../agent/AgentService', line: 1 } as never],
        handlers: [{
          name: 'handleSendMessage',
          line: 3,
          hasAuth: false,
          hasValidation: false,
          method: 'POST',
          pathShape: '/messages',
        }],
      }),
      fact(path.join(root, 'src/agent/AgentService.ts')),
      fact(path.join(root, 'src/session/SessionStore.ts')),
    ], root, 'demo');

    const input = result.map.nodes.find((node) => node.path === 'webview/src/components/InputBox.tsx');
    const session = result.map.nodes.find((node) => node.path === 'src/session/SessionController.ts');
    const agent = result.map.nodes.find((node) => node.path === 'src/agent/AgentService.ts');
    expect(input?.group).toBe('Frontend/Components');
    expect(session?.group).toBe('Backend/Session');
    expect(agent?.group).toBe('Services/Agent');
    expect(result.map.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: input?.id, to: session?.id, label: 'message' }),
      expect.objectContaining({ from: session?.id, to: agent?.id, label: 'imports' }),
    ]));
    const route = result.map.nodes.find((node) => node.group === 'Backend/Routes');
    expect(route?.label).toBe('POST /messages');
    expect(result.map.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: route?.id, to: session?.id, label: 'handles handleSendMessage' }),
    ]));
    expect(result.fingerprint).toContain('TypeScript');
    expect(result.fingerprint).toContain('VS Code extension');
    expect(result.fingerprint).toContain('React');
    expect(result.isolatedFiles).toBeGreaterThan(0);
  });

  it('caps modules per layer while keeping the rest under Other', async () => {
    const facts = Array.from({ length: 10 }, (_, index) =>
      fact(path.join(root, `src/services/mod${index}/file.ts`)));
    const result = await buildDeterministicMap(facts, root, 'demo');
    const groups = result.map.nodes.map((node) => node.group).filter(Boolean);
    expect(groups).toContain('Services/Other');
  });

  it('places Next.js, Electron and shared directories in semantic layers', async () => {
    const result = await buildDeterministicMap([
      fact(path.join(root, 'app/api/subscribe/route.ts')),
      fact(path.join(root, 'app/dashboard/page.tsx')),
      fact(path.join(root, 'components/Button.tsx')),
      fact(path.join(root, 'electron/main.ts')),
      fact(path.join(root, 'electron/preload.ts')),
      fact(path.join(root, 'prisma/schema.prisma')),
      fact(path.join(root, 'lib/db.ts')),
      fact(path.join(root, 'lib/log.ts')),
      fact(path.join(root, 'src/services/billing/invoice.ts')),
      fact(path.join(root, 'src/services/db.ts')),
      fact(path.join(root, 'src/utils/store.ts')),
      fact(path.join(root, 'src/config/db.ts')),
      fact(path.join(root, 'scripts/build.ts')),
      fact(path.join(root, 'packages/ui/Button.tsx')),
      fact(path.join(root, 'src/routes/Home.tsx')),
      fact(path.join(root, 'src/routes/user.ts'), {
        handlers: [{ name: 'getUser', line: 3, hasAuth: false, hasValidation: false, method: 'GET', pathShape: '/user' }],
      }),
    ], root, 'demo');
    const group = (file: string): string | undefined =>
      result.map.nodes.find((node) => node.path === file)?.group;
    expect(group('app/api/subscribe/route.ts')).toBe('Backend/Routes');
    expect(group('app/dashboard/page.tsx')).toBe('Frontend/Dashboard');
    expect(group('components/Button.tsx')).toBe('Frontend/Components');
    expect(group('electron/main.ts')).toBe('Backend/Electron');
    expect(group('electron/preload.ts')).toBe('Backend/IPC');
    expect(group('prisma/schema.prisma')).toBe('Data/Prisma');
    expect(group('lib/db.ts')).toBe('Data/Stores');
    expect(group('lib/log.ts')).toBe('Utils/Lib');
    expect(group('src/services/billing/invoice.ts')).toBe('Services/Billing');
    expect(group('src/services/db.ts')).toBe('Services/Services');
    expect(group('src/utils/store.ts')).toBe('Utils/Utilities');
    expect(group('src/config/db.ts')).toBe('Config/Settings');
    expect(group('scripts/build.ts')).toBe('Utils/Scripts');
    expect(group('packages/ui/Button.tsx')).toBe('Frontend/UI');
    expect(group('src/routes/Home.tsx')).toBe('Frontend/Routes');
    expect(group('src/routes/user.ts')).toBe('Backend/Routes');
  });

  it('uses the deepest semantic folder instead of the outer one', async () => {
    const result = await buildDeterministicMap([
      fact(path.join(root, 'src/utils/services/billing/foo.ts')),
      fact(path.join(root, 'src/services/utils/format.ts')),
      fact(path.join(root, 'src/components/services/api.ts')),
      fact(path.join(root, 'src/services/components/Button.tsx')),
      fact(path.join(root, 'src/utils/db/client.ts')),
      fact(path.join(root, 'src/services/routes/user.ts')),
      fact(path.join(root, 'app/api/subscribe/route.ts')),
      fact(path.join(root, 'app/dashboard/page.tsx')),
      fact(path.join(root, 'src/components/store/app.ts')),
      fact(path.join(root, 'src/store/app.ts'), {
        imports: [{ specifier: 'zustand', line: 1 } as never],
      }),
      fact(path.join(root, 'src/server/store/data.ts')),
      fact(path.join(root, 'src/router.tsx')),
    ], root, 'demo');
    const group = (file: string): string | undefined =>
      result.map.nodes.find((node) => node.path === file)?.group;
    expect(group('src/utils/services/billing/foo.ts')).toBe('Services/Billing');
    expect(group('src/services/utils/format.ts')).toBe('Utils/Utilities');
    expect(group('src/components/services/api.ts')).toBe('Services/Services');
    expect(group('src/services/components/Button.tsx')).toBe('Frontend/Components');
    expect(group('src/utils/db/client.ts')).toBe('Data/Database');
    expect(group('src/services/routes/user.ts')).toBe('Backend/Routes');
    expect(group('app/api/subscribe/route.ts')).toBe('Backend/Routes');
    expect(group('app/dashboard/page.tsx')).toBe('Frontend/Dashboard');
    expect(group('src/components/store/app.ts')).toBe('Frontend/Stores');
    expect(group('src/store/app.ts')).toBe('Frontend/Stores');
    expect(group('src/server/store/data.ts')).toBe('Data/Stores');
    expect(group('src/router.tsx')).toBe('Frontend/Routes');
  });

  it('infers custom directories from file evidence', async () => {
    const result = await buildDeterministicMap([
      fact(path.join(root, 'src/livewalk/View.tsx')),
      fact(path.join(root, 'src/background/job.ts'), {
        imports: [{ specifier: 'bullmq', line: 1 } as never],
      }),
      fact(path.join(root, 'src/foo/thing.ts')),
    ], root, 'demo');
    const group = (file: string): string | undefined =>
      result.map.nodes.find((node) => node.path === file)?.group;
    expect(group('src/livewalk/View.tsx')).toBe('Frontend/Livewalk');
    expect(group('src/background/job.ts')).toBe('Services/Background');
    expect(group('src/foo/thing.ts')).toBe('Unclassified/Foo');
    expect(result.unclassifiedFiles).toBe(1);
  });

  it('keeps weak paths visible as Unclassified', async () => {
    const result = await buildDeterministicMap([
      fact(path.join(root, 'src/weird/thing.ts')),
      fact(path.join(root, 'scripts/build.ts')),
    ], root, 'demo');
    const weird = result.map.nodes.find((node) => node.path === 'src/weird/thing.ts');
    const script = result.map.nodes.find((node) => node.path === 'scripts/build.ts');
    expect(weird?.group).toBe('Unclassified/Weird');
    expect(script?.group).toBe('Utils/Scripts');
    expect(result.unclassifiedFiles).toBe(1);
    expect(result.representedFiles).toBe(2);
  });

  it('deduplicates the same route and IPC command', async () => {
    const main = path.join(root, 'electron/main.ts');
    const result = await buildDeterministicMap([
      fact(main, {
        handlers: [
          { name: 'save', line: 4, hasAuth: false, hasValidation: false, method: 'IPC', pathShape: '' },
          { name: 'save', line: 4, hasAuth: false, hasValidation: false, method: 'IPC', pathShape: '' },
          { name: 'subscribe', line: 9, hasAuth: false, hasValidation: false, method: 'POST', pathShape: '/subscribe' },
          { name: 'subscribe', line: 9, hasAuth: false, hasValidation: false, method: 'POST', pathShape: '/subscribe' },
        ],
        tauriCommandRegistrations: [{ name: 'save' }] as never,
      }),
    ], root, 'demo');
    expect(result.map.nodes.filter((node) => node.group === 'Backend/IPC')).toHaveLength(1);
    expect(result.map.nodes.filter((node) => node.group === 'Backend/Routes')).toHaveLength(1);
  });

  it('resolves tsconfig path aliases into verified import edges', async () => {
    await fs.mkdir(path.join(root, 'src/backend'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/services'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'utf-8',
    );
    await fs.writeFile(path.join(root, 'src/backend/controller.ts'), 'export const controller = 1;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'src/services/helper.ts'), 'export const helper = 1;\n', 'utf-8');

    const result = await buildDeterministicMap([
      fact(path.join(root, 'src/backend/controller.ts'), {
        imports: [{ specifier: '@/services/helper', line: 1 } as never],
      }),
      fact(path.join(root, 'src/services/helper.ts')),
    ], root, 'demo');

    const controller = result.map.nodes.find((node) => node.path === 'src/backend/controller.ts');
    const helper = result.map.nodes.find((node) => node.path === 'src/services/helper.ts');
    expect(result.map.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: controller?.id, to: helper?.id, label: 'imports' }),
    ]));
    expect(result.unresolvedRelationships).toBe(0);
  });

  it('counts files without verified edges as isolated', async () => {
    await fs.mkdir(path.join(root, 'src/util'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/util/lonely.ts'), 'export const lonely = 1;\n', 'utf-8');
    const result = await buildDeterministicMap([
      fact(path.join(root, 'src/util/lonely.ts')),
    ], root, 'demo');
    expect(result.isolatedFiles).toBe(1);
  });
});
