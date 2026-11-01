import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearProjectBootstrap, projectBootstrap } from '../src/indexing/projectBootstrap';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    clearProjectBootstrap(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});
describe('projectBootstrap', () => {
  it('builds and caches a compact deterministic project identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-bootstrap-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      main: 'src/index.ts',
      scripts: { build: 'tsc', test: 'vitest' },
      dependencies: { react: '^18.0.0' },
    }));
    const first = await projectBootstrap(root);
    const second = await projectBootstrap(root);
    expect(first).toContain('Node project (React)');
    expect(first).toContain('entry src/index.ts');
    expect(first).toBe(second);
  });

  it('includes bounded Git orientation when the workspace is a repository', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-bootstrap-git-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
    const run = async (args: string[]) => {
      const { execFile } = await import('child_process');
      return new Promise<void>((resolve, reject) => {
        execFile('git', args, { cwd: root }, (error) => error ? reject(error) : resolve());
      });
    };
    await run(['init', '-q']);
    await run(['config', 'user.email', 'test@example.com']);
    await run(['config', 'user.name', 'Dev First Test']);
    await fs.writeFile(path.join(root, 'index.ts'), 'export const answer = 42;\n');
    await run(['add', '.']);
    await run(['commit', '-qm', 'initial project']);
    await fs.writeFile(path.join(root, 'index.ts'), 'export const answer = 43;\n');

    const value = await projectBootstrap(root);
    expect(value).toContain('[Git context — read-only snapshot]');
    expect(value).toContain('Branch:');
    expect(value).toContain('index.ts');
    expect(value).toContain('initial project');
  });
});
