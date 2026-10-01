export type MistakeAction = 'none' | 'correct' | 'stop';

export interface MistakeResult {
  action: MistakeAction;
  count: number;
}

export class MistakeTracker {
  private consecutive = 0;

  constructor(
    private readonly correctAt = 3,
    private readonly stopAt = 6,
  ) {}

  record(result: string): MistakeResult {
    const failed = result.startsWith('Error:') || result.startsWith('Error in');
    if (!failed) {
      this.consecutive = 0;
      return { action: 'none', count: 0 };
    }
    this.consecutive++;
    if (this.consecutive >= this.stopAt) {
      return { action: 'stop', count: this.consecutive };
    }
    if (this.consecutive === this.correctAt) {
      return { action: 'correct', count: this.consecutive };
    }
    return { action: 'none', count: this.consecutive };
  }

  reset(): void {
    this.consecutive = 0;
  }
}
