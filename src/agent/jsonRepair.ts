export function repairJson(input: string): string {
  const fenced = stripFences(input.trim());
  const withoutTrailingCommas = removeTrailingCommas(fenced);
  const escaped = escapeNewlinesInStrings(withoutTrailingCommas);
  return closeOpenStructures(escaped);
}

export function parseToolArguments(json: string): Record<string, any> {
  const raw = typeof json === 'string' ? json.trim() : '';
  if (!raw) {
    return {};
  }
  const direct = parseObject(raw);
  if (direct) {
    return direct;
  }
  const repaired = parseObject(repairJson(raw));
  if (repaired) {
    return repaired;
  }
  const preview = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
  throw new Error(
    `Could not parse tool arguments as JSON: ${preview}. Re-emit the tool call with valid JSON.`,
  );
}

function parseObject(text: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return undefined;
  }
}

function stripFences(text: string): string {
  if (!text.startsWith('```')) {
    return text;
  }
  const firstLineEnd = text.indexOf('\n');
  let body =
    firstLineEnd === -1 ? text.replace(/^```[a-zA-Z]*\s*/, '') : text.slice(firstLineEnd + 1);
  const end = body.lastIndexOf('```');
  if (end !== -1) {
    body = body.slice(0, end);
  }
  return body.trim();
}

function removeTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) {
        next++;
      }
      if (text[next] === '}' || text[next] === ']') {
        continue;
      }
    }
    out += char;
  }
  return out;
}

function escapeNewlinesInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      out += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += char;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inString = false;
      out += char;
      continue;
    }
    if (char === '\n') {
      out += '\\n';
      continue;
    }
    if (char === '\r') {
      out += '\\r';
      continue;
    }
    out += char;
  }
  return out;
}

function closeOpenStructures(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      stack.push('}');
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '}' || char === ']') {
      stack.pop();
    }
  }
  let out = text;
  if (inString) {
    if (escaped) {
      out += '\\';
    }
    out += '"';
  }
  while (stack.length > 0) {
    out += stack.pop();
  }
  return out;
}
