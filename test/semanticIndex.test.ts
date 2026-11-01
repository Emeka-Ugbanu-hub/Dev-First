import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SemanticIndex } from '../src/indexing/SemanticIndex';

let root: string;
let storage: string;

function embed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map((text) => [text.toLowerCase().includes('auth') ? 1 : 0, 1]));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-semantic-'));
  storage = path.join(root, '.semantic.json');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export function createSession() { return true; }\n', 'utf-8');
  await fs.writeFile(path.join(root, 'src', 'auth.test.ts'), 'describe("auth", () => {});\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('SemanticIndex', () => {
  it('indexes first-party code, skips tests, and becomes ready', async () => {
    const index = new SemanticIndex({ root, storageFile: storage, embed, maxFiles: 10 });
    expect(await index.ready()).toBe(false);
    const results = await index.search('auth', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.path === 'src/auth.ts')).toBe(true);
    expect(results.some((result) => result.path === 'src/auth.test.ts')).toBe(false);
    expect(index.stats()).toMatchObject({ ready: true, files: 1 });
  });

  it('updates only an invalidated file', async () => {
    const index = new SemanticIndex({ root, storageFile: storage, embed, maxFiles: 10 });
    await index.search('auth', 5);
    await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export function login() { return true; }\n', 'utf-8');
    index.invalidate(path.join(root, 'src', 'auth.ts'));
    const results = await index.search('login', 5);
    expect(results.some((result) => result.path === 'src/auth.ts')).toBe(true);
    expect(index.stats().ready).toBe(true);
  });

  it('reports when the file limit truncates coverage', async () => {
    await fs.writeFile(path.join(root, 'src', 'users.ts'), 'export const users = [];\n', 'utf-8');
    const index = new SemanticIndex({ root, storageFile: storage, embed, maxFiles: 1 });
    await index.search('auth', 5);
    expect(index.stats().truncated).toBe(true);
  });
});
