import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UiMessage } from '../../../src/shared/protocol';

export function PromptRail({
  messages,
  activeId,
  onJump,
}: {
  messages: UiMessage[];
  activeId: string | undefined;
  onJump: (id: string) => void;
}) {
  const prompts = messages.flatMap((message, index) => {
    if (message.role !== 'user') return [];
    let response = '';
    for (let next = index + 1; next < messages.length && messages[next]?.role !== 'user'; next += 1) {
      const candidate = messages[next];
      if (candidate?.role === 'assistant' && candidate.text.trim()) {
        response = candidate.text.trim();
        break;
      }
    }
    return [{ id: message.id, text: message.text, response }];
  });
  const [hovered, setHovered] = useState<{ id: string; top: number } | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => setRailHeight(rail.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [prompts.length]);

  const tickGap = prompts.length > 1
    ? Math.min(10, Math.max(0, railHeight - 12) / (prompts.length - 1))
    : 0;
  const tickStart = Math.max(6, (railHeight - tickGap * (prompts.length - 1)) / 2);
  const hoveredPrompt = hovered ? prompts.find((prompt) => prompt.id === hovered.id) : undefined;
  const hoveredIndex = hovered ? prompts.findIndex((prompt) => prompt.id === hovered.id) : -1;

  if (prompts.length < 3) {
    return null;
  }

  return (
    <div
      className="prompt-rail"
      ref={railRef}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, .rail-card')) return;
        const rect = railRef.current?.getBoundingClientRect();
        if (!rect || prompts.length === 0) return;
        const y = event.clientY - rect.top;
        const index = tickGap > 0 ? Math.round((y - tickStart) / tickGap) : 0;
        const clamped = Math.max(0, Math.min(prompts.length - 1, index));
        onJump(prompts[clamped].id);
      }}
    >
      <div className="rail-track" aria-label="Prompt timeline">
        {prompts.map((prompt, index) => (
          <button
            key={prompt.id}
            className={`rail-tick ${prompt.id === activeId ? 'active' : ''} ${prompt.id === hovered?.id ? 'previewing' : ''} ${Math.abs(index - hoveredIndex) === 1 ? 'neighboring' : ''}`}
            style={{ top: `${tickStart + index * tickGap}px` }}
            aria-label={`Jump to prompt ${index + 1}`}
            onMouseEnter={(event) => {
              if (closeTimer.current) clearTimeout(closeTimer.current);
              const rect = event.currentTarget.closest('.prompt-rail')?.getBoundingClientRect();
              if (rect) setHovered({ id: prompt.id, top: Math.max(56, Math.min(rect.height - 56, event.clientY - rect.top)) });
            }}
            onMouseLeave={() => { closeTimer.current = setTimeout(() => setHovered(null), 180); }}
            onClick={() => onJump(prompt.id)}
          />
        ))}
      </div>
      {hovered !== null && (
        <div
          className="rail-card"
          role="tooltip"
          style={{ top: hovered.top }}
          onMouseEnter={() => { if (closeTimer.current) clearTimeout(closeTimer.current); }}
          onMouseLeave={() => { closeTimer.current = setTimeout(() => setHovered(null), 100); }}
        >
          {hoveredPrompt && (
            <>
              <div className="rail-card-title-row">
                <div className="rail-card-title">{hoveredPrompt.text}</div>
                <span className="codicon codicon-bookmark rail-card-bookmark" aria-hidden="true" />
              </div>
              {hoveredPrompt.response && <div className="rail-card-text">{hoveredPrompt.response}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
