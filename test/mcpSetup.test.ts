import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  addServer,
  mcpConfigPath,
  mergeRecommended,
  readMcpConfig,
  writeMcpConfig,
} from '../src/mcp/mcpSetup';

let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'df-mcp-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('mergeRecommended', () => {
  it('adds selected servers with the workspace path', () => {
    const { config, added } = mergeRecommended({ mcpServers: {} }, '/work', ['filesystem', 'memory']);
    expect(added).toEqual(['filesystem', 'memory']);
    expect(config.mcpServers.filesystem.args).toContain('/work');
    expect(config.mcpServers.memory.command).toBe('npx');
  });

  it('does not overwrite existing servers', () => {
    const existing = { mcpServers: { filesystem: { command: 'custom' } } };
    const { config, added } = mergeRecommended(existing, '/work', ['filesystem']);
    expect(added).toEqual([]);
    expect(config.mcpServers.filesystem.command).toBe('custom');
  });

  it('ignores names that are not recommended', () => {
    const { added } = mergeRecommended({ mcpServers: {} }, '/work', ['nope']);
    expect(added).toEqual([]);
  });
});

describe('read/write round trip', () => {
  it('returns an empty config when the file is missing', async () => {
    const dir = await makeTempDir();
    const config = await readMcpConfig(mcpConfigPath(dir));
    expect(config).toEqual({ mcpServers: {} });
  });

  it('persists and reads back servers', async () => {
    const dir = await makeTempDir();
    const filePath = mcpConfigPath(dir);
    const config = await readMcpConfig(filePath);
    addServer(config, 'custom', { command: 'node', args: ['server.js'] });
    await writeMcpConfig(filePath, config);
    const reloaded = await readMcpConfig(filePath);
    expect(reloaded.mcpServers.custom).toEqual({ command: 'node', args: ['server.js'] });
  });
});
