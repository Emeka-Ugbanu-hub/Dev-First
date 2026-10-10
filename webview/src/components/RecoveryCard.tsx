import type { RunRecord } from '../../../src/shared/protocol';
import { post } from '../vscode';

export function RecoveryCard({ run, onDismiss }: { run: RunRecord; onDismiss: () => void }) {
  return (
    <div className="recovery-card" role="alert">
      <div className="recovery-header">
        <span className="codicon codicon-warning" />
        <span className="recovery-title">Run interrupted</span>
        <span className="spacer" />
        <button className="recovery-dismiss" title="Dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <span className="codicon codicon-close" />
        </button>
      </div>
      <div className="recovery-request" title={run.request}>
        {run.request}
      </div>
      <div className="recovery-meta">
        <span>Plan v{run.planVersion}</span>
        <span className="recovery-sep">·</span>
        <span>step {run.stepIndex + 1}</span>
        {run.completedSteps.length > 0 && (
          <>
            <span className="recovery-sep">·</span>
            <span>{run.completedSteps.length} completed</span>
          </>
        )}
        <span className="recovery-sep">·</span>
        <span className="recovery-model">{run.model}</span>
      </div>
      {run.pending && (
        <div className="recovery-pending">
          Waiting on: {run.pending.prompt}
          <span className="recovery-pending-note"> (re-approval will be requested when you resume)</span>
        </div>
      )}
      <div className="recovery-actions">
        <button className="btn-primary" onClick={() => post({ type: 'resumeRun', id: run.id })}>
          Resume
        </button>
        {run.checkpointId && (
          <button className="btn-secondary" onClick={() => post({ type: 'rollbackRun', id: run.id })}>
            Roll back
          </button>
        )}
        <button className="btn-secondary" onClick={() => post({ type: 'discardRun', id: run.id })}>
          Discard
        </button>
      </div>
      <div className="recovery-note">Nothing runs until you choose.</div>
    </div>
  );
}
