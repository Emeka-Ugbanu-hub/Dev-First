import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { getConfig, NotifySound } from '../config';
import { Phase } from '../shared/protocol';

export const SOUND_FILES: Record<Exclude<NotifySound, 'off'>, string> = {
  chime: '/System/Library/Sounds/Glass.aiff',
  beep: '/System/Library/Sounds/Ping.aiff',
};

export const INPUT_DEBOUNCE_MS = 5000;

export function shouldNotifyInput(
  last: { message: string; at: number } | undefined,
  message: string,
  now: number,
): boolean {
  return !last || last.message !== message || now - last.at > INPUT_DEBOUNCE_MS;
}

export class AttentionService {
  private caffeinate: ChildProcess | undefined;
  private lastInput: { message: string; at: number } | undefined;

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push({ dispose: () => this.stopKeepAwake() });
  }

  complete(): void {
    if (getConfig().notifyOnComplete) {
      void vscode.window.showInformationMessage('Dev-First: task complete.');
    }
    this.playSound();
  }

  error(message: string): void {
    if (getConfig().notifyOnError) {
      void vscode.window.showErrorMessage(`Dev-First: ${shorten(message)}`);
    }
    this.playSound();
  }

  needsInput(message: string): void {
    if (!getConfig().notifyOnInput) {
      return;
    }
    const now = Date.now();
    if (!shouldNotifyInput(this.lastInput, message, now)) {
      return;
    }
    this.lastInput = { message, at: now };
    void vscode.window.showInformationMessage(`Dev-First: ${shorten(message)}`);
    this.playSound();
  }

  setPhase(phase: Phase): void {
    if (getConfig().keepAwake && (phase === 'planning' || phase === 'executing')) {
      this.startKeepAwake();
    } else {
      this.stopKeepAwake();
    }
  }

  private playSound(): void {
    const sound = getConfig().notifySound;
    if (sound === 'off' || process.platform !== 'darwin') {
      return;
    }
    try {
      const child = spawn('afplay', [SOUND_FILES[sound]], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch {
      return;
    }
  }

  private startKeepAwake(): void {
    if (this.caffeinate || process.platform !== 'darwin') {
      return;
    }
    try {
      const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      child.on('exit', () => {
        if (this.caffeinate === child) {
          this.caffeinate = undefined;
        }
      });
      child.unref();
      this.caffeinate = child;
    } catch {
      this.caffeinate = undefined;
    }
  }

  private stopKeepAwake(): void {
    const child = this.caffeinate;
    this.caffeinate = undefined;
    if (!child) {
      return;
    }
    try {
      child.kill();
    } catch {
      return;
    }
  }
}

function shorten(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}
