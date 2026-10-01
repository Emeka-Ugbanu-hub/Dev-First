import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UiMessage } from '../src/shared/protocol';
import { Header } from '../webview/src/components/Header';
import { MessageBubble } from '../webview/src/components/MessageBubble';

function renderHeader(): string {
  return renderToStaticMarkup(
    createElement(Header, {
      phase: 'idle',
      sessions: [],
      activeSessionId: '',
      contextUsage: { tokens: 0, limit: 0 },
      onSearchClick: () => undefined,
      onSettingsClick: () => undefined,
      searchActive: false,
    }),
  );
}

describe('Header connection state', () => {
  it('does not render the connected model name', () => {
    const html = renderHeader();
    expect(html).not.toContain('claude-sonnet-4-5');
    expect(html).not.toContain('gpt-4o');
    expect(html).not.toContain('Not connected');
    expect(html).not.toContain('Change model');
  });
});

describe('MessageBubble notice action', () => {
  it('renders an Open Settings action for connection notices', () => {
    const message: UiMessage = {
      id: 'n1',
      role: 'notice',
      text: 'Connect OpenAI — add your API key in Settings → Provider.',
      action: 'openSettings',
    };
    const html = renderToStaticMarkup(createElement(MessageBubble, { message, mcpDisplay: 'markdown' }));
    expect(html).toContain('Open Settings');
  });

  it('renders plain notices without an action', () => {
    const message: UiMessage = { id: 'n2', role: 'notice', text: 'Stopped.' };
    const html = renderToStaticMarkup(createElement(MessageBubble, { message, mcpDisplay: 'markdown' }));
    expect(html).not.toContain('Open Settings');
  });
});
