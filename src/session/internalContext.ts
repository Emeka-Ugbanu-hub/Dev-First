const MARKERS = [
  /^\[Durable task ledger\b/i,
  /^\[Pinned context\b/i,
  /^\[Execution context projection\]/i,
  /^\[Summary of earlier work\b/i,
  /^\[Deterministic checkpoint of earlier work\]/i,
  /^\[New request boundary\]/i,
  /^\[Compacted conversation section\]/i,
];

const FIELD = /^(?:State:|Last route:|Last stage:|Task state:|Completed steps:|Next steps:|Blockers:|Changed files:|Latest request:|Active plan\b|Pending |Diagnostics:|Do not redo\b|Session memory:|Goal:|Decisions:|Touched files:|Last completed step:|Next step:|Open blockers:|Latest answer tail:|Never repeat pinned context\b)/i;

/**
 * The model must never surface pinned context, ledgers, or checkpoints in a
 * user-facing answer. Remove trailing internal blocks; leave a marker alone
 * when it appears inside real content.
 */
export function stripInternalContext(text: string): string {
  const lines = text.split('\n');
  let marker = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (MARKERS.some((pattern) => pattern.test(lines[index].trim()))) {
      marker = index;
      break;
    }
  }
  if (marker < 0) return text;
  const tail = lines.slice(marker + 1).filter((line) => line.trim());
  if (tail.length === 0) {
    return lines.slice(0, marker).join('\n').trimEnd();
  }
  if (tail.every((line) => FIELD.test(line.trim()) || line.trim().startsWith('['))) {
    return lines.slice(0, marker).join('\n').trimEnd();
  }
  return text;
}
