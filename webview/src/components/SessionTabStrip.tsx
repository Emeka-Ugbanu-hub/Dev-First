import { useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol';
import { post } from '../vscode';
import { isEscapeKey, useOverlayDismiss } from '../lib/overlays';

export function SessionTabStrip({
  sessions,
  activeId,
  initialOpen,
  compact = false,
}: {
  sessions: SessionSummary[];
  activeId: string;
  initialOpen?: boolean;
  compact?: boolean;
}) {
  const [historyOpen, setHistoryOpen] = useState(initialOpen ?? false);
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useOverlayDismiss(historyOpen, () => setHistoryOpen(false), rootRef);

  const filtered = useMemo(
    () => sessions.filter((session) => session.title.toLowerCase().includes(query.toLowerCase())),
    [sessions, query],
  );

  return (
    <div className={`session-bar ${compact ? 'session-bar-compact' : ''}`} ref={rootRef}>
      {!compact && <div className="session-tabs">
        {sessions.slice(0, 5).map((session) => (
          <button
            key={session.id}
            className={`session-tab ${session.id === activeId ? 'active' : ''}`}
            title={session.title}
            onClick={() => post({ type: 'switchSession', id: session.id })}
          >
            <span className="session-tab-title">{session.title || 'Untitled'}</span>
            <span
              className="session-tab-close"
              title="Close session"
              onClick={(event) => {
                event.stopPropagation();
                post({ type: 'deleteSession', id: session.id });
              }}
            >
              <span className="codicon codicon-close" />
            </span>
          </button>
        ))}
      </div>}
      {!compact && <button className="icon-btn" title="New session" onClick={() => post({ type: 'newSession' })}>
        <span className="codicon codicon-add" />
      </button>}
      <button
        className="icon-btn"
        title="Session history"
        onClick={() => setHistoryOpen((value) => !value)}
      >
        <span className="codicon codicon-history" />
      </button>

      {historyOpen && (
        <>
          <button
            type="button"
            className="df-backdrop"
            aria-label="Close session history"
            onClick={() => setHistoryOpen(false)}
          />
          <div className="history-popover">
          <input
            className="onboarding-input"
            placeholder="Search sessions…"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (isEscapeKey(event.key)) {
                setHistoryOpen(false);
              }
            }}
          />
          <div className="model-list">
            {filtered.length === 0 && <div className="model-empty">No sessions found.</div>}
            {filtered.map((session) => (
              <div key={session.id} className={`history-item ${session.id === activeId ? 'selected' : ''}`}>
                {renamingId === session.id ? (
                  <input
                    className="onboarding-input"
                    value={renameDraft}
                    autoFocus
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        post({ type: 'renameSession', id: session.id, title: renameDraft });
                        setRenamingId(null);
                      }
                      if (event.key === 'Escape') {
                        setRenamingId(null);
                      }
                    }}
                    onBlur={() => setRenamingId(null)}
                  />
                ) : (
                  <button
                    className="history-open"
                    onClick={() => {
                      post({ type: 'switchSession', id: session.id });
                      setHistoryOpen(false);
                    }}
                  >
                    <span className="history-title">{session.title || 'Untitled'}</span>
                    <span className="history-meta">
                      {new Date(session.updatedAt).toLocaleString()} · {session.messageCount} messages
                    </span>
                  </button>
                )}
                <button
                  className="icon-btn"
                  title="Rename"
                  onClick={() => {
                    setRenamingId(session.id);
                    setRenameDraft(session.title);
                  }}
                >
                  <span className="codicon codicon-edit" />
                </button>
                <button
                  className="icon-btn"
                  title="Delete"
                  onClick={() => post({ type: 'deleteSession', id: session.id })}
                >
                  <span className="codicon codicon-trash" />
                </button>
              </div>
            ))}
          </div>
          </div>
        </>
      )}
    </div>
  );
}
