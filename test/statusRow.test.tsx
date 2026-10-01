// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusRow } from '../webview/src/components/StatusRow';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function mount(text: string, tone: 'progress' | 'error'): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(StatusRow, { text, tone }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

describe('StatusRow', () => {
  it('renders the status text with a spinner codicon for progress', () => {
    const element = mount('Retrying attempt 1…', 'progress');
    const row = element.querySelector('.status-row');
    expect(row?.getAttribute('role')).toBe('status');
    expect(row?.className).toContain('status-progress');
    expect(element.querySelector('.status-text')?.textContent).toBe('Retrying attempt 1…');
    expect(element.querySelector('.codicon-loading')).not.toBeNull();
    expect(element.querySelector('.codicon-modifier-spin')).not.toBeNull();
  });

  it('switches to the error codicon for the error tone', () => {
    const element = mount('Retrying failed', 'error');
    expect(element.querySelector('.codicon-error')).not.toBeNull();
    expect(element.querySelector('.codicon-loading')).toBeNull();
  });
});
