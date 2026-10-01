// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../webview/src/vscode', () => ({
  post: (message: Record<string, unknown>) => {
    sent.push(message);
  },
  vscode: { postMessage: () => undefined },
}));

import { ThinkingSelector } from '../webview/src/components/ThinkingSelector';
import { ThinkingRow } from '../webview/src/components/ThinkingRow';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function mount(levels: string[], current: string): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ThinkingSelector, { levels, current, preset: 'ollama', model: 'qwen3:8b' }));
  });
  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function mountRow(text: string, streaming: boolean): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(ThinkingRow, { text, streaming }));
  });
  return container;
}

function rerenderRow(text: string, streaming: boolean): void {
  act(() => {
    root!.render(createElement(ThinkingRow, { text, streaming }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  sent.length = 0;
});

describe('ThinkingSelector', () => {
  it('renders the model reasoning levels verbatim', () => {
    const element = mount(['off', 'minimal', 'xhigh'], 'minimal');
    click(element.querySelector('.thinking-button')!);
    const options = [...element.querySelectorAll('.reasoning-slider-stops span')].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(['off', 'minimal', 'xhigh']);
    expect(element.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('shows the current level on the button', () => {
    const element = mount(['off', 'low', 'high'], 'low');
    expect(element.querySelector('.thinking-button')?.textContent).toContain('low');
  });

  it('renders nothing when no levels are available', () => {
    const element = mount([], 'off');
    expect(element.querySelector('.thinking-selector')).toBeNull();
    expect(element.textContent).toBe('');
  });

  it('posts the selected effort scoped to the current model', () => {
    const element = mount(['off', 'low', 'high'], 'off');
    click(element.querySelector('.thinking-button')!);
    const slider = element.querySelector('[role="slider"]')!;
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(sent).toContainEqual({ type: 'setReasoningEffort', preset: 'ollama', model: 'qwen3:8b', value: 'high' });
  });
});

describe('ThinkingRow', () => {
  it('starts collapsed while streaming', () => {
    const element = mountRow('working it out', true);
    expect(element.querySelector('.thinking-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(element.querySelector('.collapsible')?.className).not.toContain('open');
    expect(element.querySelector('.thinking-label')?.textContent).toBe('Thinking…');
  });

  it('stays collapsed when the stream finishes', () => {
    const element = mountRow('done thinking', true);
    rerenderRow('done thinking', false);
    expect(element.querySelector('.collapsible')?.className).not.toContain('open');
    expect(element.querySelector('.thinking-label')?.textContent).toBe('Thought');
  });

  it('expands on click and shows the live text', () => {
    const element = mountRow('partial thought', true);
    click(element.querySelector('.thinking-header')!);
    expect(element.querySelector('.collapsible')?.className).toContain('open');
    act(() => {
      root!.render(createElement(ThinkingRow, { text: 'partial thought plus more', streaming: true }));
    });
    expect(element.querySelector('.thinking-body')?.textContent).toBe('partial thought plus more');
  });
});
