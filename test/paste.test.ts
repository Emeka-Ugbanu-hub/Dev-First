import { describe, expect, it } from 'vitest';
import {
  PASTE_LINE_THRESHOLD,
  createPasteChip,
  expandPastes,
  removeMarker,
  shouldCollapsePaste,
  shouldSavePasteFile,
} from '../webview/src/lib/paste';

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}`).join('\n');
}

describe('shouldCollapsePaste', () => {
  it('leaves short pastes alone', () => {
    expect(shouldCollapsePaste('one\ntwo\nthree')).toBe(false);
  });

  it('collapses pastes above the threshold', () => {
    const long = Array.from({ length: PASTE_LINE_THRESHOLD + 1 }, (_, index) => `line ${index}`).join('\n');
    expect(shouldCollapsePaste(long)).toBe(true);
  });
});

describe('shouldSavePasteFile', () => {
  it('keeps pastes at the limit inline', () => {
    expect(shouldSavePasteFile(lines(120), 120)).toBe(false);
  });

  it('saves pastes above the limit', () => {
    expect(shouldSavePasteFile(lines(121), 120)).toBe(true);
  });
});

describe('paste chips', () => {
  it('creates a marker with the line count', () => {
    const chip = createPasteChip('p1', 'a\nb\nc');
    expect(chip.marker).toBe('[Pasted ~3 lines]');
    expect(chip.lines).toBe(3);
  });

  it('expands markers back to the full text on send', () => {
    const chip = createPasteChip('p1', 'full\ntext\nhere');
    const text = `review this ${chip.marker} please`;
    expect(expandPastes(text, [chip])).toBe('review this full\ntext\nhere please');
  });

  it('expands multiple chips', () => {
    const first = createPasteChip('p1', 'one');
    const second = createPasteChip('p2', 'two');
    const text = `${first.marker} and ${second.marker}`;
    expect(expandPastes(text, [first, second])).toBe('one and two');
  });

  it('removes a marker cleanly', () => {
    const chip = createPasteChip('p1', 'x');
    expect(removeMarker(`hello ${chip.marker}`, chip.marker)).toBe('hello');
  });

  it('marks file-backed chips with a save marker', () => {
    const chip = createPasteChip('p1', lines(121), true);
    expect(chip.saveToFile).toBe(true);
    expect(chip.marker).toBe('[Pasted ~121 lines → saved to file]');
  });

  it('does not expand file-backed chips', () => {
    const fileChip = createPasteChip('p1', lines(121), true);
    const inlineChip = createPasteChip('p2', 'inline\ntext');
    const text = `${fileChip.marker} and ${inlineChip.marker}`;
    const expanded = expandPastes(text, [fileChip, inlineChip]);
    expect(expanded).toContain(fileChip.marker);
    expect(expanded).toContain('inline\ntext');
  });
});
