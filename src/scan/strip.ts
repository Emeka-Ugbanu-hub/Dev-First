export interface StrippedText {
  text: string;
  lineMap: number[];
}

export function stripForAi(text: string, languageId = ''): StrippedText {
  const python = languageId === 'python';
  const lines = text.split('\n');
  const kept: string[] = [];
  const lineMap: number[] = [];
  let inBlockComment = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const state = commentState(line, inBlockComment, python);
    inBlockComment = state.inBlockComment;
    if (state.comment || line.trim() === '') {
      continue;
    }
    kept.push(collapseSpaces(line, python));
    lineMap.push(index);
  }
  return { text: kept.join('\n'), lineMap };
}

function commentState(
  line: string,
  inBlockComment: boolean,
  python: boolean,
): { comment: boolean; inBlockComment: boolean } {
  const trimmed = line.trim();
  if (inBlockComment) {
    const end = trimmed.indexOf('*/');
    if (end === -1) {
      return { comment: true, inBlockComment: true };
    }
    return { comment: trimmed.slice(end + 2).trim() === '', inBlockComment: false };
  }
  if (trimmed.startsWith('//')) {
    return { comment: true, inBlockComment: false };
  }
  if (python && trimmed.startsWith('#')) {
    return { comment: true, inBlockComment: false };
  }
  if (trimmed.startsWith('/*')) {
    const end = trimmed.indexOf('*/', 2);
    if (end === -1) {
      return { comment: true, inBlockComment: true };
    }
    return { comment: trimmed.slice(end + 2).trim() === '', inBlockComment: false };
  }
  return { comment: false, inBlockComment: false };
}

function collapseSpaces(line: string, python: boolean): string {
  if (!python) {
    return line.replace(/[ \t]+/g, ' ');
  }
  const indent = line.match(/^[ \t]*/)?.[0] ?? '';
  const rest = line.slice(indent.length).replace(/[ \t]+/g, ' ');
  return indent + rest;
}
