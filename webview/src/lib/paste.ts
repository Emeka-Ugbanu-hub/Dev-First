export const PASTE_LINE_THRESHOLD = 12;

export interface PasteChip {
  id: string;
  marker: string;
  lines: number;
  text: string;
  saveToFile?: boolean;
}

export function shouldCollapsePaste(text: string): boolean {
  return text.split('\n').length > PASTE_LINE_THRESHOLD;
}

export function shouldSavePasteFile(text: string, limit: number): boolean {
  return text.split('\n').length > limit;
}

export function createPasteChip(id: string, text: string, saveToFile = false): PasteChip {
  const lines = text.split('\n').length;
  const marker = saveToFile ? `[Pasted ~${lines} lines → saved to file]` : `[Pasted ~${lines} lines]`;
  return { id, marker, lines, text, ...(saveToFile ? { saveToFile: true } : {}) };
}

export function expandPastes(text: string, chips: PasteChip[]): string {
  let result = text;
  for (const chip of chips) {
    if (chip.saveToFile) {
      continue;
    }
    result = result.replace(chip.marker, chip.text);
  }
  return result;
}

export function removeMarker(text: string, marker: string): string {
  return text.replace(marker, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}
