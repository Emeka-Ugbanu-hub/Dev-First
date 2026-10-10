import type { RunReviewFile } from '../../../src/shared/protocol';
import { post } from '../vscode';

export function RunReviewCard({
  runId,
  files,
  conflicts = [],
}: {
  runId: string;
  files: RunReviewFile[];
  conflicts?: string[];
}) {
  if (files.length === 0) {
    return null;
  }
  return (
    <div className="run-review-card" role="region" aria-label="Run review">
      <div className="run-review-header">
        <span className="codicon codicon-diff" />
        <span className="run-review-title">Run changes</span>
        <span className="run-review-count">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        <button
          className="btn-small"
          title="Accept every file change from this run"
          onClick={() => post({ type: 'acceptRunReview', runId })}
        >
          Accept all
        </button>
      </div>
      <ul className="review-list">
        {files.map((file) => (
          <li key={file.path} className="review-item">
            <div className="review-row">
              <span className={`run-review-status run-review-${file.status}`}>{file.status}</span>
              <button
                className="review-file"
                title="Open the diff for this file"
                onClick={() => post({ type: 'openFileDiff', path: file.path, runId })}
              >
                <span className="codicon codicon-go-to-file" /> {file.path}
              </button>
              <button
                className="icon-btn"
                title={`Revert ${file.path}`}
                aria-label={`Revert ${file.path}`}
                onClick={() => post({ type: 'revertRunFile', path: file.path, runId })}
              >
                <span className="codicon codicon-discard" />
              </button>
            </div>
            {conflicts.includes(file.path) && (
              <div className="review-conflict">
                <span className="codicon codicon-warning" />
                <span>Couldn't revert — the file was edited since.</span>
                <button
                  className="btn-small secondary"
                  onClick={() => post({ type: 'revertRunFileForce', path: file.path, runId })}
                >
                  Restore anyway
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
