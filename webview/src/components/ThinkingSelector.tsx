import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react';
import { post } from '../vscode';
import { useOverlayDismiss } from '../lib/overlays';

const WIDTH = 224;
const TRACK_HEIGHT = 32;
const TOP = 20;
const RADIUS = TRACK_HEIGHT / 2;
const EDGE = (TRACK_HEIGHT - 27.2) / 2;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const centerFor = (value: number, count: number) =>
  count < 2 ? WIDTH / 2 : RADIUS + (value / (count - 1)) * (WIDTH - RADIUS * 2);

function shellPath(center: number, labelWidth: number, open: number) {
  const leftEdge = RADIUS;
  const rightEdge = WIDTH - RADIUS;
  const bottom = TOP + TRACK_HEIGHT;
  const plateauWidth = Math.max(0, labelWidth + 16) * open;
  const shoulderWidth = 12 * open;
  // Keep the whole label shelf and both shoulders inside the pill at either end.
  const shelfCenter = clamp(center, leftEdge + plateauWidth / 2 + shoulderWidth, rightEdge - plateauWidth / 2 - shoulderWidth);
  const plateauLeft = shelfCenter - plateauWidth / 2;
  const plateauRight = shelfCenter + plateauWidth / 2;
  const left = plateauLeft - shoulderWidth;
  const right = plateauRight + shoulderWidth;
  const bumpTop = TOP - 19 * open;
  const leftShoulderControl = plateauLeft - shoulderWidth * 0.45;
  const rightShoulderControl = plateauRight + shoulderWidth * 0.45;
  return [
    `M${leftEdge} ${bottom}`,
    `A${RADIUS} ${RADIUS} 0 0 1 ${leftEdge} ${TOP}`,
    `H${left}`,
    `C${left + (plateauLeft - left) * 0.45} ${TOP} ${leftShoulderControl} ${bumpTop} ${plateauLeft} ${bumpTop}`,
    `H${plateauRight}`,
    `C${rightShoulderControl} ${bumpTop} ${right - (right - plateauRight) * 0.45} ${TOP} ${right} ${TOP}`,
    `H${rightEdge}`,
    `A${RADIUS} ${RADIUS} 0 0 1 ${rightEdge} ${bottom}`,
    `H${leftEdge}Z`,
  ].join(' ');
}

export function ThinkingSelector({ levels, current, preset, model }: { levels: string[]; current: string; preset: string; model: string }) {
  const currentIndex = Math.max(0, levels.indexOf(current));
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentIndex);
  const [dragging, setDragging] = useState(false);
  const [openAmount, setOpenAmount] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const openAmountRef = useRef(0);
  const gradientId = useId().replace(/:/g, '');
  useOverlayDismiss(open, () => { setOpen(false); setDragging(false); draggingRef.current = false; }, rootRef);

  useEffect(() => {
    if (!dragging) setValue(currentIndex);
  }, [currentIndex, dragging]);

  useEffect(() => {
    const startValue = openAmountRef.current;
    const target = dragging ? 1 : 0;
    const startedAt = performance.now();
    let frame = 0;
    const animate = (now: number) => {
      const t = Math.min(1, (now - startedAt) / (dragging ? 220 : 170));
      const eased = 1 - (1 - t) ** 3;
      const next = startValue + (target - startValue) * eased;
      openAmountRef.current = next;
      setOpenAmount(next);
      if (t < 1) frame = requestAnimationFrame(animate);
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      openAmountRef.current = target;
      setOpenAmount(target);
    } else {
      frame = requestAnimationFrame(animate);
    }
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  if (levels.length === 0) return null;

  const selected = levels[clamp(Math.round(value), 0, levels.length - 1)] ?? levels[0];
  const label = (selected || 'medium').replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const center = centerFor(value, levels.length);
  const visibleLabelWidth = label.length * 6.2;
  const labelCenter = clamp(center, RADIUS + visibleLabelWidth / 2 + 20, WIDTH - RADIUS - visibleLabelWidth / 2 - 20);
  const thumbWidth = 27.2 + (33.6 - 27.2) * openAmount;
  const thumbLeft = clamp(center - thumbWidth / 2, EDGE, WIDTH - EDGE - thumbWidth);
  const fillWidth = clamp(center, EDGE, WIDTH - EDGE);
  const tickHeights = levels.map((_, index) => 5 + (index / Math.max(1, levels.length - 1)) * 5);
  const path = shellPath(center, visibleLabelWidth, openAmount);

  const valueFromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return value;
    const localX = ((clientX - rect.left) / rect.width) * WIDTH;
    if (levels.length < 2) return 0;
    return clamp(((localX - RADIUS) / (WIDTH - RADIUS * 2)) * (levels.length - 1), 0, levels.length - 1);
  };
  const commit = (nextValue: number) => {
    const next = levels[clamp(Math.round(nextValue), 0, levels.length - 1)];
    if (next) post({ type: 'setReasoningEffort', preset, model, value: next });
  };
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    commit(value);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch { /* Pointer capture is not available in synthetic events. */ }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const max = levels.length - 1;
    let next = Math.round(value);
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(max, next + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, next - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = max;
    else return;
    event.preventDefault();
    setValue(next);
    commit(next);
  };

  return (
    <div className="thinking-selector" ref={rootRef}>
      <button
        className="icon-btn input-tool thinking-button composer-reasoning"
        title={`Reasoning effort: ${label}`}
        aria-label={`Reasoning effort: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="codicon codicon-lightbulb" />
        <span className="thinking-current">{levels[currentIndex] ?? levels[0]}</span>
      </button>
      {open && (
        <>
          <button type="button" className="df-backdrop" aria-label="Close reasoning effort slider" onClick={() => setOpen(false)} />
          <div className="reasoning-slider-popover" role="dialog" aria-label="Reasoning effort">
            <div className="reasoning-slider" data-dragging={dragging ? 'true' : 'false'}>
              <svg className="reasoning-shell" viewBox={`0 0 ${WIDTH} ${TOP + TRACK_HEIGHT}`} aria-hidden="true">
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="var(--vscode-editorWidget-background, #252526)" />
                    <stop offset="1" stopColor="color-mix(in srgb, var(--vscode-editorWidget-background, #252526) 88%, white)" />
                  </linearGradient>
                </defs>
                <path d={path} fill={`url(#${gradientId})`} stroke="var(--vscode-widget-border, var(--df-border))" strokeWidth="1" />
              </svg>
              <div className={`reasoning-slider-label ${openAmount > 0.02 ? 'visible' : ''}`} style={{ left: `${(labelCenter / WIDTH) * 100}%`, opacity: openAmount }}>
                <span className="reasoning-label-current">{selected}</span>
              </div>
              <div
                ref={trackRef}
                className="reasoning-slider-track"
                role="slider"
                tabIndex={0}
                aria-label={`Reasoning effort for ${model}`}
                aria-valuemin={0}
                aria-valuemax={levels.length - 1}
                aria-valuenow={Math.round(value)}
                aria-valuetext={selected}
                onKeyDown={handleKeyDown}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  draggingRef.current = true;
                  setDragging(true);
                  setValue(valueFromPointer(event.clientX));
                  try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Ignore unsupported capture. */ }
                }}
                onPointerMove={(event) => { if (draggingRef.current) setValue(valueFromPointer(event.clientX)); }}
                onPointerUp={finishDrag}
                onPointerCancel={finishDrag}
              >
                <span className="reasoning-slider-fill" style={{ width: `${(fillWidth / WIDTH) * 100}%` }} />
                <span className="reasoning-slider-thumb" style={{ left: `${(thumbLeft / WIDTH) * 100}%`, width: `${(thumbWidth / WIDTH) * 100}%` }} />
                {levels.map((level, index) => {
                  const x = centerFor(index, levels.length);
                  const onThumb = x >= thumbLeft && x <= thumbLeft + thumbWidth;
                  return <span key={level} className={`reasoning-slider-tick ${onThumb ? 'on-thumb' : ''} ${Math.round(value) === index ? 'active' : ''}`} style={{ left: `${(x / WIDTH) * 100}%`, height: `${tickHeights[index]}px` }} />;
                })}
              </div>
            </div>
            <div className="reasoning-slider-stops" aria-hidden="true">
              {levels.map((level, index) => (
                <span key={level} className={Math.round(value) === index ? 'active' : ''}>{level.replace(/[-_]/g, ' ')}</span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
