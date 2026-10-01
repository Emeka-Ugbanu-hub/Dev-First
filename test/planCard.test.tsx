// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Plan } from '../src/shared/protocol';

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../webview/src/vscode', () => ({
  post: (message: Record<string, unknown>) => {
    sent.push(message);
  },
  vscode: { postMessage: () => undefined },
}));

import { PlanCard } from '../webview/src/components/PlanCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(plan: Plan): string {
  return renderToStaticMarkup(createElement(PlanCard, { plan, phase: 'idle', onApprove: () => undefined }));
}

function mount(plan: Plan): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(PlanCard, { plan, phase: 'idle', onApprove: () => undefined }));
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

describe('PlanCard', () => {
  it('renders nothing for explanation intents', () => {
    const html = render({
      version: 1,
      status: 'draft',
      intent: 'explanation',
      what: 'Sessions are JWT-based.',
      how: 'Login signs a token; middleware verifies it.',
      why: 'Stateless tokens avoid a shared session store.',
      tradeoff: 'Revocation is harder; a denylist adds state.',
    });
    expect(html).toBe('');
  });

  it('shows the PLAN label and never an ANSWER label', () => {
    const html = render({
      version: 1,
      status: 'draft',
      what: 'Add the endpoint',
      steps: ['Add the handler'],
    });
    expect(html).toContain('PLAN');
    expect(html).not.toContain('ANSWER');
  });

  it('shows the version badge only from v2 on', () => {
    const first = render({ version: 1, status: 'draft', what: 'Add the endpoint', steps: ['Add it'] });
    expect(first).not.toContain('plan-version');
    const second = render({ version: 2, status: 'draft', what: 'Add the endpoint', steps: ['Add it'] });
    expect(second).toContain('v2');
  });

  it('renders the leave-as-is recommendation as a quiet note', () => {
    const html = render({
      version: 1,
      status: 'draft',
      what: 'Add the endpoint',
      leaveAsIs: 'the duplicated header parsing — not worth extracting yet',
    });
    expect(html).toContain('Recommendation: leave as-is — the duplicated header parsing');
  });

  it('omits the leave-as-is note when absent', () => {
    const html = render({ version: 1, status: 'draft', what: 'Add the endpoint' });
    expect(html).not.toContain('Recommendation: leave as-is');
  });

  it('renders the convention note as a quiet line', () => {
    const html = render({
      version: 1,
      status: 'draft',
      what: 'Add the endpoint',
      convention: 'follows the handler-layer auth convention',
    });
    expect(html).toContain('plan-convention');
    expect(html).toContain('follows the handler-layer auth convention');
  });

  it('omits the convention note when absent', () => {
    const html = render({ version: 1, status: 'draft', what: 'Add the endpoint' });
    expect(html).not.toContain('plan-convention');
  });

  it('renders markdown bold and code in sections and one-liners', () => {
    const html = render({
      version: 1,
      status: 'draft',
      what: 'Use **JWT** tokens with `jsonwebtoken`.',
      convention: 'Keep **handler-layer** `auth` checks.',
      leaveAsIs: 'the **duplicated** `header` parsing',
    });
    expect(html).toContain('<strong>JWT</strong>');
    expect(html).toContain('<code>jsonwebtoken</code>');
    expect(html).toContain('<strong>handler-layer</strong>');
    expect(html).toContain('<code>auth</code>');
    expect(html).toContain('<strong>duplicated</strong>');
    expect(html).toContain('<code>header</code>');
    expect(html).not.toContain('**JWT**');
    expect(html).not.toContain('**handler-layer**');
  });

  it('places the explanation and evidence before the plan steps', () => {
    const html = render({
      version: 1,
      status: 'draft',
      what: 'Add the endpoint',
      how: 'The router calls the handler.',
      why: 'Dispatch belongs in the route layer.',
      tradeoff: 'Middleware would be more general but adds a hop.',
      context: [{ path: 'src/routes/health.ts', role: 'registers the route', startLine: 12, endLine: 24 }],
      steps: ['Register the route'],
    });
    expect(html.indexOf('HOW IT WILL WORK')).toBeLessThan(html.indexOf('WHY THIS DESIGN'));
    expect(html.indexOf('WHY THIS DESIGN')).toBeLessThan(html.indexOf('EVIDENCE CHECKED'));
    expect(html.indexOf('EVIDENCE CHECKED')).toBeLessThan(html.indexOf('TRADEOFF'));
    expect(html.indexOf('TRADEOFF')).toBeLessThan(html.indexOf('plan-todo-heading'));
  });

  it('opens context at its supporting source line', () => {
    const element = mount({
      version: 1,
      status: 'draft',
      context: [{ path: 'src/routes/health.ts', role: 'registers the route', startLine: 12, endLine: 24 }],
    });
    const button = element.querySelector('.plan-context-link');
    expect(button?.textContent).toContain('src/routes/health.ts:12-24');
    click(button!);
    expect(sent).toContainEqual({ type: 'openFile', path: 'src/routes/health.ts:12' });
  });
});

describe('PlanCard discard action', () => {
  const draft: Plan = { version: 1, status: 'draft', what: 'Add the endpoint', steps: ['Add it'] };

  it('renders the Discard plan action on a draft', () => {
    const html = render(draft);
    expect(html).toContain('Discard plan');
    expect(html).toContain('codicon-trash');
  });

  it('hides the Discard plan action once approved', () => {
    const html = render({ ...draft, status: 'approved' });
    expect(html).not.toContain('Discard plan');
  });

  it('posts discardPlan when clicked', () => {
    const element = mount(draft);
    const button = [...element.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Discard plan'),
    );
    expect(button).toBeDefined();
    click(button!);
    expect(sent).toContainEqual({ type: 'discardPlan' });
  });
});
