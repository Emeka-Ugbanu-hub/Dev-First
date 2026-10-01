import { ToolCall } from '../llm/types';

export type DoomLoopAction = 'none' | 'warn' | 'stop';

export interface DoomLoopResult {
  action: DoomLoopAction;
  count: number;
  key: string;
}

export class DoomLoopDetector {
  private history: string[] = [];
  private readonly warned = new Set<string>();

  constructor(
    private readonly window = 8,
    private readonly warnAt = 3,
    private readonly stopAt = 5,
  ) {}

  record(call: ToolCall): DoomLoopResult {
    const key = `${call.name}:${call.arguments}`;
    this.history.push(key);
    if (this.history.length > this.window) {
      this.history.shift();
    }
    const count = this.history.filter((entry) => entry === key).length;

    if (count >= this.stopAt) {
      return { action: 'stop', count, key };
    }
    if (count >= this.warnAt && !this.warned.has(key)) {
      this.warned.add(key);
      return { action: 'warn', count, key };
    }
    return { action: 'none', count, key };
  }

  reset(): void {
    this.history = [];
    this.warned.clear();
  }
}
