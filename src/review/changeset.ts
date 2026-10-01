export interface ReviewBlock {
  original: string;
  updated: string;
}

export interface ReviewFileDiff {
  path: string;
  additions: number;
  deletions: number;
  isNew?: boolean;
  isDeleted?: boolean;
  blocks: ReviewBlock[];
}

export const REVIEW_CHANGESET_CAP = 30_000;

export function serializeChangeset(files: ReviewFileDiff[], maxChars = REVIEW_CHANGESET_CAP): string {
  const sections: string[] = [];
  let used = 0;
  for (const file of files) {
    const flags = `${file.isNew ? ' [new]' : ''}${file.isDeleted ? ' [deleted]' : ''}`;
    const header = `### ${file.path} (+${file.additions} -${file.deletions})${flags}`;
    const body = file.blocks.map(renderBlock).join('\n');
    const separator = sections.length > 0 ? 2 : 0;
    const remaining = maxChars - used - separator;
    if (remaining <= header.length) {
      break;
    }
    const bodyBudget = remaining - header.length - 1;
    if (body.length > bodyBudget) {
      sections.push(`${header}\n${truncate(body, bodyBudget)}`);
      break;
    }
    sections.push(`${header}\n${body}`);
    used += separator + header.length + body.length + 1;
  }
  return sections.join('\n\n');
}

function renderBlock(block: ReviewBlock): string {
  const parts: string[] = [];
  if (block.original) {
    parts.push(`- removed:\n${indent(block.original)}`);
  }
  if (block.updated) {
    parts.push(`+ added:\n${indent(block.updated)}`);
  }
  return parts.join('\n') || '- (empty change)';
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function truncate(text: string, max: number): string {
  const suffix = '\n… [truncated]';
  if (text.length <= max) {
    return text;
  }
  if (max <= suffix.length) {
    return text.slice(0, Math.max(0, max));
  }
  return `${text.slice(0, max - suffix.length)}${suffix}`;
}
