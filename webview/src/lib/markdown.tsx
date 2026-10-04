import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from '../components/CodeBlock';
import { MermaidDiagram } from '../components/MermaidDiagram';
import { plainText } from './reactText';
import { isKnownFile, parseFileToken } from './fileLinks';
import { post } from '../vscode';

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // Syntax highlighting is expensive to redo for every streamed token.
        // The final render applies highlighting once the text has settled.
        rehypePlugins={streaming ? [] : [rehypeHighlight]}
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children }) {
            const value = plainText(children).replace(/\n$/, '');
            const match = /language-([\w-]+)/.exec(className ?? '');
            if (match?.[1] === 'mermaid') {
              if (streaming) {
                return <div className="mermaid-streaming" aria-live="off">Drawing diagram…</div>;
              }
              return <MermaidDiagram source={value} />;
            }
            if (!match && !value.includes('\n')) {
              const file = parseFileToken(value);
              if (file && isKnownFile(file.path)) {
                return (
                  <button
                    className="file-link"
                    title={`Open ${value}`}
                    onClick={() => post({ type: 'openFile', path: value })}
                  >
                    <span className="codicon codicon-go-to-file" /> {children}
                  </button>
                );
              }
              return <code className={className}>{children}</code>;
            }
            return (
              <CodeBlock language={match?.[1] ?? ''} className={className}>
                {children}
              </CodeBlock>
            );
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  if (href) {
                    post({ type: 'openExternal', url: href });
                  }
                }}
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="table-wrap">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function InlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return <>{parts}</>;
}
