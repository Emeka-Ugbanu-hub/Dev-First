import { useState } from 'react';
import type { ChangeSummary } from '../../../src/shared/protocol';
import { post } from '../vscode';
import { groupChanges } from '../lib/changeGroups';

export function DiffReviewBar({
  changes,
  currentRunId,
  conflicts,
}: {
  changes: ChangeSummary[];
  currentRunId?: string;
  conflicts: string[];
}) {
  const [expanded, setExpanded] = useState(true);
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const groups = groupChanges(changes, currentRunId);
  const totalAdditions = changes.reduce((sum, change) => sum + change.additions, 0);
  const totalDeletions = changes.reduce((sum, change) => sum + change.deletions, 0);

  return (
    <div className="review-bar">
      <div className="review-summary">
        <button className="review-toggle" onClick={() => setExpanded((value) => !value)}>
          <span className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} />
          {changes.length} pending change{changes.length === 1 ? '' : 's'}
        </button>
        <span className="diff-stat">
          <span className="add">+{totalAdditions}</span> <span className="del">-{totalDeletions}</span>
        </span>
        <span className="spacer" />
        <button
          className="btn-small secondary"
          title="Open the full multi-file diff"
          onClick={() => post({ type: 'reviewChanges' })}
        >
          <span className="codicon codicon-diff" /> Diff view
        </button>
        <button
          className="btn-small secondary"
          title="Summarize the pending changes with a scorecard"
          onClick={() => post({ type: 'summarizeReview' })}
        >
          <span className="codicon codicon-checklist" /> Summarize review
        </button>
        <button
          className="btn-small secondary"
          title="Look for issues that span multiple files"
          onClick={() => post({ type: 'reviewAcrossFiles' })}
        >
          <span className="codicon codicon-references" /> Review across files
        </button>
        <button className="btn-small" onClick={() => post({ type: 'acceptAll' })}>
          Accept everything
        </button>
        <button className="btn-small secondary" onClick={() => post({ type: 'rejectAll' })}>
          Reject everything
        </button>
      </div>

      {expanded &&
        groups.map((group) => (
          <div className="review-group" key={group.runId}>
            <div className="review-group-header">
              <span className="review-group-label">{group.isCurrent ? 'THIS TASK' : group.label.toUpperCase()}</span>
              <span className="review-group-count">
                {group.changes.length} file{group.changes.length === 1 ? '' : 's'}
              </span>
              <span className="spacer" />
              <button
                className="btn-small"
                title="Accept every change from this task"
                onClick={() => post({ type: 'acceptRun', runId: group.runId })}
              >
                Accept all
              </button>
              <button
                className="btn-small secondary"
                title="Reject every change from this task"
                onClick={() => post({ type: 'rejectRun', runId: group.runId })}
              >
                Reject all
              </button>
            </div>

            <ul className="review-list">
              {group.changes.map((change) => (
                <li key={change.path} className="review-item">
                  <div className="review-row">
                    <button
                      className="review-file"
                      title="Open the file with this change selected — edit it, then accept or reject"
                      onClick={() => post({ type: 'openChange', path: change.path })}
                    >
                      <span className="codicon codicon-go-to-file" /> {change.path}
                    </button>
                    <span className="diff-stat">
                      {change.isDeleted ? (
                        <span className="del">deleted</span>
                      ) : (
                        <>
                          <span className="add">+{change.additions}</span>{' '}
                          <span className="del">-{change.deletions}</span>
                        </>
                      )}
                    </span>
                    {change.hunks && change.hunks.length > 0 && (
                      <button
                        className="icon-btn"
                        title="Show individual changes"
                        onClick={() =>
                          setOpenFiles((previous) => ({ ...previous, [change.path]: !previous[change.path] }))
                        }
                      >
                        <span
                          className={`codicon codicon-chevron-${openFiles[change.path] ? 'down' : 'right'}`}
                        />
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      title="Explain this change"
                      onClick={() => post({ type: 'explainChange', path: change.path })}
                    >
                      <span className="codicon codicon-book" />
                    </button>
                    <button
                      className="icon-btn"
                      title="Accept"
                      onClick={() => post({ type: 'acceptChange', path: change.path })}
                    >
                      <span className="codicon codicon-check" />
                    </button>
                    <button
                      className="icon-btn"
                      title="Reject"
                      onClick={() => post({ type: 'rejectChange', path: change.path })}
                    >
                      <span className="codicon codicon-close" />
                    </button>
                  </div>

                  {change.summary && <div className="review-summary-line">{change.summary}</div>}

                  {conflicts.includes(change.path) && (
                    <div className="review-conflict">
                      <span className="codicon codicon-warning" />
                      <span>Couldn't revert — the file was edited since.</span>
                      <button
                        className="btn-small secondary"
                        onClick={() =>
                          post({ type: 'resolveRejectConflict', path: change.path, action: 'revert-file' })
                        }
                      >
                        Revert whole file
                      </button>
                      <button
                        className="btn-small secondary"
                        onClick={() => post({ type: 'resolveRejectConflict', path: change.path, action: 'keep' })}
                      >
                        Keep
                      </button>
                    </div>
                  )}

                  {openFiles[change.path] && change.hunks && (
                    <ul className="hunk-list">
                      {change.hunks.map((hunk) => (
                        <li key={hunk.id}>
                          <button
                            className="hunk-item"
                            title="Open this change in the editor"
                            onClick={() => post({ type: 'openChange', path: change.path, changeId: hunk.id })}
                          >
                            <span className={`hunk-type hunk-${hunk.type}`}>{hunk.type}</span> line {hunk.startLine + 1}
                            {hunk.endLine > hunk.startLine ? `–${hunk.endLine + 1}` : ''}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}
