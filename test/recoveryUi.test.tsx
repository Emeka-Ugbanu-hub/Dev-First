// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RunRecord, RunReviewFile, UiMessage } from '../src/shared/protocol';

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../webview/src/vscode', () => ({
  post: (message: Record<string, unknown>) => {
    sent.push(message);
  },
  vscode: { postMessage: () => undefined },
}));

import { RecoveryCard } from '../webview/src/components/RecoveryCard';
import { RunReviewCard } from '../webview/src/components/RunReviewCard';
import { InputBox } from '../webview/src/components/InputBox';
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

  it('renders the pending decision with approve and deny', () => {
    const element = mount(
      createElement(RecoveryCard, {
        run: runRecord({
          pending: {
            id: 'p1',
            kind: 'terminal',
            prompt: 'npm test',
            command: 'npm test -- --run',
            cwd: '/repo',
            createdAt: 3,
          },
        }),
        onDismiss: () => undefined,
      }),
    );
    expect(element.textContent).toContain('Waiting on: npm test');
    expect(element.textContent).toContain('npm test -- --run');
    expect(element.textContent).toContain('/repo');
    expect(element.textContent).toContain('Re-validated before running.');
    click(button(element, 'Approve'));
    click(button(element, 'Deny'));
    expect(sent).toEqual([
      { type: 'resolveRecoveredDecision', runId: 'run1', approved: true },
      { type: 'resolveRecoveredDecision', runId: 'run1', approved: false },
    ]);
  });

  it('shows reasoning in the meta line when present', () => {
    const element = mount(
      createElement(RecoveryCard, { run: runRecord({ reasoning: 'high' }), onDismiss: () => undefined }),
    );
    expect(element.textContent).toContain('reasoning high');
  });

  it('warns about workspace drift', () => {
    const element = mount(
      createElement(RecoveryCard, { run: runRecord(), runDrift: true, onDismiss: () => undefined }),
    );
    expect(element.textContent).toContain('Workspace changed since the last step');
  });

  it('posts openRunReview when recovered changes exist', () => {
    const element = mount(
      createElement(RecoveryCard, {
        run: runRecord({ changedFiles: [{ path: 'src/a.ts', status: 'modified' }] }),
        onDismiss: () => undefined,
      }),
    );
    click(button(element, 'Review changes'));
    expect(sent).toEqual([{ type: 'openRunReview', runId: 'run1' }]);
  });

  it('hides the review button without recovered changes', () => {
    const element = mount(createElement(RecoveryCard, { run: runRecord(), onDismiss: () => undefined }));
    expect(element.textContent).not.toContain('Review changes');
  });

  it('renders external processes with liveness and posts stop or forget', () => {
    const element = mount(
      createElement(RecoveryCard, {
        run: runRecord({
          processes: [
            { id: 'bg1', pid: 111, command: 'npm run dev', startedAt: 1 },
            { id: 'bg2', pid: 222, command: 'node server.js', startedAt: 2 },
          ],
        }),
        processesAlive: [222],
        onDismiss: () => undefined,
      }),
    );
    expect(element.textContent).toContain('External processes');
    expect(element.textContent).toContain('npm run dev (pid 111)');
    expect(element.textContent).toContain('node server.js (pid 222)');
    const dots = element.querySelectorAll('.recovery-process-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0].className).toContain('gone');
    expect(dots[1].className).toContain('alive');
    click(button(element, 'Stop'));
    click(button(element, 'Forget'));
    expect(sent).toEqual([
      { type: 'stopRunProcess', runId: 'run1', pid: 111 },
      { type: 'forgetRunProcess', runId: 'run1', pid: 111 },
    ]);
  });

  it('renders the browser session and posts forgetBrowser', () => {
    const element = mount(
      createElement(RecoveryCard, {
        run: runRecord({ browser: { port: 9222 } }),
        onDismiss: () => undefined,
      }),
    );
    expect(element.textContent).toContain('Browser session on port 9222');
    click(button(element, 'Forget'));
    expect(sent).toEqual([{ type: 'forgetBrowser', runId: 'run1' }]);
  });

  it('notes uncertain MCP requests', () => {
    const element = mount(createElement(RecoveryCard, { run: runRecord(), onDismiss: () => undefined }));
    expect(element.textContent).toContain('Any in-flight MCP requests are marked uncertain');
  });

  it('calls onDismiss when dismissed', () => {
    const onDismiss = vi.fn();
    const element = mount(createElement(RecoveryCard, { run: runRecord(), onDismiss }));
    click(element.querySelector('.recovery-dismiss')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('RunReviewCard', () => {
  const files: RunReviewFile[] = [
    { path: 'src/a.ts', status: 'modified' },
    { path: 'src/b.ts', status: 'added' },
    { path: 'src/c.ts', status: 'deleted' },
  ];

  it('renders files with status chips', () => {
    const element = mount(createElement(RunReviewCard, { runId: 'run1', files }));
    expect(element.textContent).toContain('src/a.ts');
    expect(element.textContent).toContain('src/b.ts');
    expect(element.textContent).toContain('src/c.ts');
    expect(element.querySelector('.run-review-modified')?.textContent).toBe('modified');
    expect(element.querySelector('.run-review-added')?.textContent).toBe('added');
    expect(element.querySelector('.run-review-deleted')?.textContent).toBe('deleted');
  });

  it('posts openFileDiff, revertRunFile, and acceptRunReview', () => {
    const element = mount(createElement(RunReviewCard, { runId: 'run1', files }));
    click(button(element, 'src/a.ts'));
    click(element.querySelector('button[aria-label="Revert src/a.ts"]')!);
    click(button(element, 'Accept all'));
    expect(sent).toEqual([
      { type: 'openFileDiff', path: 'src/a.ts', runId: 'run1' },
      { type: 'revertRunFile', path: 'src/a.ts', runId: 'run1' },
      { type: 'acceptRunReview', runId: 'run1' },
    ]);
  });

  it('renders nothing without files', () => {
    const element = mount(createElement(RunReviewCard, { runId: 'run1', files: [] }));
    expect(element.querySelector('.run-review-card')).toBeNull();
  });

  it('shows a conflict warning with a force restore action', () => {
    const element = mount(createElement(RunReviewCard, { runId: 'run1', files, conflicts: ['src/a.ts'] }));
    expect(element.textContent).toContain("Couldn't revert — the file was edited since.");
    expect(element.textContent).toContain('Restore anyway');
    click(button(element, 'Restore anyway'));
    expect(sent).toEqual([{ type: 'revertRunFileForce', path: 'src/a.ts', runId: 'run1' }]);
  });
});

describe('queued prompt actions', () => {
  function inputBox(overrides: Record<string, unknown> = {}) {
    return createElement(InputBox, {
      phase: 'executing',
      hasPlan: true,
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
      queuedMessages: [{ id: 'q1', role: 'user', text: 'follow up', queued: true }],
      queuedRecords: [{ id: 'q1', text: 'follow up', status: 'queued', createdAt: 1 }],
      enhanced: null,
      prefill: null,
      pasteFileLines: 120,
      onImagesChange: () => undefined,
      onToggleAutoApprove: () => undefined,
      onOpenModelPicker: () => undefined,
      onSend: () => undefined,
      onEditQueued: () => undefined,
      onCancelQueued: () => undefined,
      onStop: () => undefined,
      onDismissSelection: () => undefined,
      onDismissQuote: () => undefined,
      onEnhance: () => undefined,
      ...overrides,
    } as never);
  }

  it('edits a queued prompt through the edit callback', () => {
    const onEditQueued = vi.fn();
    const element = mount(inputBox({ onEditQueued }));
    click(button(element, 'Edit'));
    expect(onEditQueued).toHaveBeenCalledTimes(1);
    expect((onEditQueued.mock.calls[0][0] as UiMessage).id).toBe('q1');
  });

  it('discards a queued prompt through the cancel callback', () => {
    const onCancelQueued = vi.fn();
    const element = mount(inputBox({ onCancelQueued }));
    click(button(element, 'Discard'));
    expect(onCancelQueued).toHaveBeenCalledWith('q1');
  });

  it('prefills the composer with the queued prompt text', () => {
    const element = mount(inputBox({ prefill: { text: 'follow up', nonce: 42 } }));
    expect(element.querySelector('textarea')?.value).toBe('follow up');
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
