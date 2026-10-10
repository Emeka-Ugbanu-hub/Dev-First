// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RunRecord, UiMessage } from '../src/shared/protocol';

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../webview/src/vscode', () => ({
  post: (message: Record<string, unknown>) => {
    sent.push(message);
  },
  vscode: { postMessage: () => undefined },
}));

import { RecoveryCard } from '../webview/src/components/RecoveryCard';
import { MessageBubble } from '../webview/src/components/MessageBubble';
import { queueStatusLabel } from '../webview/src/lib/queueStatus';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function mount(element: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function button(element: ParentNode, label: string): Element {
  const match = [...element.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(match, `button "${label}"`).toBeDefined();
  return match!;
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run1',
    sessionId: 's1',
    request: 'Add a health check endpoint',
    provider: 'openai',
    model: 'gpt-4o',
    status: 'interrupted',
    planVersion: 2,
    stepIndex: 1,
    completedSteps: [0],
    workspaceHash: 'hash',
    operations: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  sent.length = 0;
});

describe('RecoveryCard', () => {
  it('renders the interrupted run details', () => {
    const element = mount(createElement(RecoveryCard, { run: runRecord(), onDismiss: () => undefined }));
    expect(element.textContent).toContain('Run interrupted');
    expect(element.textContent).toContain('Add a health check endpoint');
    expect(element.textContent).toContain('Plan v2');
    expect(element.textContent).toContain('step 2');
    expect(element.textContent).toContain('gpt-4o');
    expect(element.textContent).toContain('Nothing runs until you choose.');
  });

  it('posts resumeRun, rollbackRun, and discardRun for the run', () => {
    const element = mount(
      createElement(RecoveryCard, { run: runRecord({ checkpointId: 'cp1' }), onDismiss: () => undefined }),
    );
    click(button(element, 'Resume'));
    click(button(element, 'Roll back'));
    click(button(element, 'Discard'));
    expect(sent).toEqual([
      { type: 'resumeRun', id: 'run1' },
      { type: 'rollbackRun', id: 'run1' },
      { type: 'discardRun', id: 'run1' },
    ]);
  });

  it('hides roll back without a checkpoint', () => {
    const element = mount(createElement(RecoveryCard, { run: runRecord(), onDismiss: () => undefined }));
    expect(element.textContent).not.toContain('Roll back');
  });

  it('shows the pending decision with a re-approval note', () => {
    const element = mount(
      createElement(RecoveryCard, {
        run: runRecord({
          pending: { id: 'p1', kind: 'terminal', prompt: 'npm test', createdAt: 3 },
        }),
        onDismiss: () => undefined,
      }),
    );
    expect(element.textContent).toContain('Waiting on: npm test');
    expect(element.textContent).toContain('re-approval will be requested when you resume');
  });

  it('calls onDismiss when dismissed', () => {
    const onDismiss = vi.fn();
    const element = mount(createElement(RecoveryCard, { run: runRecord(), onDismiss }));
    click(element.querySelector('.recovery-dismiss')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('queueStatusLabel', () => {
  it('maps queue record statuses to chip labels', () => {
    expect(queueStatusLabel('queued')).toBe('Queued');
    expect(queueStatusLabel('running')).toBe('Running');
    expect(queueStatusLabel('paused')).toBe('Paused');
    expect(queueStatusLabel('cancelled')).toBe('Cancelled');
    expect(queueStatusLabel('completed')).toBeNull();
  });
});

describe('MessageBubble interrupted response', () => {
  const interrupted: UiMessage = {
    id: 'm1',
    role: 'assistant',
    text: 'The endpoint currently returns',
    interrupted: true,
  };

  it('renders the badge with Continue and Discard', () => {
    const element = mount(createElement(MessageBubble, { message: interrupted, mcpDisplay: 'markdown' }));
    expect(element.querySelector('.interrupted-badge')?.textContent).toContain('Response interrupted');
    expect(button(element, 'Continue')).toBeDefined();
    expect(button(element, 'Discard')).toBeDefined();
    expect(element.textContent).toContain('The endpoint currently returns');
  });

  it('never shows the badge on a complete response', () => {
    const element = mount(
      createElement(MessageBubble, { message: { ...interrupted, interrupted: false }, mcpDisplay: 'markdown' }),
    );
    expect(element.querySelector('.interrupted-badge')).toBeNull();
  });

  it('continues through the prefill callback', () => {
    const onContinueInterrupted = vi.fn();
    const element = mount(
      createElement(MessageBubble, { message: interrupted, mcpDisplay: 'markdown', onContinueInterrupted }),
    );
    click(button(element, 'Continue'));
    expect(onContinueInterrupted).toHaveBeenCalledTimes(1);
  });

  it('discards the badge and keeps the partial text', () => {
    const element = mount(createElement(MessageBubble, { message: interrupted, mcpDisplay: 'markdown' }));
    click(button(element, 'Discard'));
    expect(element.querySelector('.interrupted-badge')).toBeNull();
    expect(element.textContent).toContain('The endpoint currently returns');
  });
});

describe('MessageBubble queue status chip', () => {
  const queued: UiMessage = { id: 'u1', role: 'user', text: 'Follow up question', queued: true };

  it('renders the status label from the queue record', () => {
    const element = mount(
      createElement(MessageBubble, { message: queued, mcpDisplay: 'markdown', queueStatus: 'running' }),
    );
    expect(element.querySelector('.queue-status-chip')?.textContent).toContain('Running');
    expect(element.querySelector('.queued-badge')).toBeNull();
  });

  it('hides completed entries even when the message is flagged queued', () => {
    const element = mount(
      createElement(MessageBubble, { message: queued, mcpDisplay: 'markdown', queueStatus: 'completed' }),
    );
    expect(element.querySelector('.queue-status-chip')).toBeNull();
    expect(element.querySelector('.queued-badge')).toBeNull();
  });

  it('falls back to the legacy badge without a queue record', () => {
    const element = mount(createElement(MessageBubble, { message: queued, mcpDisplay: 'markdown' }));
    expect(element.querySelector('.queued-badge')?.textContent).toContain('queued');
  });

  it('adds the recovered hint for restored queued entries', () => {
    const element = mount(
      createElement(MessageBubble, {
        message: queued,
        mcpDisplay: 'markdown',
        queueStatus: 'queued',
        queueRecovered: true,
      }),
    );
    expect(element.querySelector('.queue-recovered-hint')?.textContent).toContain(
      "Recovered — won't run automatically.",
    );
  });

  it('omits the recovered hint for entries queued this session', () => {
    const element = mount(
      createElement(MessageBubble, { message: queued, mcpDisplay: 'markdown', queueStatus: 'queued' }),
    );
    expect(element.querySelector('.queue-recovered-hint')).toBeNull();
  });
});
