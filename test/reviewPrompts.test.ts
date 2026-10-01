import { describe, expect, it } from 'vitest';
import { REVIEW_CHANGESET_CAP, ReviewFileDiff, serializeChangeset } from '../src/review/changeset';
import {
  REVIEW_SCORECARD_ROWS,
  REVIEW_SUMMARY_SECTIONS,
  REVIEW_SUMMARY_SYSTEM,
  buildReviewSummaryPrompt,
  formatScorecardTemplate,
} from '../src/review/summary';
import {
  CROSS_FILE_MAX_FINDINGS,
  CROSS_FILE_NO_ISSUES,
  buildCrossFileReviewPrompt,
} from '../src/review/crossFile';

function sampleFiles(): ReviewFileDiff[] {
  return [
    {
      path: 'src/a.ts',
      additions: 2,
      deletions: 1,
      blocks: [{ original: 'const a = 1;', updated: 'const a = 2;\nconst b = 3;' }],
    },
    {
      path: 'src/b.ts',
      additions: 1,
      deletions: 0,
      isNew: true,
      blocks: [{ original: '', updated: 'export const b = a;' }],
    },
  ];
}

describe('serializeChangeset', () => {
  it('renders file headers, stats and blocks', () => {
    const text = serializeChangeset(sampleFiles());
    expect(text).toContain('### src/a.ts (+2 -1)');
    expect(text).toContain('### src/b.ts (+1 -0) [new]');
    expect(text).toContain('- removed:');
    expect(text).toContain('+ added:');
    expect(text).toContain('const a = 2;');
  });

  it('stays within the character cap and marks truncation', () => {
    const files: ReviewFileDiff[] = [
      {
        path: 'src/big.ts',
        additions: 1,
        deletions: 0,
        blocks: [{ original: '', updated: 'x'.repeat(4000) }],
      },
      { path: 'src/late.ts', additions: 1, deletions: 0, blocks: [{ original: '', updated: 'late' }] },
    ];
    const text = serializeChangeset(files, 500);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toContain('[truncated]');
    expect(text).not.toContain('src/late.ts');
  });

  it('respects the default cap', () => {
    const files: ReviewFileDiff[] = [
      {
        path: 'src/huge.ts',
        additions: 1,
        deletions: 0,
        blocks: [{ original: '', updated: 'x'.repeat(REVIEW_CHANGESET_CAP * 2) }],
      },
    ];
    expect(serializeChangeset(files).length).toBeLessThanOrEqual(REVIEW_CHANGESET_CAP);
  });

  it('returns an empty string for no files', () => {
    expect(serializeChangeset([])).toBe('');
  });
});

describe('review summary prompt', () => {
  it('requires every section and scorecard row', () => {
    const template = formatScorecardTemplate();
    for (const section of REVIEW_SUMMARY_SECTIONS) {
      expect(REVIEW_SUMMARY_SYSTEM).toContain(section);
    }
    for (const row of REVIEW_SCORECARD_ROWS) {
      expect(template).toContain(`| ${row} |`);
    }
    expect(template).toContain('| Aspect | Rating | Score |');
    expect(template).toContain('**Score: N/10**');
  });

  it('embeds the changeset in the user message', () => {
    const prompt = buildReviewSummaryPrompt(sampleFiles());
    expect(prompt.system).toContain('Maximum 250 words');
    expect(prompt.user).toContain('### src/a.ts');
    expect(prompt.user).toContain('export const b = a;');
  });
});

describe('cross-file review prompt', () => {
  it('targets cross-file categories, severity and the finding cap', () => {
    const prompt = buildCrossFileReviewPrompt(sampleFiles());
    expect(prompt.system).toContain('cross-file');
    expect(prompt.system).toContain('stale imports');
    expect(prompt.system).toContain('API contract mismatches');
    expect(prompt.system).toContain('🔴');
    expect(prompt.system).toContain('🟡');
    expect(prompt.system).toContain('🔵');
    expect(prompt.system).toContain(`At most ${CROSS_FILE_MAX_FINDINGS} findings`);
    expect(prompt.system).toContain(CROSS_FILE_NO_ISSUES);
    expect(prompt.user).toContain('### src/b.ts');
  });
});
