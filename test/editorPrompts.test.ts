import { describe, expect, it } from 'vitest';
import {
  commitMessagePrompt,
  contextPrompt,
  diagnosticFixPrompt,
  parseTerminalCommandResponse,
  selectionPrompt,
  terminalCommandPrompt,
  terminalExplainPrompt,
  terminalFixPrompt,
  terminalPrompt,
} from '../src/editor/prompts';

describe('selectionPrompt', () => {
  it('includes the reference, language, and code', () => {
    const prompt = selectionPrompt('explain', 'src/app.ts:3-8', 'typescript', 'const x = 1;');
    expect(prompt).toContain('Explain this code');
    expect(prompt).toContain('src/app.ts:3-8');
    expect(prompt).toContain('```typescript');
    expect(prompt).toContain('const x = 1;');
  });

  it('asks fix to confirm when the code looks correct', () => {
    expect(selectionPrompt('fix', 'a.ts:1', 'typescript', 'x')).toContain('If it looks correct');
  });

  it('asks improve to apply changes', () => {
    expect(selectionPrompt('improve', 'a.ts:1', 'typescript', 'x')).toContain('Apply the changes');
  });
});

describe('contextPrompt and terminalPrompt', () => {
  it('wraps context in a fenced block with the reference', () => {
    expect(contextPrompt('lib/utils.ts', 'go', 'func main() {}')).toBe(
      'Context from lib/utils.ts:\n\n```go\nfunc main() {}\n```',
    );
  });

  it('wraps terminal output in a plain fence', () => {
    expect(terminalPrompt('boom')).toBe('Terminal output:\n\n```\nboom\n```');
  });
});

describe('diagnosticFixPrompt', () => {
  it('lists diagnostics with severity and lines and includes the code', () => {
    const prompt = diagnosticFixPrompt('src/app.ts:4-6', 'typescript', 'const x: number = "a";', [
      { message: "Type 'string' is not assignable to type 'number'.", severity: 'error', startLine: 4, endLine: 4 },
      { message: 'Unused variable.', severity: 'warning', startLine: 5, endLine: 6 },
    ]);
    expect(prompt).toContain('src/app.ts:4-6');
    expect(prompt).toContain('[error] line 4:');
    expect(prompt).toContain("Type 'string' is not assignable to type 'number'.");
    expect(prompt).toContain('[warning] line 5-6: Unused variable.');
    expect(prompt).toContain('```typescript');
    expect(prompt).toContain('const x: number = "a";');
  });
});

describe('terminal prompt builders', () => {
  it('asks for a single command with an explanation', () => {
    const prompt = terminalCommandPrompt('list large files');
    expect(prompt).toContain('list large files');
    expect(prompt).toContain('COMMAND:');
    expect(prompt).toContain('EXPLANATION:');
  });

  it('wraps terminal output for explain and fix', () => {
    expect(terminalExplainPrompt('boom')).toContain('Explain this terminal output');
    expect(terminalFixPrompt('boom')).toContain('fix it');
    expect(terminalExplainPrompt('boom')).toContain('```\nboom\n```');
    expect(terminalFixPrompt('boom')).toContain('```\nboom\n```');
  });
});

describe('parseTerminalCommandResponse', () => {
  it('parses the COMMAND and EXPLANATION lines', () => {
    expect(parseTerminalCommandResponse('COMMAND: du -sh *\nEXPLANATION: Shows disk usage.')).toEqual({
      command: 'du -sh *',
      explanation: 'Shows disk usage.',
    });
  });

  it('strips backticks and falls back to the first line', () => {
    expect(parseTerminalCommandResponse('`ls -la`\nEXPLANATION: Lists files.')).toEqual({
      command: 'ls -la',
      explanation: 'Lists files.',
    });
    expect(parseTerminalCommandResponse('```sh\nls -la\n```')).toEqual({
      command: 'ls -la',
      explanation: '',
    });
  });

  it('returns empty values for an empty response', () => {
    expect(parseTerminalCommandResponse('')).toEqual({ command: '', explanation: '' });
  });
});

describe('commitMessagePrompt', () => {
  it('includes the staged diff and asks for a message only', () => {
    const prompt = commitMessagePrompt('diff --git a/a.ts b/a.ts');
    expect(prompt).toContain('diff --git a/a.ts b/a.ts');
    expect(prompt).toContain('commit message');
    expect(prompt).toContain('without code fences');
  });
});
