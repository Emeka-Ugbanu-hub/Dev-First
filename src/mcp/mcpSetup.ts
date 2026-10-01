import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

export interface RecommendedServer {
  name: string;
  description: string;
  entry: (workspace: string) => McpServerEntry;
}

export const RECOMMENDED_SERVERS: RecommendedServer[] = [
  {
    name: 'filesystem',
    description: 'Read and write files in the workspace (official server)',
    entry: (workspace) => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', workspace],
    }),
  },
  {
    name: 'memory',
    description: 'Persistent knowledge-graph memory across sessions',
    entry: () => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    }),
  },
  {
    name: 'sequential-thinking',
    description: 'Structured step-by-step reasoning helper',
    entry: () => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    }),
  },
];

export function mcpConfigPath(workspace: string): string {
  return path.join(workspace, '.dev-first', 'mcp.json');
}

export function npxAvailable(): boolean {
  try {
    const result = spawnSync('npx', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
    return result.status === 0;
  } catch {
    return false;
  }
}

export async function readMcpConfig(filePath: string): Promise<McpConfig> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerEntry> };
    return { mcpServers: parsed?.mcpServers ?? {} };
  } catch {
    return { mcpServers: {} };
  }
}

export async function writeMcpConfig(filePath: string, config: McpConfig): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export function mergeRecommended(
  config: McpConfig,
  workspace: string,
  names: string[],
): { config: McpConfig; added: string[] } {
  const added: string[] = [];
  for (const server of RECOMMENDED_SERVERS) {
    if (!names.includes(server.name) || config.mcpServers[server.name]) {
      continue;
    }
    config.mcpServers[server.name] = server.entry(workspace);
    added.push(server.name);
  }
  return { config, added };
}

export function addServer(config: McpConfig, name: string, entry: McpServerEntry): McpConfig {
  config.mcpServers[name] = entry;
  return config;
}
