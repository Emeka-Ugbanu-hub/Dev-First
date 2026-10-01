// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InputBox } from '../webview/src/components/InputBox';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function lines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}`).join('\n');
}

function mount(pasteFileLines: number, onSend: (text: string, images?: string[], pastes?: Array<{ id: string; text: string }>) => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(InputBox, {
        phase: 'idle' as const,
        hasPlan: false,
        connected: true,
        selection: null,
        commands: [],
        files: [],
        quote: null,
        images: [],
        sessions: [],
        autoApproveTerminal: false,
        supportsVision: true,
        visionSupportKnown: true,
        reasoningEffort: 'off',
        modelName: 'gpt-4o',
        modelId: 'gpt-4o',
        modelPreset: 'openai',
        reasoningLevels: [],
        queuedMessages: [],
        enhanced: null,
        prefill: null,
        pasteFileLines,
        onImagesChange: () => undefined,
        onToggleAutoApprove: () => undefined,
        onOpenModelPicker: () => undefined,
        onSend,
        onEditQueued: () => undefined,
        onCancelQueued: () => undefined,
        onStop: () => undefined,
        onDismissSelection: () => undefined,
        onDismissQuote: () => undefined,
        onEnhance: () => undefined,
      }),
    );
  });
  return container;
}

function paste(element: HTMLTextAreaElement, text: string): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { files: [], getData: () => text },
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function clickSend(element: HTMLElement): void {
  const button = element.querySelector<HTMLButtonElement>('.btn-send');
  act(() => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

describe('InputBox large pastes', () => {
  it('saves pastes above the limit as a file reference and posts them as pastes', () => {
    const onSend = vi.fn();
    const element = mount(120, onSend);
    const big = lines(121);
    const textarea = element.querySelector<HTMLTextAreaElement>('.input-textarea')!;

    paste(textarea, big);

    expect(textarea.value).toContain('[Pasted ~121 lines → saved to file]');
    expect(element.querySelector('.paste-chip')?.textContent).toContain('saved to file');

    clickSend(element);

    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, images, pastes] = onSend.mock.calls[0];
    expect(text).toContain('[Pasted ~121 lines → saved to file]');
    expect(text).not.toContain('line 120');
    expect(images).toBeUndefined();
    expect(pastes).toHaveLength(1);
    expect(pastes[0].text).toBe(big);
    expect(pastes[0].id).toMatch(/^paste_/);
  });

  it('expands medium pastes inline without a file reference', () => {
    const onSend = vi.fn();
    const element = mount(120, onSend);
    const medium = lines(20);
    const textarea = element.querySelector<HTMLTextAreaElement>('.input-textarea')!;

    paste(textarea, medium);

    expect(textarea.value).toContain('[Pasted ~20 lines]');
    expect(textarea.value).not.toContain('saved to file');

    clickSend(element);

    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, images, pastes] = onSend.mock.calls[0];
    expect(text).toBe(medium);
    expect(images).toBeUndefined();
    expect(pastes).toBeUndefined();
  });

  it('inserts small pastes directly', () => {
    const onSend = vi.fn();
    const element = mount(120, onSend);
    const textarea = element.querySelector<HTMLTextAreaElement>('.input-textarea')!;

    const event = paste(textarea, 'one\ntwo\nthree');

    expect(event.defaultPrevented).toBe(false);
    expect(element.querySelector('.paste-chip')).toBeNull();
  });

  it('expands a file-backed chip when the expand action is used', () => {
    const onSend = vi.fn();
    const element = mount(120, onSend);
    const big = lines(121);
    const textarea = element.querySelector<HTMLTextAreaElement>('.input-textarea')!;

    paste(textarea, big);
    const expand = element.querySelector<HTMLButtonElement>('.paste-expand');
    act(() => {
      expand!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(textarea.value).toContain('line 120');
    expect(element.querySelector('.paste-chip')).toBeNull();
  });
});
