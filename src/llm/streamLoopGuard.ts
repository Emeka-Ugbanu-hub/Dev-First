export type StreamLoopChannel = 'text' | 'reasoning';

export interface StreamLoopDetection {
  channel: StreamLoopChannel;
  /** Number of raw characters at the end of this channel to discard. */
  repeatedChars: number;
  reason: 'repeated-suffix' | 'repeated-paragraph';
}

export function createChildAbortController(parent: AbortSignal): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) abortFromParent();
  else parent.addEventListener('abort', abortFromParent, { once: true });
  return {
    controller,
    dispose: () => parent.removeEventListener('abort', abortFromParent),
  };
}

const MIN_SCAN_DELTA = 48;
const MAX_REPEAT_CHARS = 1_600;
const MAX_TRACKED_CHARS = 12_000;
const MIN_REASONING_REPEAT = 80;
const MIN_TEXT_REPEAT = 120;
const MIN_PARAGRAPH_CHARS = 120;

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Detects a repeated suffix in one live model turn. It deliberately operates
 * on literal stream content: semantic similarity alone is too error-prone to
 * interrupt legitimate code explanations or repeated file reads.
 */
export class StreamLoopGuard {
  private readonly content: Record<StreamLoopChannel, string> = { text: '', reasoning: '' };
  private readonly scannedAt: Record<StreamLoopChannel, number> = { text: 0, reasoning: 0 };
  private readonly totalSeen: Record<StreamLoopChannel, number> = { text: 0, reasoning: 0 };
  private detection: StreamLoopDetection | undefined;

  observe(channel: StreamLoopChannel, delta: string): StreamLoopDetection | undefined {
    if (this.detection || !delta) return this.detection;
    const combined = this.content[channel] + delta;
    this.totalSeen[channel] += delta.length;
    const current = combined.slice(-MAX_TRACKED_CHARS);
    this.content[channel] = current;
    if (this.totalSeen[channel] - this.scannedAt[channel] < MIN_SCAN_DELTA) return undefined;
    this.scannedAt[channel] = this.totalSeen[channel];

    const minimum = channel === 'reasoning' ? MIN_REASONING_REPEAT : MIN_TEXT_REPEAT;
    const sample = current.slice(-minimum);
    const copiesRequired = channel === 'reasoning' ? 2 : 3;
    let searchBefore = current.length - minimum - 1;
    for (let occurrence = 0; occurrence < 8 && searchBefore >= 0; occurrence++) {
      const priorSampleAt = current.lastIndexOf(sample, searchBefore);
      if (priorSampleAt < 0) break;
      const period = current.length - minimum - priorSampleAt;
      const repeatedStart = current.length - period * copiesRequired;
      const latest = normalize(current.slice(-period));
      let allCopiesMatch = repeatedStart >= 0;
      for (let copy = 1; allCopiesMatch && copy < copiesRequired; copy++) {
        const start = current.length - period * (copy + 1);
        allCopiesMatch = normalize(current.slice(start, start + period)) === latest;
      }
      if (
        period >= minimum &&
        period <= MAX_REPEAT_CHARS &&
        allCopiesMatch
      ) {
        this.detection = {
          channel,
          repeatedChars: period,
          reason: 'repeated-suffix',
        };
        return this.detection;
      }
      searchBefore = priorSampleAt - 1;
    }

    const paragraphRepeat = repeatedParagraphSuffix(current);
    if (paragraphRepeat) {
      this.detection = {
        channel,
        repeatedChars: paragraphRepeat,
        reason: 'repeated-paragraph',
      };
      return this.detection;
    }
    return undefined;
  }

  get detected(): StreamLoopDetection | undefined {
    return this.detection;
  }
}

function repeatedParagraphSuffix(value: string): number | undefined {
  // Only inspect paragraphs that have reached a blank-line boundary; partial
  // prose is too easy to mistake for repetition while tokens are arriving.
  const boundaries = [...value.matchAll(/\r?\n[ \t]*\r?\n/g)];
  const lastBoundary = boundaries.at(-1);
  if (!lastBoundary || lastBoundary.index === undefined) return undefined;
  const completeText = value.slice(0, lastBoundary.index);
  const paragraphs = completeText.split(/\r?\n[ \t]*\r?\n/);
  if (paragraphs.length < 3) return undefined;
  const latest = paragraphs.at(-1) ?? '';
  const signature = normalize(latest);
  if (signature.length < MIN_PARAGRAPH_CHARS) return undefined;
  const repeats = paragraphs.filter((paragraph) => normalize(paragraph) === signature).length;
  if (repeats < 3) return undefined;
  const latestStart = completeText.lastIndexOf(latest);
  const previousBoundary = boundaries.at(-2);
  const rewindStart = previousBoundary?.index ?? latestStart;
  return value.length - rewindStart;
}

export function streamLoopRecoveryPrompt(): string {
  return 'A repetition guard stopped the previous response because it repeated content without adding evidence. Continue from the last distinct point. Do not restate the repeated text or repeat the same tool call. Take the next relevant action, use new evidence, or state the blocker and finish the response.';
}
