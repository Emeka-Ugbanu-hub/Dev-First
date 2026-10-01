export function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([\w./-]*)$/.exec(text);
  return match ? match[1] : null;
}

export function filterMentions(files: string[], query: string, limit = 8): string[] {
  const normalized = query.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    if (normalized && !lower.includes(normalized)) {
      continue;
    }
    const base = lower.split('/').pop() ?? lower;
    let score = 0;
    if (!normalized) {
      score = 1;
    } else if (base.startsWith(normalized)) {
      score = 100 - base.length;
    } else if (base.includes(normalized)) {
      score = 50 - base.length;
    } else {
      score = 10 - lower.length / 10;
    }
    scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((entry) => entry.file);
}
