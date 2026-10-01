import { SelectionContext } from '../shared/protocol';

export const MAX_SELECTION_CHARS = 20_000;

export function formatSelectionAttachment(selection: SelectionContext): string {
  const text =
    selection.text.length > MAX_SELECTION_CHARS
      ? `${selection.text.slice(0, MAX_SELECTION_CHARS)}\n... [selection truncated]`
      : selection.text;
  return `\n\nContext — selection from ${selection.path}:${selection.startLine}-${selection.endLine}:\n\`\`\`\n${text}\n\`\`\``;
}
