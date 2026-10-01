import { ReviewFileDiff, serializeChangeset } from './changeset';

export const CROSS_FILE_MAX_FINDINGS = 15;
export const CROSS_FILE_NO_ISSUES = 'No cross-file issues found.';

export const CROSS_FILE_REVIEW_SYSTEM = `You review a changeset for cross-file issues only. Ignore anything contained within a single file.
Look for:
- inconsistent naming across files (functions, types, variables, files)
- duplicated logic that should be shared
- stale imports or references left behind by refactors
- API contract mismatches between caller and callee
- inconsistent error handling across the changeset

Output Markdown grouped by file:

### path/to/file.ts
- 🔴 critical finding
- 🟡 warning finding
- 🔵 minor finding

Rules:
- Each finding is one line and names the other file(s) involved when relevant.
- Severity: 🔴 breaks correctness, 🟡 likely bug or inconsistency, 🔵 minor consistency issue.
- At most ${CROSS_FILE_MAX_FINDINGS} findings total.
- If there are no cross-file issues, output exactly: ${CROSS_FILE_NO_ISSUES}
- No preamble, no summary, no praise.`;

export function buildCrossFileReviewPrompt(files: ReviewFileDiff[]): { system: string; user: string } {
  return {
    system: CROSS_FILE_REVIEW_SYSTEM,
    user: `Review this changeset for cross-file issues:\n\n${serializeChangeset(files)}`,
  };
}
