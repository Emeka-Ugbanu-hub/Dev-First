export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSearchPattern(query: string, caseSensitive: boolean, useRegex: boolean): RegExp | undefined {
  if (!query) {
    return undefined;
  }
  try {
    return useRegex
      ? new RegExp(query, caseSensitive ? 'g' : 'gi')
      : new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
  } catch {
    return undefined;
  }
}

export interface SearchTarget {
  id: string;
  text: string;
}

export function collectSearchTexts(
  messages: Array<{ id: string; text?: string; reasoning?: string; activities?: Array<{ label: string }> }>,
): SearchTarget[] {
  const targets: SearchTarget[] = [];
  for (const message of messages) {
    const parts = [message.text ?? '', message.reasoning ?? '', ...(message.activities ?? []).map((a) => a.label)];
    const text = parts.filter(Boolean).join('\n');
    if (text) {
      targets.push({ id: message.id, text });
    }
  }
  return targets;
}
