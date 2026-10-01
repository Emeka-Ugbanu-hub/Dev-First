import { ReviewFileDiff, serializeChangeset } from './changeset';

export const REVIEW_SUMMARY_SECTIONS = ['## Summary', '## Positive feedback', '## Recommendations', '## Scorecard'];

export const REVIEW_SCORECARD_ROWS = ['Naming', 'Error handling', 'Readability', 'Structure'];

export function formatScorecardTemplate(): string {
  const rows = REVIEW_SCORECARD_ROWS.map((row) => `| ${row} | ✅/⚠️/❌ | 0-10 |`).join('\n');
  return ['| Aspect | Rating | Score |', '| --- | --- | --- |', rows, '', '**Score: N/10**'].join('\n');
}

export const REVIEW_SUMMARY_SYSTEM = `You are a strict senior code reviewer reviewing a pending diff.
Output Markdown with exactly these sections in order:

## Summary
One or two sentences describing what the changes do.

## Positive feedback
Short bullets on what is genuinely good. Omit the bullets if there is nothing real to praise.

## Recommendations
Short bullets, each specific and actionable. Omit if there is nothing to fix.

## Scorecard
${formatScorecardTemplate()}

Rules:
- No fluff, no praise padding, no restating the diff.
- Maximum 250 words total.
- Rating: ✅ good, ⚠️ needs work, ❌ poor.
- Overall score is the rounded average of the four row scores.`;

export function buildReviewSummaryPrompt(files: ReviewFileDiff[]): { system: string; user: string } {
  return {
    system: REVIEW_SUMMARY_SYSTEM,
    user: `Review these pending changes:\n\n${serializeChangeset(files)}`,
  };
}
