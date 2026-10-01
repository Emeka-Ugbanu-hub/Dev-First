import type { ChangeSummary } from '../../../src/shared/protocol';

export interface ChangeGroup {
  runId: string;
  label: string;
  changes: ChangeSummary[];
  isCurrent: boolean;
}

export function groupChanges(changes: ChangeSummary[], currentRunId?: string): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const change of changes) {
    const runId = change.runId ?? 'legacy';
    if (!groups.has(runId)) {
      groups.set(runId, {
        runId,
        label: change.runLabel || (runId === 'legacy' ? 'Earlier' : 'Task'),
        changes: [],
        isCurrent: runId === currentRunId,
      });
    }
    groups.get(runId)!.changes.push(change);
  }
  return [...groups.values()].sort((a, b) => (a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1));
}
