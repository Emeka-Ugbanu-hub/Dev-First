import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolDef } from '../llm/types';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpServerConnection {
  private child: ChildProcess | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private tools: McpToolInfo[] = [];
  status: 'disconnected' | 'connecting' | 'ready' | 'error' = 'disconnected';
  error?: string;

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    if (this.status === 'ready') {
      return;
    }
    this.status = 'connecting';
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    child.stderr?.on('data', () => {
      // MCP servers log to stderr; ignore unless debugging
    });
    child.on('exit', () => {
      this.status = 'error';
      this.error = 'server process exited';
      for (const entry of this.pending.values()) {
        entry.reject(new Error('MCP server exited'));
      }
      this.pending.clear();
    });
    child.on('error', (error) => {
      this.status = 'error';
      this.error = error.message;
    });

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dev-first', version: '0.1.0' },
      },
      15_000,
    );
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {}, 15_000);
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
    this.status = 'ready';
  }

  listTools(): McpToolInfo[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }, 120_000);
    const content = Array.isArray(result?.content) ? result.content : [];
    const parts = content.map((entry: any) =>
      entry?.type === 'text' ? String(entry.text ?? '') : `[${entry?.type ?? 'content'}]`,
    );
    return parts.join('\n') || '(no output)';
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.handleMessage(line);
      }
    }
  }

  private handleMessage(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message?.id === 'number' && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message ?? 'MCP error'));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  dispose(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

export class McpManager {
  private readonly servers = new Map<string, McpServerConnection>();
  private readonly toolIndex = new Map<string, { server: string; tool: string }>();
  private loaded = false;

  async ensureLoaded(workspaceRoot: string | undefined): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const configPaths = [
      workspaceRoot ? path.join(workspaceRoot, '.dev-first', 'mcp.json') : undefined,
      path.join(os.homedir(), '.dev-first', 'mcp.json'),
    ].filter((value): value is string => Boolean(value));

    const merged = new Map<string, McpServerConfig>();
    for (const configPath of configPaths) {
      try {
        const raw = await fs.readFile(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
        for (const [name, config] of Object.entries(parsed?.mcpServers ?? {})) {
          if (!merged.has(name)) {
            merged.set(name, config);
          }
        }
      } catch {
        continue;
      }
    }

    for (const [name, config] of merged) {
      if (!config?.command || config.disabled) {
        continue;
      }
      const connection = new McpServerConnection(name, config);
      this.servers.set(name, connection);
      try {
        await connection.connect();
      } catch (error) {
        connection.status = 'error';
        connection.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  tools(): ToolDef[] {
    const tools: ToolDef[] = [];
    this.toolIndex.clear();
    for (const [serverName, connection] of this.servers) {
      if (connection.status !== 'ready') {
        continue;
      }
      for (const tool of connection.listTools()) {
        const toolName = `${serverName}_${tool.name}`;
        this.toolIndex.set(toolName, { server: serverName, tool: tool.name });
        tools.push({
          name: toolName,
          description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        });
      }
    }
    return tools;
  }

  hasTool(toolName: string): boolean {
    return this.toolIndex.has(toolName);
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolIndex.get(toolName);
    if (!entry) {
      return `Error: unknown MCP tool "${toolName}".`;
    }
    const connection = this.servers.get(entry.server);
    if (!connection) {
      return `Error: MCP server "${entry.server}" is not connected.`;
    }
    return connection.callTool(entry.tool, args);
  }

  status(): string {
    if (this.servers.size === 0) {
      return 'no MCP servers configured';
    }
    return [...this.servers.entries()]
      .map(([name, connection]) => `${name}: ${connection.status}${connection.error ? ` (${connection.error})` : ''}`)
      .join(', ');
  }

  dispose(): void {
    for (const connection of this.servers.values()) {
      connection.dispose();
    }
    this.servers.clear();
    this.toolIndex.clear();
    this.loaded = false;
  }
}
