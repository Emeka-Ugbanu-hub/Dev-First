import { useEffect, useState } from 'react';
import type { ContextUsage, Phase } from '../../../src/shared/protocol';
import type { SessionSummary } from '../../../src/shared/protocol';
import { SessionTabStrip } from './SessionTabStrip';
import { ContextBar } from './ContextBar';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'ready',
  planning: 'planning',
  executing: 'executing',
  review: 'review',
};

export function Header({
  phase,
  sessions,
  activeSessionId,
  contextUsage,
  onSearchClick,
  onSettingsClick,
  searchActive,
}: {
  phase: Phase;
  sessions: SessionSummary[];
  activeSessionId: string;
  contextUsage: ContextUsage;
  onSearchClick: () => void;
  onSettingsClick: () => void;
  searchActive: boolean;
}) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const running = phase === 'planning' || phase === 'executing';
    setStartedAt((current) => (running ? current ?? Date.now() : null));
  }, [phase]);

  useEffect(() => {
    if (startedAt === null) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <header className="header">
      <div className={`phase-dot phase-${phase}`} />
      <span className="brand">Dev-First</span>
      <span className={`phase-chip phase-${phase}`}>{PHASE_LABEL[phase]}</span>
      {startedAt !== null && (
        <span className="phase-timer" title="Elapsed time for this task">
          <span className="codicon codicon-clock" /> {formatElapsed(now - startedAt)}
        </span>
      )}
      <span className="spacer" />
      <button
        className={`icon-btn ${searchActive ? 'active' : ''}`}
        title="Search this session"
        onClick={onSearchClick}
      >
        <span className="codicon codicon-search" />
      </button>
      <ContextBar usage={contextUsage} />
      <SessionTabStrip sessions={sessions} activeId={activeSessionId} compact />
      <button className="icon-btn" title="Settings" onClick={onSettingsClick}>
        <span className="codicon codicon-settings-gear" />
      </button>
    </header>
  );
}
