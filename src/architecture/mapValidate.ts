export interface MapPaths {
  [nodeId: string]: string;
}

export interface ValidatedMap {
  mermaid: string;
  paths: MapPaths;
}

const FORBIDDEN_PATTERNS = [
  /click /i,
  /style /i,
  /linkStyle/i,
  /classDef/i,
  /<script/i,
  /<div/i,
];

const PATH_LINE = /^%%\s*([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.+?))\s*$/;

function stripFences(raw: string): string {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length === 0 || !/^(```|~~~)/.test(lines[0].trim())) {
    return raw.trim();
  }
  lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  if (lines.length > 0 && /^(```|~~~)\s*$/.test(lines[lines.length - 1].trim())) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

function balanced(text: string): boolean {
  let square = 0;
  let round = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '[') {
      square++;
    } else if (char === ']') {
      square--;
      if (square < 0) {
        return false;
      }
    } else if (char === '(') {
      round++;
    } else if (char === ')') {
      round--;
      if (round < 0) {
        return false;
      }
    }
  }
  return !quoted && square === 0 && round === 0;
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '');
}

export function validateMermaidMap(
  raw: string,
  exists: (relativePath: string) => boolean,
): ValidatedMap | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const source = stripFences(raw);
  if (!source || !/^(flowchart|graph)\b/i.test(source)) {
    return undefined;
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(source)) {
      return undefined;
    }
  }

  const lines = source.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === '%% PATHS');
  const mermaidLines = markerIndex >= 0 ? lines.slice(0, markerIndex) : lines;
  const pathLines = markerIndex >= 0 ? lines.slice(markerIndex + 1) : [];

  for (const line of mermaidLines) {
    if (line.trim().startsWith('%%')) {
      return undefined;
    }
  }

  const mermaid = mermaidLines.join('\n').trim();
  if (!mermaid || !balanced(mermaid)) {
    return undefined;
  }

  const paths: MapPaths = {};
  for (const line of pathLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = PATH_LINE.exec(trimmed);
    if (!match) {
      return undefined;
    }
    const nodeId = match[1];
    const rawPath = match[2] ?? match[3] ?? match[4] ?? '';
    const path = normalizePath(rawPath);
    if (!nodeId || !path) {
      continue;
    }
    if (exists(path)) {
      paths[nodeId] = path;
    }
  }

  return { mermaid, paths };
}
