import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, mkdirSync, WriteStream } from 'fs';
import * as path from 'path';
import { SandboxMode, sandboxCommand } from './sandbox';
import { spillFileName, toolOutputDir } from './outputStore';

export interface TerminalResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  note?: string;
  spillPath?: string;
}

export interface TerminalBackground {
  adopt(name: string, command: string, child: ChildProcess, output: string): string;
}

export interface TerminalRunOptions {
  inactivityTimeoutMs?: number;
  absoluteCapMs?: number;
  background?: TerminalBackground;
}

const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_INACTIVITY_MS = 15_000;
const DEFAULT_ABSOLUTE_CAP_MS = 10 * 60_000;

const OSC_PATTERN = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const DCS_PATTERN = /\u001B[P^_][^\u001B]*(?:\u001B\\)?/g;
const CSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(OSC_PATTERN, '').replace(DCS_PATTERN, '').replace(CSI_PATTERN, '');
}

export function runTerminalCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  signal?: AbortSignal,
  sandbox: SandboxMode = 'off',
  options: TerminalRunOptions = {},
): Promise<TerminalResult> {
  return new Promise<TerminalResult>((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let capTimer: NodeJS.Timeout | undefined;
    let spill: WriteStream | undefined;
    let spillPath: string | undefined;
    let spillAttempted = false;

    const sandboxed = sandboxCommand(command, cwd, sandbox);
    const child = sandboxed.command
      ? spawn(sandboxed.command.file, sandboxed.command.args, {
          cwd,
          env: process.env,
          windowsHide: true,
        })
      : spawn(command, {
          shell: true,
          cwd,
          env: process.env,
          windowsHide: true,
        });

    const capMs = Math.min(
      Math.max(1, timeoutSeconds) * 1000,
      options.absoluteCapMs ?? DEFAULT_ABSOLUTE_CAP_MS,
    );
    const inactivityMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_MS;

    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    };

    const startSpill = (content: string) => {
      spillAttempted = true;
      try {
        const dir = toolOutputDir(cwd);
        mkdirSync(dir, { recursive: true });
        const absolute = path.join(dir, spillFileName('terminal'));
        const stream = createWriteStream(absolute, { flags: 'w' });
        stream.on('error', () => {
          spill = undefined;
          spillPath = undefined;
        });
        stream.write(content);
        spill = stream;
        spillPath = path.relative(cwd, absolute).split(path.sep).join('/');
      } catch {
        spill = undefined;
        spillPath = undefined;
      }
    };

    const finish = (result: TerminalResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (capTimer) {
        clearTimeout(capTimer);
      }
      clearIdle();
      signal?.removeEventListener('abort', onAbort);
      const final: TerminalResult = {
        ...result,
        output: stripAnsi(result.output),
        ...(spillPath ? { spillPath } : {}),
      };
      if (spill) {
        const stream = spill;
        let done = false;
        let timer: NodeJS.Timeout | undefined;
        const complete = () => {
          if (done) {
            return;
          }
          done = true;
          if (timer) {
            clearTimeout(timer);
          }
          resolve(final);
        };
        stream.once('close', complete);
        timer = setTimeout(complete, 1000);
        stream.end();
        return;
      }
      resolve(final);
    };

    const onIdle = () => {
      const seconds = Math.round(inactivityMs / 1000);
      let note = `The command produced no output for ${seconds}s and is still running.`;
      if (options.background) {
        try {
          const id = options.background.adopt(command.slice(0, 40), command, child, output);
          note = `The command produced no output for ${seconds}s and is still running in the background (id ${id}). Use background_process with action "logs" or "stop".`;
        } catch {
          note = `The command produced no output for ${seconds}s and is still running.`;
        }
      }
      finish({ output, exitCode: null, timedOut: false, note });
    };

    const armIdle = () => {
      if (inactivityMs <= 0 || settled) {
        return;
      }
      clearIdle();
      idleTimer = setTimeout(onIdle, inactivityMs);
    };

    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output += text;
      if (output.length > MAX_OUTPUT_CHARS) {
        if (spill?.writable) {
          spill.write(text);
        } else if (!spillAttempted) {
          startSpill(output);
        }
        output = `... [earlier output truncated] ...\n${output.slice(output.length - MAX_OUTPUT_CHARS)}`;
      }
      armIdle();
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    capTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, capMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    armIdle();

    child.on('close', (code) => {
      finish({ output, exitCode: code, timedOut, note: sandboxed.note });
    });
    child.on('error', (error) => {
      finish({
        output: `${output}\nFailed to start command: ${error.message}`,
        exitCode: -1,
        timedOut: false,
        note: sandboxed.note,
      });
    });
  });
}
