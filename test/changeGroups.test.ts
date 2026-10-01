import { describe, expect, it } from 'vitest';
import { groupChanges } from '../webview/src/lib/changeGroups';
import { ChangeSummary } from '../src/shared/protocol';

function change(path: string, runId?: string, runLabel?: string): ChangeSummary {
  return { path, additions: 1, deletions: 0, isNew: false, isDeleted: false, runId, runLabel };
}

describe('groupChanges', () => {
  it('puts the current run first', () => {
    const groups = groupChanges([change('a.ts', 'old'), change('b.ts', 'current')], 'current');
    expect(groups).toHaveLength(2);
    expect(groups[0].runId).toBe('current');
    expect(groups[0].isCurrent).toBe(true);
    expect(groups[1].runId).toBe('old');
    expect(groups[1].isCurrent).toBe(false);
  });

  it('keeps files from the same run together', () => {
    const groups = groupChanges(
      [change('a.ts', 'r1', 'add login'), change('b.ts', 'r1', 'add login'), change('c.ts', 'r2')],
      'r2',
    );
    expect(groups[0].runId).toBe('r2');
    expect(groups[1].changes.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts']);
    expect(groups[1].label).toBe('add login');
  });

  it('labels changes without a run as Earlier', () => {
    const groups = groupChanges([change('a.ts')], undefined);
    expect(groups[0].runId).toBe('legacy');
    expect(groups[0].label).toBe('Earlier');
    expect(groups[0].isCurrent).toBe(false);
  });

  it('handles an empty list', () => {
    expect(groupChanges([], 'x')).toEqual([]);
  });
});
