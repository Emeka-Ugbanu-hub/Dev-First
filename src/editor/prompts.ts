export type SelectionAction = 'explain' | 'fix' | 'improve';

export function selectionPrompt(action: SelectionAction, ref: string, language: string, code: string): string {
  const body = `${ref}\n\`\`\`${language}\n${code}\n\`\`\``;
  if (action === 'explain') {
    return `Explain this code — how it works and anything subtle:\n\n${body}`;
  }
  if (action === 'fix') {
    return `Fix any bugs or problems in this code. If it looks correct, say so and explain why:\n\n${body}`;
  }
  return `Improve this code — readability, correctness, and performance where it matters. Apply the changes:\n\n${body}`;
}

export function contextPrompt(ref: string, language: string, code: string): string {
  return `Context from ${ref}:\n\n\`\`\`${language}\n${code}\n\`\`\``;
}

export function terminalPrompt(output: string): string {
  return `Terminal output:\n\n\`\`\`\n${output}\n\`\`\``;
}

export function terminalExplainPrompt(output: string): string {
  return `Explain this terminal output — what happened and what to do next:\n\n\`\`\`\n${output}\n\`\`\``;
}

export function terminalFixPrompt(output: string): string {
  return `This terminal output shows a problem. Find the cause and fix it, then verify the fix:\n\n\`\`\`\n${output}\n\`\`\``;
}

export function terminalCommandPrompt(request: string): string {
  return `You are a shell expert. The user wants: ${request}\n\nReply with exactly two lines:\nCOMMAND: <one shell command, no backticks>\nEXPLANATION: <one short line explaining it>`;
}

export function parseTerminalCommandResponse(response: string): { command: string; explanation: string } {
  const commandMatch = response.match(/COMMAND:\s*(.+)/i);
  const explanationMatch = response.match(/EXPLANATION:\s*(.+)/i);
  const fallback = response
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('```') && !/^(?:COMMAND|EXPLANATION):/i.test(line));
  const command = (commandMatch?.[1] ?? fallback ?? '').trim().replace(/^`+|`+$/g, '');
  return { command, explanation: (explanationMatch?.[1] ?? '').trim() };
}

export function commitMessagePrompt(diff: string): string {
  return `Write a git commit message for the staged diff below. Use the imperative mood, keep the subject under 72 characters, and add a short body only if it helps. Reply with the commit message only, without code fences:\n\n${diff}`;
}

export interface DiagnosticInfo {
  message: string;
  severity: string;
  startLine: number;
  endLine: number;
}

export function diagnosticFixPrompt(
  ref: string,
  language: string,
  code: string,
  diagnostics: DiagnosticInfo[],
): string {
  const list = diagnostics
    .map(
      (diagnostic) =>
        `- [${diagnostic.severity}] line ${diagnostic.startLine}${
          diagnostic.endLine !== diagnostic.startLine ? `-${diagnostic.endLine}` : ''
        }: ${diagnostic.message}`,
    )
    .join('\n');
  return `Fix the diagnostics reported for ${ref} and apply the changes.\n\nDiagnostics:\n${list}\n\n\`\`\`${language}\n${code}\n\`\`\``;
}
