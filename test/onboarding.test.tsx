import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionState } from '../src/shared/protocol';
import { OnboardingCard } from '../webview/src/components/OnboardingCard';

function render(connection: ConnectionState): string {
  return renderToStaticMarkup(
    createElement(OnboardingCard, {
      connection,
      connectResult: null,
      onConnect: () => undefined,
      onSetModel: () => undefined,
      onDone: () => undefined,
    }),
  );
}

describe('OnboardingCard provider selection', () => {
  it('does not preselect a provider even when config has one', () => {
    const html = render({
      preset: 'openai',
      provider: 'openai',
      model: 'gpt-4o',
      connected: false,
      needsKey: true,
    });
    expect(html).toContain('Choose a provider');
    expect(html).not.toContain('preset-tile selected');
  });

  it('stays neutral on a fresh connection state', () => {
    const html = render({ preset: '', provider: '', model: '', connected: false, needsKey: false });
    expect(html).not.toContain('preset-tile selected');
    expect(html).not.toContain('type="password"');
  });
});
