const TAKEAWAY_LINE = /^\s*(?:[-*•]\s*)?TAKEAWAYS:\s*(.+?)\s*$/i;

export function extractTakeaways(text: string, max = 3): { text: string; takeaways?: string[] } {
  const takeaways: string[] = [];
  const kept: string[] = [];
  let matched = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = TAKEAWAY_LINE.exec(line);
    if (match) {
      matched = true;
      if (takeaways.length < max && match[1].trim()) {
        takeaways.push(match[1].trim());
      }
      continue;
    }
    kept.push(line);
  }
  if (!matched) {
    return { text: text.trim() };
  }
  return {
    text: kept.join('\n').trim(),
    takeaways: takeaways.length > 0 ? takeaways : undefined,
  };
}
