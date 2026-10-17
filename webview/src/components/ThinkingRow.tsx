import { useEffect, useId, useRef, useState } from 'react';
import { Collapsible } from './Collapsible';

function formatWait(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function ThinkingRow({
  text,
  streaming,
  stage,
  startedAt,
}: {
  text: string;
  streaming: boolean;
  stage?: string;
  startedAt?: number;
}) {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const bodyRef = useRef<HTMLPreElement>(null);
  const followTailRef = useRef(true);
  const contentId = useId();
  const showWait = Boolean(stage) && streaming && startedAt !== undefined;

  useEffect(() => {
    const element = bodyRef.current;
    if (open && streaming && element && followTailRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [text, open, streaming]);

  useEffect(() => {
    if (!showWait || startedAt === undefined) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [showWait, startedAt]);

  const label = stage ? stage : streaming ? 'Thinking…' : 'Thought';

  return (
    <div className={`thinking-row ${streaming ? 'is-streaming' : ''}`}>
      <button
        className="thinking-header"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} />
        <span className="codicon codicon-lightbulb thinking-icon" />
        <span className={streaming ? 'thinking-label shimmer' : 'thinking-label'}>{label}</span>
        {showWait && <span className="thinking-timer">{formatWait(elapsed)}</span>}
      </button>
      <div id={contentId} className="thinking-content">
      <Collapsible open={open}>
        <pre
          className="thinking-body"
          ref={bodyRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
            followTailRef.current = distanceFromBottom <= 32;
          }}
        >
          {text}
        </pre>
      </Collapsible>
      </div>
    </div>
  );
}
