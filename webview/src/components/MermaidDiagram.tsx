import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import mermaid from 'mermaid';

let lastDark: boolean | undefined;

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

type Viewport = {
  scale: number;
  x: number;
  y: number;
};

const INITIAL_VIEW: Viewport = { scale: 1, x: 0, y: 0 };

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
    // Keep Mermaid from shrinking a wide graph until its labels are
    // unreadable. The viewer provides pan/zoom for graphs larger than the
    // available card width.
    flowchart: {
      useMaxWidth: false,
      nodeSpacing: 60,
      rankSpacing: 80,
      padding: 18,
    },
  });
}

export function MermaidDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [themeKey, setThemeKey] = useState(0);
  const [view, setView] = useState<Viewport>(INITIAL_VIEW);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeKey((value) => value + 1));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    ensureInit();
    let cancelled = false;
    setFailed(false);
    setRendering(true);
    setView(INITIAL_VIEW);
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
        setRendering(false);
      })
      .catch(() => {
        if (!cancelled) {
          setRendering(false);
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

  const setScale = (nextScale: number, clientX?: number, clientY?: number) => {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    setView((current) => {
      if (scale === current.scale) {
        return current;
      }
      const viewport = viewportRef.current;
      if (!viewport || clientX === undefined || clientY === undefined) {
        return { ...current, scale };
      }
      const bounds = viewport.getBoundingClientRect();
      const centerX = clientX - bounds.left - bounds.width / 2;
      const centerY = clientY - bounds.top - bounds.height / 2;
      return {
        scale,
        x: centerX - (centerX - current.x) * (scale / current.scale),
        y: centerY - (centerY - current.y) * (scale / current.scale),
      };
    });
  };

  const zoom = (delta: number) => setScale(view.scale + delta);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    // Ctrl+wheel is reserved for browser zoom. Plain wheel zooms the diagram
    // because the viewport itself is intentionally not a scroll container.
    if (event.ctrlKey) {
      return;
    }
    event.preventDefault();
    const direction = event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
    setScale(view.scale + direction, event.clientX, event.clientY);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setView((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };

  const reset = () => setView(INITIAL_VIEW);
  const zoomPercent = `${Math.round(view.scale * 100)}%`;

  return (
    <div className="mermaid-wrap">
      <div className="mermaid-toolbar" role="toolbar" aria-label="Diagram controls">
        <button type="button" className="mermaid-control" onClick={() => zoom(-SCALE_STEP)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <span className="mermaid-zoom" aria-live="polite">{zoomPercent}</span>
        <button type="button" className="mermaid-control" onClick={() => zoom(SCALE_STEP)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button type="button" className="mermaid-reset" onClick={reset} aria-label="Reset diagram view" title="Reset view">
          Reset
        </button>
      </div>
      <div
        className={`mermaid-viewport${dragging ? ' dragging' : ''}`}
        ref={viewportRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="img"
        aria-label="Mermaid diagram. Drag to pan, use the controls or mouse wheel to zoom."
      >
        <div
          className="mermaid-canvas"
          ref={ref}
          style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
        />
        {rendering && <div className="mermaid-status" aria-live="polite">Drawing diagram…</div>}
      </div>
      <div className="mermaid-hint">Drag to move · scroll to zoom · Reset to recenter</div>
    </div>
  );
}
