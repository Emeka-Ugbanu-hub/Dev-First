export type ConvergenceState = 'EMPTY' | 'TRUNCATED' | 'FIXED_POINT' | 'SAME_PLAN' | 'SHELL_LOOP';

export interface ConvergenceObservation {
  signature: string;
  producedOutput: boolean;
  madeProgress: boolean;
  toolNames?: readonly string[];
}

/** Detects repeated turns that produce no new evidence or deliverable. */
export class ConvergenceGuard {
  private previousSignature = '';
  private repeats = 0;
  private emptyTurns = 0;

  observe(observation: ConvergenceObservation): { state: ConvergenceState; reason: string } | undefined {
    if (!observation.producedOutput && !observation.madeProgress) {
      this.emptyTurns += 1;
      if (this.emptyTurns >= 2) {
        return { state: 'EMPTY', reason: 'two turns produced no answer, tool result, or progress' };
      }
    } else {
      this.emptyTurns = 0;
    }

    if (observation.madeProgress) {
      this.previousSignature = observation.signature;
      this.repeats = 0;
      return undefined;
    }

    if (observation.signature && observation.signature === this.previousSignature) {
      this.repeats += 1;
      if (this.repeats >= 2) {
        const shellLoop = observation.toolNames?.length
          && observation.toolNames.every((name) => name === 'run_terminal_command');
        return {
          state: shellLoop ? 'SHELL_LOOP' : 'FIXED_POINT',
          reason: shellLoop
            ? 'the same terminal operation repeated without new progress'
            : 'the same turn repeated without new evidence or progress',
        };
      }
    } else {
      this.previousSignature = observation.signature;
      this.repeats = 0;
    }
    return undefined;
  }
}
