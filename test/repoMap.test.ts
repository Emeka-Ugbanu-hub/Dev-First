import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildScopedRepoMap, clearRepoMapCache } from '../src/agent/repoMap';
import { makeReadCache } from '../src/agent/compoundPrimitives';

describe('scoped repository map', () => {
  it('is deterministic, bounded, and marks unresolved imports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-map-'));
    await fs.writeFile(path.join(root, 'main.ts'), "import { helper } from './helper';\nimport './missing';\nexport function main() { return helper(); }\n");
    await fs.writeFile(path.join(root, 'helper.ts'), 'export function helper() { return 1; }\n');
    clearRepoMapCache();
    const first = await buildScopedRepoMap(root, { anchor: 'main.ts', tokenBudget: 256, cache: makeReadCache() });
    const second = await buildScopedRepoMap(root, { anchor: 'main.ts', tokenBudget: 256, cache: makeReadCache() });
    expect(first).toBe(second);
    expect(first).toContain('unresolved: 1');
    expect(first).toContain('main.ts');
    expect(first.length).toBeLessThan(1500);
  });

  it('uses a smaller compact-tier budget and never writes files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-map-'));
    const original = 'export const value = 1;\n';
    await fs.writeFile(path.join(root, 'main.ts'), original);
    clearRepoMapCache();
    await buildScopedRepoMap(root, { anchor: 'main.ts', tier: 'compact', cache: makeReadCache() });
    expect(await fs.readFile(path.join(root, 'main.ts'), 'utf8')).toBe(original);
  });

  it('supports package scope without leaving the anchor directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-map-'));
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'main.ts'), 'export const main = 1;\n');
    await fs.writeFile(path.join(root, 'sub', 'peer.ts'), 'export const peer = 2;\n');
    await fs.writeFile(path.join(root, 'other.ts'), 'export const other = 3;\n');
    clearRepoMapCache();
    const result = await buildScopedRepoMap(root, { anchor: 'sub/main.ts', scope: 'package', cache: makeReadCache() });
    expect(result).toContain('sub/peer.ts');
    expect(result).not.toContain('other.ts');
  });
});
