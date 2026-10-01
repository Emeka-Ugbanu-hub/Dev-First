import { memo, useEffect, useState } from 'react';
import type { ToolActivity, UiMessage } from '../../../src/shared/protocol';
import { Markdown, InlineMarkdown } from '../lib/markdown';
import { post } from '../vscode';
import { ThinkingRow } from './ThinkingRow';
import { Collapsible } from './Collapsible';
import { formatTokens } from '../lib/usage';

function MessageBubbleComponent({
  message,
  mcpDisplay,
  viewableRuns,
}: {
  message: UiMessage;
  mcpDisplay: 'plain' | 'markdown';
  viewableRuns?: string[];
}) {
  if (message.role === 'notice' && message.kind === 'error') {
    return (
      <div className="error-row">
        <span className="codicon codicon-warning" />
        <div className="error-body">
          <span className="error-text">{message.text}</span>
          {message.failureConcept && <div className="error-concept">Concept: {message.failureConcept}</div>}
        </div>
      </div>
    );
  }

  if (message.role === 'notice') {
    return (
      <div className="notice-row">
        <span className="notice-text">{message.text}</span>
        {message.action === 'openSettings' && (
          <button
            className="btn-secondary notice-action"
            onClick={() => post({ type: 'openSettings' })}
          >
            <span className="codicon codicon-settings-gear" /> Open Settings
          </button>
        )}
      </div>
    );
  }

  if (message.kind === 'compaction' && message.compaction) {
    const info = message.compaction;
    return (
      <div className="compaction-row">
        <span className="compaction-line" />
        <span className="compaction-label">
          <span className="codicon codicon-fold" /> Context compacted · {formatTokens(info.tokensBefore)} →{' '}
          {formatTokens(info.tokensAfter)} tokens · {info.messagesBefore} → {info.messagesAfter} messages
        </span>
        <span className="compaction-line" />
      </div>
    );
  }

  if (message.kind === 'completion') {
    return (
      <div className="completion-card anim-fade-slide">
        <div className="completion-title">
          <span className="codicon codicon-check" /> Done — walkthrough
        </div>
        <div className="completion-text">
          <Markdown text={message.text} />
        </div>
        {message.takeaways && message.takeaways.length > 0 && (
          <div className="completion-takeaways">
            <div className="completion-takeaways-title">
              <span className="codicon codicon-mortar-board" /> What you should take away
            </div>
            <ul className="completion-takeaways-list">
              {message.takeaways.map((takeaway, index) => (
                <li key={index}>{takeaway}</li>
              ))}
            </ul>
          </div>
        )}
        {message.failureConcept && (
          <div className="completion-concept">
            <span className="codicon codicon-bug" /> Concept: {message.failureConcept}
          </div>
        )}
        {message.planSnapshot && <CompletionPlan snapshot={message.planSnapshot} />}
        {message.changedFiles &&
          message.changedFiles.length > 0 &&
          message.runId &&
          (viewableRuns ?? []).includes(message.runId) && (
            <CompletionFiles files={message.changedFiles} runId={message.runId} />
          )}
        <div className="completion-actions">
          <button
            className="btn-secondary"
            onClick={() => window.dispatchEvent(new Event('df-learn-more'))}
          >
            <span className="codicon codicon-book" /> Learn more
          </button>
          {message.checkpointId && (
            <button
              className="btn-secondary"
              title="Restore the workspace to before this run"
              onClick={() => post({ type: 'revertToCheckpoint', checkpointId: message.checkpointId! })}
            >
              <span className="codicon codicon-history" /> Revert
            </button>
          )}
        </div>
      </div>
    );
  }

  if (message.role === 'user') {
    return <UserMessage message={message} />;
  }

  return (
    <div className="message-row assistant">
      <div className="bubble assistant-bubble">
        {message.reasoning && <ThinkingRow text={message.reasoning} streaming={Boolean(message.streaming)} />}
        {message.text && <Markdown text={message.text} streaming={Boolean(message.streaming)} />}
        {message.streaming && <span className="cursor-blink" />}
        {message.activities && message.activities.length > 0 && (
          <ActivityGroup activities={message.activities} mcpDisplay={mcpDisplay} />
        )}
        {message.text && !message.streaming && (
          <button
            className="msg-copy"
            title="Copy message"
            aria-label="Copy message"
            onClick={() => {
              void navigator.clipboard.writeText(message.text);
            }}
          >
            <span className="codicon codicon-copy" />
          </button>
        )}
      </div>
    </div>
  );
}

function CompletionPlan({ snapshot }: { snapshot: NonNullable<UiMessage['planSnapshot']> }) {
  const [open, setOpen] = useState(false);
  const steps = snapshot.steps ?? [];
  return (
    <div className="completion-plan">
      <button className="completion-plan-header" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`codicon completion-plan-chevron codicon-chevron-${open ? 'down' : 'right'}`} />
        <span className="codicon codicon-checklist" />
        <span className="completion-plan-title">{snapshot.title}</span>
        <span className="spacer" />
        {steps.length > 0 && (
          <span className="completion-plan-count">
            {steps.length} step{steps.length === 1 ? '' : 's'}
          </span>
        )}
      </button>
      <Collapsible open={open && steps.length > 0}>
        <ol className="completion-plan-steps">
          {steps.map((step, index) => (
            <li key={index}>
              <span className="codicon codicon-check" />
              <span className="completion-plan-step-text">
                <InlineMarkdown text={step} />
              </span>
            </li>
          ))}
        </ol>
      </Collapsible>
    </div>
  );
}

function CompletionFiles({
  files,
  runId,
}: {
  files: NonNullable<UiMessage['changedFiles']>;
  runId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="completion-files">
      <button className="completion-files-header" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`codicon completion-files-chevron codicon-chevron-${open ? 'down' : 'right'}`} />
        <span className="codicon codicon-files" />
        <span className="completion-files-title">Changed files ({files.length})</span>
      </button>
      <Collapsible open={open}>
        <ul className="completion-files-list">
          {files.map((file) => (
            <li key={file.path}>
              <button
                className="completion-file-row"
                title={`Open diff for ${file.path}`}
                onClick={() => post({ type: 'openFileDiff', path: file.path, runId })}
              >
                <span className="codicon codicon-file" />
                <span className="completion-file-name">{file.path}</span>
                <span className={`completion-file-status status-${file.status}`}>{file.status}</span>
                <span className="diff-stat">
                  <span className="add">+{file.additions}</span> <span className="del">-{file.deletions}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Collapsible>
    </div>
  );
}

function UserMessage({ message }: { message: UiMessage }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!preview) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreview(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  return (
    <div className="message-row user">
      <div className="user-stack">
        {message.quote && (
          <div className="quote-chip" title={message.quote}>
            <span className="codicon codicon-quote" />
            <span className="quote-text">{message.quote.slice(0, 160)}</span>
          </div>
        )}
        {message.attachment && (
          <div className="attachment-chip" title="Code selection attached to this message">
            <span className="codicon codicon-selection" />
            {message.attachment.path}:{message.attachment.startLine}–{message.attachment.endLine}
          </div>
        )}
        {message.images && message.images.length > 0 && (
          <div className="image-strip message-images">
            {message.images.map((image, index) => (
              <button className="image-thumb" key={index} title="Open preview" onClick={() => setPreview(image)}>
                <img src={image} alt={`attachment ${index + 1}`} />
              </button>
            ))}
          </div>
        )}

        {editing ? (
          <div className="edit-box">
            <textarea
              className="edit-textarea"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            />
            <div className="edit-actions">
              <button
                className="btn-secondary"
                disabled={!draft.trim()}
                title="Rewind the conversation to this point and send the edited message"
                onClick={() => post({ type: 'editMessage', id: message.id, text: draft, restoreWorkspace: false })}
              >
                <span className="codicon codicon-history" /> Save & rewind
              </button>
              {message.checkpointId && (
                <button
                  className="btn-secondary"
                  title="Rewind and restore the workspace to before this request"
                  onClick={() => post({ type: 'editMessage', id: message.id, text: draft, restoreWorkspace: true })}
                >
                  <span className="codicon codicon-repo-push" /> Save & restore code
                </button>
              )}
              <button className="btn-secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="bubble user-bubble">{message.text}</div>
        )}

        {message.queued && (
          <div className="queued-badge">
            <span className="codicon codicon-clock" /> queued
            <button
              onClick={() => post({ type: 'cancelQueued', id: message.id })}
              title="Cancel queued message"
              aria-label="Cancel queued message"
            >
              <span className="codicon codicon-close" />
            </button>
          </div>
        )}

        {preview && (
          <div className="lightbox" onClick={() => setPreview(null)} title="Click or press Esc to close">
            <img src={preview} alt="preview" />
          </div>
        )}

        {!editing && !message.queued && (
          <div className="user-actions">
            <button
              className="revert-btn"
              title="Edit this message and rewind the conversation"
              onClick={() => {
                setDraft(message.text);
                setEditing(true);
              }}
            >
              <span className="codicon codicon-edit" /> edit
            </button>
            {message.checkpointId && (
              <button
                className="revert-btn"
                title="Restore the workspace to how it was before this request"
                onClick={() => post({ type: 'revertToCheckpoint', checkpointId: message.checkpointId! })}
              >
                <span className="codicon codicon-history" /> revert
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityGroup({
  activities,
  mcpDisplay,
}: {
  activities: ToolActivity[];
  mcpDisplay: 'plain' | 'markdown';
}) {
  const [open, setOpen] = useState(false);
  let running: ToolActivity | undefined;
  for (const activity of activities) {
    if (activity.status === 'running') {
      running = activity;
    }
  }
  const summary = running
    ? `${running.label}${running.label.endsWith('…') ? '' : '…'}`
    : `${activities.length} action${activities.length === 1 ? '' : 's'}`;
  return (
    <div className="activity-group">
      <button
        className="activity-group-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`codicon activity-group-chevron codicon-chevron-${open ? 'down' : 'right'}`} />
        <span className="activity-group-label">{summary}</span>
      </button>
      <Collapsible open={open}>
        <div className="activity-list">
          {activities.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} mcpDisplay={mcpDisplay} />
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

function ActivityRow({
  activity,
  mcpDisplay,
}: {
  activity: ToolActivity;
  mcpDisplay: 'plain' | 'markdown';
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(activity.detail);
  const opensFile = Boolean(activity.filePath);
  const canExpand = hasDetail && !opensFile;
  const richMcp = mcpDisplay === 'markdown' && activity.icon === 'plug' && activity.detailKind === 'text';
  return (
    <div className={`activity activity-${activity.status} ${canExpand ? 'expandable' : ''} ${opensFile ? 'activity-open-file' : ''}`}>
      <button
        className="activity-main"
        aria-expanded={canExpand ? open : undefined}
        onClick={() => {
          if (activity.filePath) {
            post({ type: 'openFile', path: activity.filePath });
          } else if (canExpand) {
            setOpen((value) => !value);
          }
        }}
        title={opensFile ? 'Open file in editor' : canExpand ? (open ? 'Hide output' : 'Show output') : undefined}
      >
        {opensFile ? (
          <span className="codicon activity-chevron codicon-chevron-right" aria-hidden="true" />
        ) : canExpand ? (
          <span className={`codicon activity-chevron codicon-chevron-${open ? 'down' : 'right'}`} />
        ) : null}
        <span className={`activity-icon codicon codicon-${activity.icon ?? 'tools'}`} />
        <span className="activity-label">{activity.label}</span>
        {activity.detailKind === 'terminal' && activity.exitCode !== undefined && (
          <span className={`exit-badge ${activity.exitCode === 0 ? 'ok' : 'fail'}`}>exit {activity.exitCode}</span>
        )}
        <span className="activity-status">
          {activity.status === 'running' ? (
            <span className="spinner" />
          ) : activity.status === 'done' ? (
            <span className="codicon codicon-check" />
          ) : (
            <span className="codicon codicon-close" />
          )}
        </span>
      </button>
      <Collapsible open={open && canExpand}>
        {richMcp ? (
          <div className="activity-detail activity-detail-rich">
            <Markdown text={activity.detail ?? ''} />
          </div>
        ) : (
          <pre className={`activity-detail ${activity.detailKind === 'terminal' && activity.exitCode ? 'failed' : ''}`}>
            {activity.detail}
          </pre>
        )}
      </Collapsible>
    </div>
  );
}

export function isLiveMessage(message: UiMessage): boolean {
  return (
    Boolean(message.streaming) ||
    Boolean(message.activities?.some((activity) => activity.status === 'running'))
  );
}

function sameRuns(previous?: string[], next?: string[]): boolean {
  const left = previous ?? [];
  const right = next ?? [];
  return left.length === right.length && left.every((runId, index) => runId === right[index]);
}

export const MessageBubble = memo(
  MessageBubbleComponent,
  (previous, next) =>
    previous.mcpDisplay === next.mcpDisplay &&
    previous.message === next.message &&
    sameRuns(previous.viewableRuns, next.viewableRuns) &&
    !isLiveMessage(previous.message) &&
    !isLiveMessage(next.message),
);
