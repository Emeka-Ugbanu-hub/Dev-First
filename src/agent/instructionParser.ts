export const INSTRUCTION_ASK =
  'State the target path, the exact text or symbol, and the intended change (for example: rename X to Y, replace "old" with "new", remove "text", or set the string name to "value").';

export type ParsedInstruction =
  | { kind: 'rename'; oldName: string; newName: string }
  | { kind: 'replace'; oldText: string; newText: string }
  | { kind: 'remove'; oldText: string }
  | { kind: 'set_string'; name: string; value: string }
  | { kind: 'unknown'; instruction: string; ask: string };

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseInstruction(raw: string): ParsedInstruction {
  const instruction = (raw ?? '').trim();
  if (!instruction) {
    return { kind: 'unknown', instruction, ask: INSTRUCTION_ASK };
  }

  const rename = /^rename\s+([A-Za-z_$][\w$]*)\s+(?:to|->)\s+([A-Za-z_$][\w$]*)$/i.exec(instruction);
  if (rename) {
    return { kind: 'rename', oldName: rename[1], newName: rename[2] };
  }

  const replace =
    /^replace\s+(?:"([^"]*)"|'([^']*)')\s+with\s+(?:"([^"]*)"|'([^']*)')$/i.exec(instruction);
  if (replace) {
    return {
      kind: 'replace',
      oldText: replace[1] ?? replace[2] ?? '',
      newText: replace[3] ?? replace[4] ?? '',
    };
  }

  const remove = /^remove\s+(?:"([^"]*)"|'([^']*)')$/i.exec(instruction);
  if (remove) {
    return { kind: 'remove', oldText: remove[1] ?? remove[2] ?? '' };
  }

  const setString = /^set\s+the\s+string\s+(.+?)\s+to\s+(?:"([^"]*)"|'([^']*)')$/i.exec(instruction);
  if (setString) {
    const name = stripQuotes(setString[1]);
    if (name) {
      return { kind: 'set_string', name, value: setString[2] ?? setString[3] ?? '' };
    }
  }

  return { kind: 'unknown', instruction, ask: INSTRUCTION_ASK };
}

export interface QuotedAssignment {
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  value: string;
  keyQuote: string;
  valueQuote: string;
  line: number;
}

export function findQuotedAssignments(content: string, name: string): QuotedAssignment[] {
  if (!name) {
    return [];
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(['"])${escaped}\\1\\s*:\\s*(['"])((?:\\\\.|(?!\\2).)*)\\2`, 'g');
  const matches: QuotedAssignment[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const keyQuote = match[1];
    const valueQuote = match[3];
    const full = match[0];
    const value = match[4] ?? '';
    const valueOffset = full.lastIndexOf(valueQuote + value + valueQuote);
    const valueStart = match.index + valueOffset + 1;
    matches.push({
      start: match.index,
      end: match.index + full.length,
      valueStart,
      valueEnd: valueStart + value.length,
      value,
      keyQuote,
      valueQuote,
      line: content.slice(0, match.index).split('\n').length,
    });
  }
  return matches;
}

export type SetStringOutcome =
  | { ok: true; content: string; count: number }
  | { ok: false; reason: string; lines?: number[] };

export function setQuotedString(content: string, name: string, value: string): SetStringOutcome {
  const matches = findQuotedAssignments(content, name);
  if (matches.length === 0) {
    return { ok: false, reason: `no quoted assignment for "${name}" was found.` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `"${name}" is assigned ${matches.length} times; the change is ambiguous.`,
      lines: matches.map((match) => match.line),
    };
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `((['"])${escaped}\\2\\s*:\\s*)(['"])((?:\\\\.|(?!\\3).)*)(\\3)`,
  );
  const updated = content.replace(pattern, (_full, prefix: string, _keyQuote: string, valueQuote: string) =>
    `${prefix}${valueQuote}${value}${valueQuote}`,
  );
  return { ok: true, content: updated, count: 1 };
}
