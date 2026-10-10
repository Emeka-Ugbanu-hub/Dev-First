import type { RunRecord } from '../../../src/shared/protocol';
import { post } from '../vscode';

export function RecoveryCard({
  run,
  runDrift,
  processesAlive,
  onDismiss,
}: {
  run: RunRecord;
  runDrift?: boolean;
  processesAlive?: number[];
  onDismiss: () => void;
}) {
  const alive = new Set(processesAlive ?? []);
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
        {run.reasoning && (
          <>
            <span className="recovery-sep">·</span>
            <span>reasoning {run.reasoning}</span>
          </>
        )}
      </div>
      {runDrift && (
        <div className="recovery-drift">
          <span className="codicon codicon-warning" />
          <span>Workspace changed since the last step — Roll back if results look wrong.</span>
        </div>
      )}
      {run.pending && (
        <div className="recovery-pending">
          <div className="recovery-pending-prompt">Waiting on: {run.pending.prompt}</div>
          {run.pending.command && <code className="recovery-pending-command">{run.pending.command}</code>}
          {run.pending.cwd && <div className="recovery-pending-cwd">in {run.pending.cwd}</div>}
          <div className="recovery-pending-actions">
            <button
              className="btn-primary"
              onClick={() => post({ type: 'resolveRecoveredDecision', runId: run.id, approved: true })}
            >
              Approve
            </button>
            <button
              className="btn-secondary"
              onClick={() => post({ type: 'resolveRecoveredDecision', runId: run.id, approved: false })}
            >
              Deny
            </button>
          </div>
          <div className="recovery-pending-note">Re-validated before running.</div>
        </div>
      )}
      {run.processes && run.processes.length > 0 && (
        <div className="recovery-processes">
          <div className="recovery-section-title">External processes</div>
          {run.processes.map((entry) => (
            <div className="recovery-process" key={entry.id}>
              <span
                className={`recovery-process-dot ${alive.has(entry.pid) ? 'alive' : 'gone'}`}
                title={alive.has(entry.pid) ? 'Still running' : 'No longer running'}
                aria-label={alive.has(entry.pid) ? 'Still running' : 'No longer running'}
              />
              <span className="recovery-process-command" title={entry.command}>
                {entry.command} (pid {entry.pid})
              </span>
              <button
                className="btn-small secondary"
                onClick={() => post({ type: 'stopRunProcess', runId: run.id, pid: entry.pid })}
              >
                Stop
              </button>
              <button
                className="btn-small secondary"
                onClick={() => post({ type: 'forgetRunProcess', runId: run.id, pid: entry.pid })}
              >
                Forget
              </button>
            </div>
          ))}
        </div>
      )}
      {run.browser && (
        <div className="recovery-browser">
          <span className="codicon codicon-globe" />
          <span className="recovery-browser-text">
            Browser session on port {run.browser.port}
            {run.browser.url ? ` (${run.browser.url})` : ''}
          </span>
          <button className="btn-small secondary" onClick={() => post({ type: 'forgetBrowser', runId: run.id })}>
            Forget
          </button>
        </div>
      )}
      <div className="recovery-mcp-note">
        Any in-flight MCP requests are marked uncertain — re-run them manually.
      </div>
      <div className="recovery-actions">
        <button className="btn-primary" onClick={() => post({ type: 'resumeRun', id: run.id })}>
          Resume
        </button>
        {run.changedFiles && run.changedFiles.length > 0 && (
          <button className="btn-secondary" onClick={() => post({ type: 'openRunReview', runId: run.id })}>
            Review changes ({run.changedFiles.length})
          </button>
        )}
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
