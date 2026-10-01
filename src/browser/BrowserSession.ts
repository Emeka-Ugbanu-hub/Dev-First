import { promises as fs } from 'fs';
import * as path from 'path';
import { ensureDebugBrowser } from './ChromeLauncher';

interface CdpResponse {
  id?: number;
  result?: any;
  error?: { message?: string };
}

export interface BrowserSessionOptions {
  autoLaunch: boolean;
  profileDir: string;
}

export class BrowserSession {
  private socket: any;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly port: number,
    private readonly options: BrowserSessionOptions,
  ) {}

  async navigate(url: string): Promise<string> {
    await this.ensureConnected();
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    await sleep(1200);
    const title = await this.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    const value = title?.result?.value;
    return `Navigated to ${url}${value ? ` — title: "${value}"` : ''}.`;
  }

  async evaluate(expression: string): Promise<string> {
    await this.ensureConnected();
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response?.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'unknown error';
      return `Error: ${description}`;
    }
    const value = response?.result?.value;
    if (value === undefined) {
      return '(no value)';
    }
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  }

  async screenshot(dir: string): Promise<string> {
    await this.ensureConnected();
    const response = await this.send('Page.captureScreenshot', { format: 'png' });
    const data = response?.data;
    if (!data) {
      return 'Error: screenshot failed (no data returned).';
    }
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `screenshot-${Date.now()}.png`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    return `Screenshot saved to ${file}`;
  }

  dispose(): void {
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = undefined;
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === 1) {
      return;
    }
    if (this.options.autoLaunch) {
      const launch = await ensureDebugBrowser(this.port, this.options.profileDir);
      if (!launch.launched && launch.reason === 'no-browser') {
        throw new Error(
          'No Chrome or Edge installation was found. Install one, or start a browser yourself with --remote-debugging-port=' +
            `${this.port} and disable devFirst.browserAutoLaunch.`,
        );
      }
    }
    let targets: any[];
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      targets = (await response.json()) as any[];
    } catch (error) {
      throw new Error(
        `Cannot reach a browser on port ${this.port}. Start Chrome or Edge with --remote-debugging-port=${this.port} (e.g. "google-chrome --remote-debugging-port=${this.port}").`,
      );
    }
    const page = targets.find((target) => target?.type === 'page' && target?.webSocketDebuggerUrl);
    if (!page) {
      throw new Error('No page target found in the connected browser.');
    }
    await this.connect(page.webSocketDebuggerUrl);
  }

  private connect(url: string): Promise<void> {
    const WebSocketImpl = (globalThis as any).WebSocket as new (url: string) => any;
    if (!WebSocketImpl) {
      return Promise.reject(new Error('WebSocket is not available in this runtime.'));
    }
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocketImpl(url);
      this.socket = socket;
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Failed to connect to the browser debugger socket.'));
      socket.onmessage = (event: any) => this.handleMessage(String(event.data));
      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = undefined;
        }
      };
    });
  }

  private handleMessage(data: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message ?? 'CDP error'));
      } else {
        entry.resolve(message.result);
      }
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
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
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
