import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionState, ProviderConnection } from '../src/shared/protocol';
import { ModelPicker, modelSelectionMessage } from '../webview/src/components/ModelPicker';
import { SettingsPanel } from '../webview/src/components/settings/SettingsPanel';

const connection: ConnectionState = {
  preset: 'openai',
  provider: 'openai',
  model: 'gpt-4o',
  connected: true,
  needsKey: false,
};

const connections: ProviderConnection[] = [
  { preset: 'openai', label: 'OpenAI', model: 'gpt-4o', active: true },
  { preset: 'anthropic', label: 'Anthropic', model: 'claude-sonnet-4-5', active: false },
];

function renderPicker(overrides: Partial<Parameters<typeof ModelPicker>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ModelPicker, {
      connection,
      connections,
      models: ['gpt-4o', 'gpt-4o-mini'],
      modelsByProvider: { anthropic: ['claude-sonnet-4-5', 'claude-haiku'] },
      onAddProvider: () => undefined,
      onClose: () => undefined,
      ...overrides,
    }),
  );
}

describe('ModelPicker provider groups', () => {
  it('groups models under every connected provider', () => {
    const html = renderPicker();
    expect(html).toContain('OpenAI');
    expect(html).toContain('Anthropic');
    expect(html).toContain('gpt-4o-mini');
    expect(html).toContain('claude-sonnet-4-5');
    expect(html).not.toContain('Gemini');
  });

  it('marks the active provider and the current model', () => {
    const html = renderPicker();
    expect(html).toContain('active');
    expect(html).toContain('selected');
    const checkCount = html.split('model-item-check').length - 1;
    expect(checkCount).toBe(1);
  });

  it('shows the no-model empty state with an add action when nothing is connected', () => {
    const html = renderPicker({ connection: { ...connection, preset: '', model: '' }, connections: [], models: [] });
    expect(html).toContain('No model connected');
    expect(html).toContain('Add provider');
    expect(html).not.toContain('Search models');
  });

  it('keeps a flat list for a single connection', () => {
    const html = renderPicker({ connections: [connections[0]] });
    expect(html).toContain('gpt-4o');
    expect(html).not.toContain('model-group-title');
  });
});

describe('modelSelectionMessage', () => {
  it('sets the model in place for the active provider', () => {
    expect(modelSelectionMessage('openai', 'gpt-4o', 'openai')).toEqual({ type: 'setModel', model: 'gpt-4o' });
  });

  it('switches providers when selecting from another group', () => {
    expect(modelSelectionMessage('anthropic', 'claude-haiku', 'openai')).toEqual({
      type: 'setProvider',
      preset: 'anthropic',
      model: 'claude-haiku',
    });
  });
});

describe('SettingsPanel provider tab', () => {
  function renderSettings(list: ProviderConnection[]): string {
    return renderToStaticMarkup(
      createElement(SettingsPanel, {
        values: {},
        version: '0.1.0',
        connections: list,
        onClose: () => undefined,
        onAddProvider: () => undefined,
        onDisconnectProvider: () => undefined,
        onNewSession: () => undefined,
      }),
    );
  }

  it('lists every connection with a disconnect action and an add action', () => {
    const html = renderSettings(connections);
    expect(html).toContain('OpenAI');
    expect(html).toContain('Anthropic');
    expect(html).toContain('claude-sonnet-4-5');
    expect(html).toContain('Disconnect');
    expect(html).toContain('Add provider');
  });

  it('shows an add action when no provider is connected', () => {
    const html = renderSettings([]);
    expect(html).toContain('No providers connected');
    expect(html).toContain('Add provider');
  });
});
