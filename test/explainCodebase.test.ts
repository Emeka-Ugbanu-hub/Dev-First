import { describe, expect, it } from 'vitest';
import {
  EXPLAIN_CODEBASE_MAX_FILES,
  EXPLAIN_CODEBASE_SYSTEM,
  buildExplainCodebasePrompt,
} from '../src/scan/explainCodebase';

describe('buildExplainCodebasePrompt', () => {
  it('asks for the shortest complete explanation with evidence citations', () => {
    const prompt = buildExplainCodebasePrompt('how auth works', [
      { path: 'src/auth.ts', startLine: 10, content: 'const token = sign(user);\nreturn token;' },
    ]);
    expect(prompt.system).toContain('shortest complete explanation');
    expect(prompt.system).toContain('headings only when they make the answer easier to follow');
    expect(prompt.system).toContain('path:line');
    expect(prompt.system).not.toContain('## WHAT');
    expect(prompt.system).not.toContain('## HOW');
    expect(prompt.system).not.toContain('## WHY');
    expect(prompt.user).toContain('Question: how auth works');
    expect(prompt.user).toContain('### src/auth.ts');
    expect(prompt.user).toContain('10: const token = sign(user);');
    expect(prompt.user).toContain('11: return token;');
  });

  it('caps the number of files and trims the topic', () => {
    const files = Array.from({ length: 10 }, (_value, index) => ({
      path: `src/file${index}.ts`,
      startLine: 1,
      content: 'const value = 1;',
    }));
    const prompt = buildExplainCodebasePrompt('  explain  ', files);
    expect(prompt.user).toContain('Question: explain');
    const headers = prompt.user.match(/^### /gm) ?? [];
    expect(headers.length).toBe(EXPLAIN_CODEBASE_MAX_FILES);
  });

  it('keeps the evidence and no-invention contract on the system prompt', () => {
    expect(EXPLAIN_CODEBASE_SYSTEM).toContain('Every claim about code must cite a file:line');
    expect(EXPLAIN_CODEBASE_SYSTEM).toContain('Never invent files');
  });
});
