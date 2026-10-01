import { useEffect, useId, useRef, useState } from 'react';
import { Collapsible } from './Collapsible';

export function ThinkingRow({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);
  const contentId = useId();

  useEffect(() => {
    const element = bodyRef.current;
    if (open && streaming && element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [text, open, streaming]);

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
        <span className={streaming ? 'thinking-label shimmer' : 'thinking-label'}>
          {streaming ? 'Thinking…' : 'Thought'}
        </span>
      </button>
      <div id={contentId} className="thinking-content">
      <Collapsible open={open}>
        <pre className="thinking-body" ref={bodyRef}>
          {text}
        </pre>
      </Collapsible>
      </div>
    </div>
  );
}
