import { createHash } from 'crypto';
import type * as vscode from 'vscode';

const BASELINE_KEY = 'devFirst.scanBaseline';
const SAVE_DEBOUNCE_MS = 1000;

export function findingKey(ruleId: string, relativePath: string, lineText: string): string {
  const digest = createHash('sha1').update(lineText.trim()).digest('hex');
  return `${ruleId}\u0000${relativePath}\u0000${digest}`;
}

export class ScanBaseline {
  private readonly keys = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(private readonly state: vscode.Memento) {
    const stored = state.get<string[]>(BASELINE_KEY);
    if (Array.isArray(stored)) {
      for (const key of stored) {
        this.keys.add(key);
      }
    }
  }

  get size(): number {
    return this.keys.size;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  record(keys: Iterable<string>): void {
    let changed = false;
    for (const key of keys) {
      if (!this.keys.has(key)) {
        this.keys.add(key);
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.scheduleSave();
    }
  }

  async clear(): Promise<void> {
    this.keys.clear();
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.state.update(BASELINE_KEY, []);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.dirty) {
      this.dirty = false;
      void this.state.update(BASELINE_KEY, [...this.keys]);
    }
  }

  private scheduleSave(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) {
        return;
      }
      this.dirty = false;
      void this.state.update(BASELINE_KEY, [...this.keys]);
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }
}
