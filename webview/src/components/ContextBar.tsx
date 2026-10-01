import { useRef, useState, type CSSProperties } from 'react';
import type { ContextUsage } from '../../../src/shared/protocol';
import { post } from '../vscode';
import { contextPercent, formatTokens } from '../lib/usage';

const FALLBACK_RESERVED_TOKENS = 8192;

export function ContextBar({ usage }: { usage: ContextUsage }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!usage.limit || usage.tokens <= 0) return null;

  const reserved = Math.max(0, Math.min(usage.reserved ?? FALLBACK_RESERVED_TOKENS, usage.limit - usage.tokens));
  const free = Math.max(0, usage.limit - usage.tokens - reserved);
  const percent = contextPercent(usage.tokens, usage.limit);
  const title = `${usage.tokens.toLocaleString()} tokens used · ${reserved.toLocaleString()} reserved · ${free.toLocaleString()} free of ${usage.limit.toLocaleString()}`;

  return (
    <div
      className={`context-usage ${open ? 'open' : ''}`}
      onPointerEnter={() => {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        setOpen(true);
      }}
      onPointerLeave={() => {
        closeTimer.current = setTimeout(() => setOpen(false), 120);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
    >
      <button
        className="context-trigger"
        type="button"
        aria-label={`Context usage ${percent} percent`}
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(true)}
        style={{ '--context-progress': `${percent}%` } as CSSProperties}
      >
        <span>{percent}%</span>
        <span className="context-ring" aria-hidden="true" />
      </button>
      {open && (
        <div className="context-popover" role="status">
          <div className="context-popover-head">
            <span>{percent}%</span>
            <span className="context-popover-total">{formatTokens(usage.tokens)} / {formatTokens(usage.limit)}</span>
          </div>
          <div className="context-popover-track" aria-hidden="true">
            <span className="context-popover-used" style={{ width: `${percent}%` }} />
          </div>
          <div className="context-popover-rows">
            <div><span><i className="context-dot used" />Used</span><strong>{formatTokens(usage.tokens)}</strong></div>
            <div><span><i className="context-dot reserved" />Reserved</span><strong>{formatTokens(reserved)}</strong></div>
            <div><span><i className="context-dot free" />Free</span><strong>{formatTokens(free)}</strong></div>
          </div>
          <button className="context-compact" type="button" onClick={() => post({ type: 'compactNow' })}>
            <span className="codicon codicon-fold" /> Compact conversation
          </button>
        </div>
      )}
    </div>
  );
}
