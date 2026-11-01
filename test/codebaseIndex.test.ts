import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodebaseIndex } from '../src/indexing/CodebaseIndex';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeIndex(): Promise<{ root: string; index: CodebaseIndex }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-codebase-index-'));
  temporaryRoots.push(root);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'auth.ts'),
    "import { UserStore } from './users';\nexport function createSession(userId: string) {\n  return UserStore.create(userId);\n}\n",
  );
  await fs.writeFile(path.join(root, 'src', 'users.ts'), 'export class UserStore {\n  static create(id: string) { return id; }\n}\n');
  const index = new CodebaseIndex({ root, storageFile: path.join(root, '.index.json') });
  return { root, index };
}

describe('CodebaseIndex', () => {
  it('builds verified symbol and import evidence without an LLM', async () => {
    const { index } = await makeIndex();
    const evidence = await index.evidence('create session', 4);

    expect(evidence).toContain('src/auth.ts');
    expect(evidence).toContain('createSession');
    expect(evidence).toContain('./users');
    expect(index.stats()).toMatchObject({ files: 2, ready: true });
  });

  it('reuses unchanged files and refreshes only changed metadata', async () => {
    const { root, index } = await makeIndex();
    await index.refresh();
    await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export function login() { return true; }\n');
    index.invalidate(path.join(root, 'src', 'auth.ts'));
    const evidence = await index.evidence('login');

    expect(evidence).toContain('src/auth.ts');
    expect(evidence).toContain('login');
    expect(evidence).not.toContain('createSession');
  });

  it('provides a model-free hybrid lookup for symbols and imports', async () => {
    const { index } = await makeIndex();
    const results = await index.hybridSearch('UserStore session', 4);
    expect(results.some((result) => result.path === 'src/auth.ts')).toBe(true);
    const auth = results.find((result) => result.path === 'src/auth.ts');
    expect(auth?.imports.some((item) => item.specifier === './users')).toBe(true);
  });
});
