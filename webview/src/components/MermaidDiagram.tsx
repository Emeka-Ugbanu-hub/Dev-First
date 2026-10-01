import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

let lastDark: boolean | undefined;

function ensureInit(): void {
  const dark =
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast');
  if (lastDark === dark) {
    return;
  }
  lastDark = dark;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'var(--vscode-font-family)',
  });
}

export function MermaidDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [themeKey, setThemeKey] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeKey((value) => value + 1));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    ensureInit();
    let cancelled = false;
    setFailed(false);
    const id = `df-mermaid-${Math.random().toString(36).slice(2)}`;
    mermaid
      .parse(source, { suppressErrors: true })
      .then((isValid) => {
        if (!isValid) {
          throw new Error('Invalid mermaid diagram');
        }
        return mermaid.render(id, source);
      })
      .then(({ svg }) => {
        if (cancelled || !ref.current) {
          return;
        }
        ref.current.innerHTML = svg;
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, themeKey]);

  if (failed) {
    return <pre className="mermaid-fallback">{source}</pre>;
  }
  return <div className="mermaid" ref={ref} />;
}
