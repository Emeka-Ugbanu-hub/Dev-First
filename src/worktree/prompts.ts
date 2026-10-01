export function worktreeMergeConflictPrompt(branch: string, base: string, conflicts: string[]): string {
  const files = conflicts.map((file) => `- ${file}`).join('\n');
  return `Merging ${branch} into ${base} produced conflicts. Resolve them in place and finish the merge (do not abort):\n\nConflicted files:\n${files}`;
}
