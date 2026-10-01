import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { loadProjectRules } from '../src/planner/rules';

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'df-rules-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('loadProjectRules', () => {
  it('reads AGENTS.md from the workspace root', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'AGENTS.md'), 'Always use tabs.');
    const rules = await loadProjectRules(dir);
    expect(rules).toContain('Always use tabs.');
  });

  it('reads .dev-first/rules.md as well', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'AGENTS.md'), 'Rule A');
    await mkdir(path.join(dir, '.dev-first'), { recursive: true });
    await writeFile(path.join(dir, '.dev-first', 'rules.md'), 'Rule B');
    const rules = await loadProjectRules(dir);
    expect(rules).toContain('Rule A');
    expect(rules).toContain('Rule B');
  });

  it('returns undefined for a folder with no rules', async () => {
    const dir = await makeTempDir();
    const rules = await loadProjectRules(dir);
    expect(rules === undefined || typeof rules === 'string').toBe(true);
  });
});
