// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { QuestionRequest } from '../src/shared/protocol';

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../webview/src/vscode', () => ({
  post: (message: Record<string, unknown>) => {
    sent.push(message);
  },
  vscode: { postMessage: () => undefined },
}));

import { QuestionCard, formatBatchAnswer } from '../webview/src/components/QuestionCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function mount(request: QuestionRequest): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(QuestionCard, { request }));
  });
  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  sent.length = 0;
});

describe('formatBatchAnswer', () => {
  it('formats Q: A lines and marks skipped answers', () => {
    expect(
      formatBatchAnswer(
        [
          { question: 'Which database?', options: [] },
          { question: 'Run migrations?', options: [] },
        ],
        ['Postgres', ''],
      ),
    ).toBe('Which database?: Postgres\nRun migrations?: (skipped)');
  });
});

describe('batch question card', () => {
  const request: QuestionRequest = {
    id: 'q1',
    question: 'Which database?',
    header: 'Setup',
    options: [],
    questions: [
      {
        question: 'Which database?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        custom: true,
      },
      {
        question: 'Run migrations?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  };

  it('navigates 1/N and submits all answers as Q: A lines', () => {
    const el = mount(request);
    expect(el.textContent).toContain('1/2');
    const first = el.querySelectorAll('.question-option');
    click(first[0]);
    click(el.querySelector('.question-continue')!);

    expect(el.textContent).toContain('2/2');
    const second = el.querySelectorAll('.question-option');
    click(second[1]);
    click(el.querySelector('.question-continue')!);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'questionAnswer', id: 'q1' });
    expect(sent[0].answer).toBe('Which database?: Postgres\nRun migrations?: No');
  });

  it('skips a question without blocking the rest', () => {
    const el = mount(request);
    click(el.querySelector('.question-skip')!);
    expect(el.textContent).toContain('2/2');
    const second = el.querySelectorAll('.question-option');
    click(second[0]);
    click(el.querySelector('.question-continue')!);
    expect(sent[0].answer).toBe('Which database?: (skipped)\nRun migrations?: Yes');
  });

  it('renders a legacy single question without navigation', () => {
    const el = mount({
      id: 'q2',
      question: 'Deploy now?',
      header: 'Deploy',
      options: [{ label: 'Yes' }, { label: 'No' }],
    });
    expect(el.textContent).not.toContain('1/1');
    click(el.querySelectorAll('.question-option')[0]);
    click(el.querySelector('.question-continue')!);
    expect(sent[0]).toMatchObject({ type: 'questionAnswer', id: 'q2', answer: 'Yes' });
  });
});
