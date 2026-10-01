export interface ExpandedCommand {
  name: string;
  expanded: string;
}

export function builtinCommand(text: string): ExpandedCommand | undefined {
  const match = /^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const [, name, args] = match;
  if (name === 'review') {
    const scope = args.trim() || 'uncommitted';
    return {
      name,
      expanded: `Review the current code changes (scope: ${scope}).

1. Determine the right git command for the scope — uncommitted: \`git diff\`; staged: \`git diff --cached\`; branch: \`git diff <base>...HEAD\`; commit: \`git show <sha>\`. Use the terminal tool.
2. Gather the diff and read enough surrounding code to judge it properly.
3. Analyze for correctness, security, tests, and performance. Report findings grouped by file with severity (critical / major / minor) and a concrete suggested fix for each.
4. Do NOT modify any files. Finish with a short summary of overall quality.`,
    };
  }
  return undefined;
}
