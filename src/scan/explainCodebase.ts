import type { AiPrompt } from './aiScanner';

export const EXPLAIN_CODEBASE_MAX_FILES = 6;
export const EXPLAIN_CODEBASE_MAX_LINES = 160;
export const EXPLAIN_CODEBASE_MAX_CHARS = 48000;

export interface ExplainCodebaseFile {
  path: string;
  startLine: number;
  content: string;
}

export const EXPLAIN_CODEBASE_SYSTEM = [
  'You are Dev-First explaining how a codebase works, project-wide.',
  '',
  'Give the shortest complete explanation that answers the question, at whatever depth fits. Use Markdown headings only when they make the answer easier to follow.',
  '',
  'Rules:',
  '- Cite evidence as path:line (line numbers are shown next to the code). Every claim about code must cite a file:line from the code shown.',
  '- Never invent files, functions, or behavior that is not shown.',
  '- Be concrete and tight. No filler, no restating the question.',
].join('\n');

export function buildExplainCodebasePrompt(
  topic: string,
  files: ExplainCodebaseFile[],
): AiPrompt {
  const blocks: string[] = [];
  let budget = EXPLAIN_CODEBASE_MAX_CHARS;
  for (const file of files.slice(0, EXPLAIN_CODEBASE_MAX_FILES)) {
    if (budget <= 0) {
      break;
    }
    const lines = file.content.split('\n').slice(0, EXPLAIN_CODEBASE_MAX_LINES);
    const numbered: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const entry = `${file.startLine + index}: ${lines[index]}`;
      if (entry.length > budget) {
        break;
      }
      budget -= entry.length + 1;
      numbered.push(entry);
    }
    if (numbered.length > 0) {
      blocks.push(`### ${file.path}\n${numbered.join('\n')}`);
    }
  }
  return {
    system: EXPLAIN_CODEBASE_SYSTEM,
    user: [`Question: ${topic.trim()}`, '', 'Relevant code (line numbers are 1-based):', ...blocks].join('\n'),
  };
}
