import type { TerminalApprovalRequest } from '../../../src/shared/protocol';
import { post } from '../vscode';

export function TerminalApprovalCard({
  request,
  sandboxEnabled,
}: {
  request: TerminalApprovalRequest;
  sandboxEnabled: boolean;
}) {
  return (
    <div className="approval-card chat-attached-card">
      <div className="approval-title">
        <span className="approval-title-icon"><span className="codicon codicon-terminal" /></span>
        <span>Run this command?</span>
      </div>
      <div className="approval-command-wrap">
        <div className="approval-cwd">{request.cwd}</div>
        <pre className="approval-command">{request.command}</pre>
      </div>
      {sandboxEnabled && (
        <div className="approval-hint">
          Runs sandboxed — writes are limited to the workspace and common caches.
        </div>
      )}
      <div className="approval-actions">
        {sandboxEnabled && (
          <button
            className="approval-unsandboxed"
            title="Run this one command without the sandbox"
            onClick={() => post({ type: 'terminalApproval', id: request.id, decision: 'allow-unsandboxed' })}
          >Without sandbox</button>
        )}
        <button
          className="approval-skip"
          onClick={() => post({ type: 'terminalApproval', id: request.id, decision: 'deny' })}
        >Skip</button>
        <button
          className="approval-run"
          onClick={() => post({ type: 'terminalApproval', id: request.id, decision: 'allow' })}
        >
          Run <span aria-hidden="true">↵</span>
        </button>
      </div>
    </div>
  );
}
