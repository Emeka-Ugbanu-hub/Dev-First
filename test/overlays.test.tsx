import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import * as path from 'path';
import type { SessionSummary } from '../src/shared/protocol';
import { isEscapeKey, isOutsideTarget } from '../webview/src/lib/overlays';
import { SessionTabStrip } from '../webview/src/components/SessionTabStrip';
import { ModelPicker } from '../webview/src/components/ModelPicker';

const css = readFileSync(path.join(__dirname, '..', 'webview', 'src', 'styles.css'), 'utf-8');

function ruleFor(selector: string): string {
  const match = css.match(new RegExp(`${selector}\\s*{([^}]*)}`));
  return match ? match[1] : '';
}

function rootVar(name: string): number {
  const root = ruleFor(':root');
  const match = root.match(new RegExp(`${name}:\\s*(\\d+)`));
  return match ? Number(match[1]) : NaN;
}

const sessions: SessionSummary[] = [
  { id: 's1', title: 'First', createdAt: 1, updatedAt: 2, messageCount: 3 },
  { id: 's2', title: 'Second', createdAt: 1, updatedAt: 2, messageCount: 5 },
];

function containerFor(inside: unknown) {
  return {
    contains(node: unknown) {
      return node === inside;
    },
  };
}

describe('sessions history dropdown dismissal', () => {
  it('treats a pointer outside the popover as a close', () => {
    const inside = { tag: 'input' };
    const outside = { tag: 'body' };
    expect(isOutsideTarget(outside as never, containerFor(inside) as never)).toBe(true);
  });

  it('ignores a pointer inside the popover', () => {
    const inside = { tag: 'input' };
    expect(isOutsideTarget(inside as never, containerFor(inside) as never)).toBe(false);
  });

  it('closes on Escape and not on other keys', () => {
    expect(isEscapeKey('Escape')).toBe(true);
    expect(isEscapeKey('Enter')).toBe(false);
    expect(isEscapeKey('a')).toBe(false);
  });

  it('renders a backdrop and a fully visible search input when open', () => {
    const html = renderToStaticMarkup(
      createElement(SessionTabStrip, { sessions, activeId: 's1', initialOpen: true }),
    );
    expect(html).toContain('df-backdrop');
    expect(html).toContain('history-popover');
    expect(html).toContain('Search sessions');
  });
});

describe('model picker dismissal', () => {
  it('treats a pointer outside the picker as a close', () => {
    const inside = { tag: 'picker' };
    const outside = { tag: 'header' };
    expect(isOutsideTarget(outside as never, containerFor(inside) as never)).toBe(true);
    expect(isOutsideTarget(inside as never, containerFor(inside) as never)).toBe(false);
  });

  it('closes on Escape', () => {
    expect(isEscapeKey('Escape')).toBe(true);
  });

  it('renders a backdrop behind the picker', () => {
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        connection: { preset: 'openai', provider: 'openai', model: 'gpt-4o', connected: true, needsKey: false },
        connections: [{ preset: 'openai', label: 'OpenAI', model: 'gpt-4o', active: true }],
        models: ['gpt-4o'],
        onAddProvider: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('df-backdrop');
    expect(html).toContain('model-picker');
  });
});

describe('overlay z-index scale', () => {
  it('orders menus below dropdowns below modals below the lightbox', () => {
    const menu = rootVar('--df-z-menu');
    const backdrop = rootVar('--df-z-backdrop');
    const dropdown = rootVar('--df-z-dropdown');
    const panel = rootVar('--df-z-panel');
    const modal = rootVar('--df-z-modal');
    const lightbox = rootVar('--df-z-lightbox');
    for (const value of [menu, backdrop, dropdown, panel, modal, lightbox]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(menu).toBeLessThan(backdrop);
    expect(backdrop).toBeLessThan(dropdown);
    expect(dropdown).toBeLessThan(panel);
    expect(panel).toBeLessThan(modal);
    expect(modal).toBeLessThan(lightbox);
  });

  it('places overlays on the scale instead of raw values', () => {
    expect(ruleFor('.history-popover')).toContain('var(--df-z-dropdown)');
    expect(ruleFor('.model-picker')).toContain('var(--df-z-dropdown)');
    expect(ruleFor('.modal-backdrop')).toContain('var(--df-z-modal)');
    expect(ruleFor('.lightbox')).toContain('var(--df-z-lightbox)');
    expect(ruleFor('.df-backdrop')).toContain('var(--df-z-backdrop)');
  });

  it('keeps the dismissal backdrop below dropdowns so clicks reach them', () => {
    expect(rootVar('--df-z-backdrop')).toBeLessThan(rootVar('--df-z-dropdown'));
  });
});

describe('overlay clipping', () => {
  it('fixes dropdowns to the viewport so overflow ancestors cannot cut them', () => {
    expect(ruleFor('.history-popover')).toContain('position: fixed');
    expect(ruleFor('.model-picker')).toContain('position: fixed');
    expect(ruleFor('.df-backdrop')).toContain('position: fixed');
  });

  it('sizes dropdowns against the viewport instead of a small parent', () => {
    expect(ruleFor('.history-popover')).not.toContain('max-height: 70%');
    expect(ruleFor('.model-picker')).not.toContain('max-height: 70%');
    expect(ruleFor('.history-popover')).toContain('100vh');
    expect(ruleFor('.model-picker')).toContain('100vh');
  });
});
