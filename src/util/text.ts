export interface ReplaceResult {
  ok: boolean;
  content: string;
  count?: number;
  error?: string;
}

export function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

export function toLf(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function replaceInContent(content: string, oldText: string, newText: string, replaceAll: boolean): ReplaceResult {
  if (!oldText) {
    return { ok: false, content, error: 'old_text is empty.' };
  }
  const eol = detectEol(content);
  const haystack = toLf(content);
  const needle = toLf(oldText);
  const replacement = toLf(newText);

  const first = haystack.indexOf(needle);
  if (first === -1) {
    return {
      ok: false,
      content,
      error: 'old_text was not found in the file. Read the file and copy the exact text, including indentation.',
    };
  }

  if (!replaceAll) {
    const second = haystack.indexOf(needle, first + needle.length);
    if (second !== -1) {
      return {
        ok: false,
        content,
        error: 'old_text matches multiple locations. Include more surrounding context to make it unique, or set replace_all to true.',
      };
    }
    const updated = haystack.slice(0, first) + replacement + haystack.slice(first + needle.length);
    return { ok: true, content: restoreEol(updated, eol), count: 1 };
  }

  let count = 0;
  let position = 0;
  let updated = '';
  for (;;) {
    const index = haystack.indexOf(needle, position);
    if (index === -1) {
      break;
    }
    updated += haystack.slice(position, index) + replacement;
    position = index + needle.length;
    count++;
  }
  updated += haystack.slice(position);
  return { ok: true, content: restoreEol(updated, eol), count };
}

function restoreEol(content: string, eol: string): string {
  return eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
}

export function sanitizeSurrogates(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += '\uFFFD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += text[i];
    }
  }
  return out;
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const half = Math.floor((max - 20) / 2);
  return `${text.slice(0, half)}\n... [truncated] ...\n${text.slice(text.length - half)}`;
}
