export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = /```(?:json|jsonc|javascript|js|typescript|ts)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    return fence[1].trim();
  }
  return trimmed;
}

export function sanitizeControlChars(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function extractBalanced(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) {
    return undefined;
  }
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

export function parseJsonLoose(text: string): unknown {
  const directRaw = tryParseJson(text.trim());
  if (directRaw !== undefined) {
    return directRaw;
  }
  const cleaned = stripCodeFences(text);
  const candidates = [cleaned, sanitizeControlChars(cleaned)];
  for (const candidate of candidates) {
    const direct = tryParseJson(candidate);
    if (direct !== undefined) {
      return direct;
    }
    const extracted = extractBalanced(candidate);
    if (extracted) {
      const parsed = tryParseJson(extracted);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }
  return undefined;
}
