import { useState, type ReactNode } from 'react';
import { plainText } from '../lib/reactText';

const COLLAPSE_THRESHOLD = 30;

export function CodeBlock({
  language,
  className,
  children,
}: {
  language: string;
  className?: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const text = plainText(children).replace(/\n$/, '');
  const lineCount = text.split('\n').length;
  const collapsible = lineCount > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!collapsible);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className={`code-block ${collapsible && !expanded ? 'collapsed' : ''}`}>
      <div className="code-block-header">
        <span className="code-lang">{language || 'text'}</span>
        <span className="spacer" />
        {collapsible && (
          <button className="code-copy" onClick={() => setExpanded((value) => !value)}>
            {expanded ? 'Collapse' : `Expand (${lineCount} lines)`}
          </button>
        )}
        <button className="code-copy" onClick={copy} title="Copy code">
          <span className={`codicon codicon-${copied ? 'check' : 'copy'}`} /> {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}
