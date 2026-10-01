import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';

export interface BackgroundEntry {
  id: string;
  name: string;
  command: string;
  status: 'starting' | 'ready' | 'running' | 'exited' | 'error';
  exitCode: number | null;
  startedAt: number;
  output: string;
  readyPort?: number;
  readyPattern?: string;
}

const MAX_OUTPUT = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;

export class BackgroundProcesses {
  private readonly entries = new Map<string, BackgroundEntry & { child?: ChildProcess }>();

  constructor(private readonly root: string) {}

  async start(
    name: string,
    command: string,
    options: { readyPattern?: string; readyPort?: number; timeoutMs?: number } = {},
  ): Promise<string> {
    const id = `bg_${Date.now().toString(36)}`;
    const entry: BackgroundEntry & { child?: ChildProcess } = {
      id,
      name: name || command.slice(0, 30),
      command,
      status: 'starting',
      exitCode: null,
      startedAt: Date.now(),
      output: '',
      readyPort: options.readyPort,
      readyPattern: options.readyPattern,
    };
    const child = spawn(command, {
      shell: true,
      cwd: this.root,
      env: process.env,
      detached: process.platform !== 'win32',
    });
    entry.child = child;
    this.entries.set(id, entry);

    const append = (chunk: Buffer) => {
      entry.output += chunk.toString('utf8');
      if (entry.output.length > MAX_OUTPUT) {
        entry.output = entry.output.slice(entry.output.length - MAX_OUTPUT);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('exit', (code) => {
      entry.exitCode = code;
      entry.status = 'exited';
    });
    child.on('error', (error) => {
      entry.status = 'error';
      entry.output += `\n${error.message}`;
    });

    const ready = await this.waitForReady(entry, options);
    return `Started "${entry.name}" (${id}). ${ready ? 'Ready.' : 'No readiness signal — running in background.'}\nCommand: ${command}`;
  }

  adopt(name: string, command: string, child: ChildProcess, output = ''): string {
    const id = `bg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const entry: BackgroundEntry & { child?: ChildProcess } = {
      id,
      name: name || command.slice(0, 30),
      command,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      output,
    };
    entry.child = child;
    this.entries.set(id, entry);

    const append = (chunk: Buffer) => {
      entry.output += chunk.toString('utf8');
      if (entry.output.length > MAX_OUTPUT) {
        entry.output = entry.output.slice(entry.output.length - MAX_OUTPUT);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('exit', (code) => {
      entry.exitCode = code;
      entry.status = 'exited';
    });
    child.on('error', (error) => {
      entry.status = 'error';
      entry.output += `\n${error.message}`;
    });

    return id;
  }

  list(): string {
    if (this.entries.size === 0) {
      return 'No background processes.';
    }
    return [...this.entries.values()]
      .map(
        (entry) =>
          `${entry.id} — ${entry.name} [${entry.status}${entry.exitCode !== null ? ` exit ${entry.exitCode}` : ''}] · ${Math.round((Date.now() - entry.startedAt) / 1000)}s · ${entry.command.slice(0, 80)}`,
      )
      .join('\n');
  }

  tracked(): string {
    return formatTrackedProcesses([...this.entries.values()]);
  }

  status(id: string): string {
    const entry = this.find(id);
    if (!entry) {
      return `Error: no background process with id "${id}".`;
    }
    return `${entry.id} — ${entry.name} [${entry.status}${entry.exitCode !== null ? ` exit ${entry.exitCode}` : ''}] · ${entry.command}`;
  }

  logs(id: string, tailLines = 120): string {
    const entry = this.find(id);
    if (!entry) {
      return `Error: no background process with id "${id}".`;
    }
    const lines = entry.output.split('\n');
    return lines.slice(-tailLines).join('\n') || '(no output yet)';
  }

  stop(id: string): string {
    const entry = this.find(id);
    if (!entry) {
      return `Error: no background process with id "${id}".`;
    }
    if (entry.child && entry.status !== 'exited') {
      try {
        if (process.platform !== 'win32' && entry.child.pid) {
          process.kill(-entry.child.pid, 'SIGTERM');
        } else {
          entry.child.kill('SIGTERM');
        }
      } catch {
        entry.child.kill('SIGTERM');
      }
      entry.status = 'exited';
    }
    return `Stopped "${entry.name}" (${entry.id}).`;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.child?.kill('SIGTERM');
    }
    this.entries.clear();
  }

  private find(id: string): (BackgroundEntry & { child?: ChildProcess }) | undefined {
    if (this.entries.has(id)) {
      return this.entries.get(id);
    }
    return [...this.entries.values()].find((entry) => entry.name === id);
  }

  private async waitForReady(
    entry: BackgroundEntry & { child?: ChildProcess },
    options: { readyPattern?: string; readyPort?: number; timeoutMs?: number },
  ): Promise<boolean> {
    const timeout = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    if (!options.readyPattern && !options.readyPort) {
      setTimeout(() => {
        if (entry.status === 'starting') {
          entry.status = 'running';
        }
      }, 800);
      return false;
    }
    const deadline = Date.now() + timeout;
    const pattern = options.readyPattern ? new RegExp(options.readyPattern, 'i') : undefined;
    while (Date.now() < deadline) {
      if (entry.status === 'exited' || entry.status === 'error') {
        return false;
      }
      if (pattern && pattern.test(entry.output)) {
        entry.status = 'ready';
        return true;
      }
      if (options.readyPort && (await portOpen(options.readyPort))) {
        entry.status = 'ready';
        return true;
      }
      await delay(400);
    }
    entry.status = 'running';
    return false;
  }
}

export function formatTrackedProcesses(entries: BackgroundEntry[]): string {
  if (entries.length === 0) {
    return 'No background processes are tracked by Dev-First.';
  }
  return entries
    .map((entry) => {
      const status = entry.status === 'exited' ? `exited(${entry.exitCode ?? 'unknown'})` : entry.status;
      const readiness: string[] = [];
      if (entry.readyPort !== undefined) {
        readiness.push(`port ${entry.readyPort}`);
      }
      if (entry.readyPattern) {
        readiness.push(`ready pattern /${entry.readyPattern}/`);
      }
      return `${entry.name} — ${entry.command} · started ${new Date(entry.startedAt).toISOString()} · ${status}${
        readiness.length > 0 ? ` · ${readiness.join(' · ')}` : ''
      }`;
    })
    .join('\n');
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(600, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
