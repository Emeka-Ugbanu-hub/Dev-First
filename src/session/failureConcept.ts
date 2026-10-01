const FAILURE_CONCEPT_LINE = /^\s*(?:[-*•]\s*)?FAILURE_CONCEPT:\s*(.+?)\s*$/i;

export function extractFailureConcept(text: string): { text: string; failureConcept?: string } {
  const kept: string[] = [];
  let failureConcept: string | undefined;
  let matched = false;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const match = FAILURE_CONCEPT_LINE.exec(line);
    if (match) {
      matched = true;
      if (!failureConcept && match[1].trim()) {
        failureConcept = match[1].trim();
      }
      continue;
    }
    kept.push(line);
  }
  if (!matched) {
    return { text: text.trim() };
  }
  return { text: kept.join('\n').trim(), failureConcept };
}
