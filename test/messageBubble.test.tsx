// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ToolActivity, UiMessage } from '../src/shared/protocol';

const posted = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../webview/src/vscode', () => ({
  post: (message: Record<string, unknown>) => posted.push(message),
  vscode: { postMessage: () => undefined },
}));

import { MessageBubble } from '../webview/src/components/MessageBubble';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function mount(message: UiMessage, viewableRuns?: string[]): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(MessageBubble, { message, mcpDisplay: 'markdown', viewableRuns }));
  });
  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function assistant(activities: ToolActivity[]): UiMessage {
  return { id: 'm1', role: 'assistant', text: 'Working on it.', activities };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  posted.length = 0;
});

describe('MessageBubble activity group', () => {
  it('starts collapsed and summarizes finished activities', () => {
    const element = mount(
      assistant([
        { id: 'a1', label: 'Read src/App.tsx', status: 'done' },
        { id: 'a2', label: 'Run: npm test', status: 'done' },
      ]),
    );
    expect(element.querySelector('.collapsible')?.className).not.toContain('open');
    expect(element.querySelector('.activity-group-header')?.textContent).toContain('2 actions');
    expect(element.querySelector('.activity-group-chevron')?.className).toContain('codicon-chevron-right');
  });

  it('uses the singular for one activity', () => {
    const element = mount(assistant([{ id: 'a1', label: 'Read src/App.tsx', status: 'done' }]));
    expect(element.querySelector('.activity-group-header')?.textContent).toContain('1 action');
  });

  it('shows the running action label while collapsed', () => {
    const element = mount(
      assistant([
        { id: 'a1', label: 'Read src/App.tsx', status: 'done' },
        { id: 'a2', label: 'Run: npm test', status: 'running' },
      ]),
    );
    expect(element.querySelector('.collapsible')?.className).not.toContain('open');
    expect(element.querySelector('.activity-group-header')?.textContent).toContain('Run: npm test…');
  });

  it('expands to show every activity row', () => {
    const element = mount(
      assistant([
        { id: 'a1', label: 'Read src/App.tsx', status: 'done' },
        { id: 'a2', label: 'Run: npm test', status: 'running' },
      ]),
    );
    click(element.querySelector('.activity-group-header')!);
    expect(element.querySelector('.collapsible')?.className).toContain('open');
    expect(element.querySelector('.activity-group-chevron')?.className).toContain('codicon-chevron-down');
    const rows = [...element.querySelectorAll('.activity-label')].map((row) => row.textContent);
    expect(rows).toEqual(['Read src/App.tsx', 'Run: npm test']);
  });
});

describe('MessageBubble completion plan snapshot', () => {
  it('renders the finished plan collapsed by default and expands to checked steps', () => {
    const element = mount({
      id: 'm1',
      role: 'assistant',
      kind: 'completion',
      text: 'Done.',
      planSnapshot: { title: 'Add retry handling', steps: ['Add a helper', 'Wire it up'] },
    });
    const header = element.querySelector('.completion-plan-header');
    expect(header?.textContent).toContain('Add retry handling');
    expect(header?.textContent).toContain('2 steps');
    expect(element.querySelector('.completion-plan .collapsible')?.className).not.toContain('open');

    click(header!);

    expect(element.querySelector('.completion-plan .collapsible')?.className).toContain('open');
    const steps = [...element.querySelectorAll('.completion-plan-steps li')].map((item) => item.textContent);
    expect(steps).toEqual(['Add a helper', 'Wire it up']);
    expect(element.querySelectorAll('.completion-plan-steps .codicon-check').length).toBe(2);
  });

  it('omits the plan block when the completion has no snapshot', () => {
    const element = mount({ id: 'm1', role: 'assistant', kind: 'completion', text: 'Done.' });
    expect(element.querySelector('.completion-plan')).toBeNull();
  });
});

describe('MessageBubble changed files', () => {
  const completion: UiMessage = {
    id: 'm1',
    role: 'assistant',
    kind: 'completion',
    text: 'Done.',
    runId: 'run1',
    changedFiles: [
      { path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
      { path: 'src/b.ts', status: 'added', additions: 2, deletions: 0 },
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 3 },
    ],
  };

  it('renders collapsed rows only when the run is viewable', () => {
    const element = mount(completion, ['run1']);
    const header = element.querySelector('.completion-files-header');
    expect(header?.textContent).toContain('Changed files (3)');
    expect(element.querySelector('.completion-files .collapsible')?.className).not.toContain('open');

    click(header!);

    const rows = [...element.querySelectorAll('.completion-file-row')].map((row) => row.textContent);
    expect(rows[0]).toContain('src/a.ts');
    expect(rows[0]).toContain('modified');
    expect(rows[0]).toContain('+4');
    expect(rows[0]).toContain('-1');
    expect(rows[1]).toContain('added');
    expect(rows[2]).toContain('deleted');
  });

  it('hides the section when the run is not viewable or there are no changed files', () => {
    expect(mount(completion, ['other']).querySelector('.completion-files')).toBeNull();
    expect(mount(completion).querySelector('.completion-files')).toBeNull();
    expect(
      mount({ ...completion, changedFiles: [] }, ['run1']).querySelector('.completion-files'),
    ).toBeNull();
  });

  it('posts openFileDiff when a row is clicked', () => {
    const element = mount(completion, ['run1']);
    click(element.querySelector('.completion-files-header')!);
    click(element.querySelectorAll('.completion-file-row')[1]);
    expect(posted).toEqual([{ type: 'openFileDiff', path: 'src/b.ts', runId: 'run1' }]);
  });

  it('never renders the New task or View changes buttons', () => {
    const element = mount(completion, ['run1']);
    const labels = [...element.querySelectorAll('button')].map((button) => button.textContent ?? '');
    expect(labels.some((label) => label.includes('New task'))).toBe(false);
    expect(labels.some((label) => label.includes('View changes'))).toBe(false);
  });
});
