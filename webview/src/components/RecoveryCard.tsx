import { useState } from 'react';
import type { PendingDecisionRecord, QuestionItem, RunRecord } from '../../../src/shared/protocol';
import { post } from '../vscode';

function questionKey(pending: PendingDecisionRecord, item: QuestionItem | undefined, index: number): string {
  return item?.id ?? `${pending.requestId ?? pending.id}:${index}`;
}

function RecoveredQuestion({ pending, runId }: { pending: PendingDecisionRecord; runId?: string }) {
  const items = pending.questions && pending.questions.length > 0 ? pending.questions : undefined;
  const questions: QuestionItem[] = items ?? [
    {
      question: pending.prompt,
      options: pending.options ?? [],
      multiple: pending.multiple,
      custom: pending.allowCustom !== false,
    },
  ];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customActive, setCustomActive] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);

  const toggle = (key: string, label: string, multiple: boolean) => {
    if (submitted) {
      return;
    }
    setCustomActive((previous) => ({ ...previous, [key]: false }));
    setSelected((previous) => {
      const current = previous[key] ?? [];
      if (multiple) {
        return {
          ...previous,
          [key]: current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
        };
      }
      return { ...previous, [key]: current.includes(label) ? [] : [label] };
    });
  };

  const activateCustom = (key: string) => {
    if (submitted) {
      return;
    }
    setCustomActive((previous) => ({ ...previous, [key]: true }));
    setSelected((previous) => ({ ...previous, [key]: [] }));
  };

  const valueFor = (key: string) =>
    [...(selected[key] ?? []), customActive[key] ? (custom[key] ?? '').trim() : '']
      .filter(Boolean)
      .join(', ');

  const answers = questions.map((item, index) => {
    const key = questionKey(pending, items?.[index], index);
    return { key, value: valueFor(key) };
  });
  const complete = answers.every((entry) => entry.value.length > 0);

  const submit = () => {
    if (submitted || !complete) {
      return;
    }
    setSubmitted(true);
    post({
      type: 'answerRecoveredQuestion',
      ...(runId ? { runId } : {}),
      answers: answers.map((entry) => (items ? { questionId: entry.key, value: entry.value } : { value: entry.value })),
    });
  };

  const skip = () => {
    if (submitted) {
      return;
    }
    setSubmitted(true);
    post({ type: 'skipRecoveredQuestion', ...(runId ? { runId } : {}) });
  };

  return (
    <div className="recovery-pending recovery-question">
      {questions.map((item, index) => {
        const key = questionKey(pending, items?.[index], index);
        const allowCustom = item.custom !== false;
        return (
          <div className="recovery-question-item" key={key}>
            <div className="recovery-pending-prompt">{item.question}</div>
            {item.options.length > 0 && (
              <div className="question-options">
                {item.options.map((option) => (
                  <button
                    type="button"
                    key={option.label}
                    className={`question-option ${(selected[key] ?? []).includes(option.label) ? 'selected' : ''}`}
                    disabled={submitted}
                    onClick={() => toggle(key, option.label, Boolean(item.multiple))}
                  >
                    <span className="question-option-label">{option.label}</span>
                    {option.description && <span className="question-option-desc">{option.description}</span>}
                  </button>
                ))}
              </div>
            )}
            {allowCustom && (
              <input
                className="question-custom-input recovery-question-custom"
                placeholder={item.options.length > 0 ? 'Something else…' : 'Type your answer…'}
                value={custom[key] ?? ''}
                disabled={submitted}
                onFocus={() => activateCustom(key)}
                onChange={(event) => {
                  const value = event.target.value;
                  setCustomActive((previous) => ({ ...previous, [key]: true }));
                  setSelected((previous) => ({ ...previous, [key]: [] }));
                  setCustom((previous) => ({ ...previous, [key]: value }));
                }}
              />
            )}
          </div>
        );
      })}
      <div className="recovery-pending-actions">
        <button className="btn-primary" disabled={submitted || !complete} onClick={submit}>
          Submit
        </button>
        <button className="btn-secondary" disabled={submitted} onClick={skip}>
          Skip
        </button>
      </div>
      <div className="recovery-pending-note">Nothing runs until you answer.</div>
    </div>
  );
}

export function RecoveryCard({
  run,
  runDrift,
  processesAlive,
  pending,
  onDismiss,
}: {
  run?: RunRecord;
  runDrift?: boolean;
  processesAlive?: number[];
  pending?: PendingDecisionRecord;
  onDismiss: () => void;
}) {
  const alive = new Set(processesAlive ?? []);
  const decision = run?.pending ?? pending;
  if (!run && !decision) {
    return null;
  }
  return (
    <div className="recovery-card" role="alert">
      <div className="recovery-header">
        <span className="codicon codicon-warning" />
        <span className="recovery-title">{run ? 'Run interrupted' : 'Waiting for your answer'}</span>
        <span className="spacer" />
        <button className="recovery-dismiss" title="Dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <span className="codicon codicon-close" />
        </button>
      </div>
      {run && (
        <div className="recovery-request" title={run.request}>
          {run.request}
        </div>
      )}
      {run && (
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
      )}
      {run && runDrift && (
        <div className="recovery-drift">
          <span className="codicon codicon-warning" />
          <span>Workspace changed since the last step — Roll back if results look wrong.</span>
        </div>
      )}
      {run && decision?.kind === 'terminal' && (
        <div className="recovery-pending">
          <div className="recovery-pending-prompt">Waiting on: {decision.prompt}</div>
          {decision.command && <code className="recovery-pending-command">{decision.command}</code>}
          {decision.cwd && <div className="recovery-pending-cwd">in {decision.cwd}</div>}
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
      {run && decision?.kind === 'question' && !decision.requestId && (
        <div className="recovery-pending">
          <div className="recovery-pending-prompt">Waiting on: {decision.prompt}</div>
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
          <div className="recovery-pending-note">Resuming continues the run without repeating the question.</div>
        </div>
      )}
      {decision?.kind === 'question' && (!run || decision.requestId) && (
        <RecoveredQuestion pending={decision} runId={run?.id} />
      )}
      {run && run.processes && run.processes.length > 0 && (
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
      {run && run.browser && (
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
      {run && (
        <div className="recovery-mcp-note">
          Any in-flight MCP requests are marked uncertain — re-run them manually.
        </div>
      )}
      {run && (
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
      )}
      <div className="recovery-note">Nothing runs until you choose.</div>
    </div>
  );
}
