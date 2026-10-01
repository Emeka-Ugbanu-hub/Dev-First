import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionState, ProviderConnection } from '../src/shared/protocol';
import { ModelPicker, formatAge, latestVersionedSibling, modelSelectionMessage } from '../webview/src/components/ModelPicker';
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

describe('model freshness and aliases', () => {
  it('shows when the list was last updated', () => {
    const html = renderPicker({
      modelsUpdatedAtByProvider: { openai: Date.now() - 3 * 60 * 60 * 1000 },
    });
    expect(html).toContain('Updated 3h ago');
  });

  it('warns when the live refresh failed but cached models are shown', () => {
    const html = renderPicker({ modelsLiveFailedByProvider: { openai: true } });
    expect(html).toContain('Live refresh failed');
  });

  it('offers a refresh action', () => {
    const html = renderPicker();
    expect(html).toContain('Refresh models');
  });

  it('labels a DeepSeek alias with its newest versioned sibling', () => {
    const html = renderPicker({
      connection: { preset: 'deepseek', provider: 'deepseek', model: 'deepseek-chat', connected: true, needsKey: false },
      connections: [{ preset: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', active: true }],
      models: ['deepseek-chat', 'deepseek-chat-v3.2'],
    });
    expect(html).toContain('newest versioned model');
  });

  it('formats freshness ages', () => {
    const now = Date.now();
    expect(formatAge(now - 10_000, now)).toBe('just now');
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAge(now - 3 * 60 * 60_000, now)).toBe('3h ago');
    expect(formatAge(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });
});

describe('latestVersionedSibling', () => {
  it('picks the newest dotted version for the chat alias', () => {
    expect(
      latestVersionedSibling('deepseek-chat', [
        'deepseek-chat',
        'deepseek-chat-v3-0324',
        'deepseek-chat-v3.1',
        'deepseek-chat-v3.2',
      ]),
    ).toBe('deepseek-chat-v3.2');
  });

  it('skips distill variants for the reasoner alias', () => {
    expect(
      latestVersionedSibling('deepseek-reasoner', [
        'deepseek-reasoner',
        'deepseek-r1-distill-llama-70b',
        'deepseek-r1-0528',
      ]),
    ).toBe('deepseek-r1-0528');
  });

  it('returns nothing for unknown aliases or missing siblings', () => {
    expect(latestVersionedSibling('gpt-4o', ['gpt-4o-mini'])).toBeUndefined();
    expect(latestVersionedSibling('deepseek-chat', ['deepseek-chat'])).toBeUndefined();
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
