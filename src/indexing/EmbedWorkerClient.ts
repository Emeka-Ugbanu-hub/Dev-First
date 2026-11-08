import { ChildProcess, spawn } from 'child_process';

interface PendingRequest {
  resolve: (vectors: number[][]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerMessage {
  type?: string;
  id?: string;
  vectors?: unknown;
  message?: string;
}

const MAX_BATCH = 24;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_FAILURES = 2;
const MAX_REQUESTS_BEFORE_RESTART = 32;

export class EmbedWorkerClient {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
  private failures = 0;
  private completedRequests = 0;
  private unavailableReason: string | undefined;
  private stopping = false;
  private recycleWhenIdle = false;

  constructor(
    private readonly workerPath: string,
    private readonly modelRoot: string,
  ) {}

  get unavailable(): string | undefined {
    return this.unavailableReason;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (this.unavailableReason) {
      throw new Error(this.unavailableReason);
    }
    const output: number[][] = [];
    for (let index = 0; index < texts.length; index += MAX_BATCH) {
      const batch = texts.slice(index, index + MAX_BATCH);
      output.push(...(await this.requestWithRetry(batch)));
      this.failures = 0;
      this.completedRequests += 1;
      if (this.completedRequests >= MAX_REQUESTS_BEFORE_RESTART) {
        this.recycle();
      }
    }
    return output;
  }

  private async requestWithRetry(texts: string[]): Promise<number[][]> {
    try {
      return await this.request(texts);
    } catch (error) {
      if (this.unavailableReason) throw error;
      // A worker crash is contained; try one fresh worker before degrading.
      return this.request(texts);
    }
  }

  private recycle(): void {
    // Never terminate a worker while a request is in flight; the exit handler
    // would reject that request even though the caller is still waiting.
    if (this.pending.size > 0) {
      this.recycleWhenIdle = true;
      return;
    }
    this.recycleWhenIdle = false;
    const child = this.child;
    this.child = undefined;
    this.completedRequests = 0;
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }
  }

  stop(): void {
    this.stopping = true;
    this.recycleWhenIdle = false;
    const child = this.child;
    this.child = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Embedding worker stopped.'));
      this.pending.delete(id);
    }
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }
  }

  private request(texts: string[]): Promise<number[][]> {
    const child = this.ensureChild();
    const id = `embed_${++this.nextId}`;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Embedding worker timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.send({ type: 'embed', id, texts });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureChild(): ChildProcess {
    if (this.child?.connected) {
      return this.child;
    }
    const child = spawn(process.execPath, [this.workerPath, this.modelRoot], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DEVFIRST_MODEL_ROOT: this.modelRoot,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    child.on('message', (message: WorkerMessage) => this.handleMessage(message));
    child.on('error', (error) => this.handleExit(child, error));
    child.on('exit', (code, signal) => this.handleExit(child, undefined, code, signal));
    this.child = child;
    return child;
  }

  private handleMessage(message: WorkerMessage): void {
    if (!message || typeof message.id !== 'string') {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'result' && Array.isArray(message.vectors)) {
      this.failures = 0;
      pending.resolve(message.vectors as number[][]);
      if (this.recycleWhenIdle && this.pending.size === 0) {
        this.recycle();
      }
      return;
    }
    pending.reject(new Error(message.message || 'Embedding worker failed.'));
    if (this.recycleWhenIdle && this.pending.size === 0) {
      this.recycle();
    }
  }

  private handleExit(
    child: ChildProcess,
    error?: Error,
    code?: number | null,
    signal?: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(error?.message || `Embedding worker exited (${code ?? signal ?? 'unknown'}).`));
      this.pending.delete(id);
    }
    if (this.stopping) {
      return;
    }
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.unavailableReason =
        'Local semantic search stopped after repeated embedding-worker crashes. Lexical search remains available.';
    }
  }
}
