import { useMemo, useState } from 'react';
import type { ConnectionState } from '../../../src/shared/protocol';
import { PRESETS, findPreset } from '../../../src/llm/presets';
import { filterModels } from '../lib/models';

export interface ConnectResult {
  ok: boolean;
  error?: string;
  models?: string[];
}

export function OnboardingCard({
  connection,
  connectResult,
  onConnect,
  onSetModel,
  onDone,
  onDismiss,
}: {
  connection: ConnectionState;
  connectResult: ConnectResult | null;
  onConnect: (preset: string, apiKey: string, baseUrl: string) => void;
  onSetModel: (model: string) => void;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const [presetId, setPresetId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [query, setQuery] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [connecting, setConnecting] = useState(false);

  const preset = useMemo(() => PRESETS.find((item) => item.id === presetId), [presetId]);
  const connectedPreset = useMemo(() => findPreset(connection.preset), [connection.preset]);
  const step = connectResult?.ok ? 'model' : 'provider';
  const models = useMemo(() => filterModels(connectResult?.models ?? [], query), [connectResult, query]);
  const showBaseUrl = preset?.id === 'custom' || Boolean(preset?.local);

  if (step === 'model') {
    return (
    <div className="onboarding anim-slide-in">
        <button className="onboarding-close" type="button" title="Close provider setup" aria-label="Close provider setup" onClick={onDismiss}>
          <span className="codicon codicon-close" />
        </button>
        <div className="onboarding-title">
          <span className="codicon codicon-check" /> Connected to{' '}
          {preset?.label ?? connectedPreset?.label ?? 'provider'}
        </div>
        <div className="onboarding-sub">Pick a model to use. You can change it anytime from the header.</div>
        <input
          className="onboarding-input"
          placeholder="Filter models…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="model-list">
          {models.length === 0 && <div className="model-empty">No models matched. Type a model id below.</div>}
          {models.slice(0, 200).map((model) => (
            <button
              key={model}
              className={`model-item ${model === connection.model ? 'selected' : ''}`}
              onClick={() => {
                onSetModel(model);
                onDone();
              }}
            >
              <span className="codicon codicon-symbol-method" />
              {model}
            </button>
          ))}
        </div>
        <div className="onboarding-row">
          <input
            className="onboarding-input"
            placeholder="Or type a model id…"
            value={customModel}
            onChange={(event) => setCustomModel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && customModel.trim()) {
                onSetModel(customModel.trim());
                onDone();
              }
            }}
          />
          <button
            className="btn-primary"
            disabled={!customModel.trim()}
            onClick={() => {
              onSetModel(customModel.trim());
              onDone();
            }}
          >
            Use
          </button>
        </div>
        {connection.model && (
          <button className="onboarding-skip" onClick={onDone}>
            Skip — keep {connection.model}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="onboarding">
      <button className="onboarding-close" type="button" title="Close provider setup" aria-label="Close provider setup" onClick={onDismiss}>
        <span className="codicon codicon-close" />
      </button>
      <div className="onboarding-title">Connect a provider</div>
      <div className="onboarding-sub">Choose where Dev-First should send requests. Local options need no key.</div>

      <div className="onboarding-label">Choose a provider</div>
      <div className="preset-grid">
        {PRESETS.map((item) => (
          <button
            key={item.id}
            className={`preset-tile ${item.id === presetId ? 'selected' : ''}`}
            onClick={() => {
              setPresetId(item.id);
              setBaseUrl('');
            }}
          >
            <span className="preset-label">{item.label}</span>
            <span className="preset-desc">{item.description}</span>
          </button>
        ))}
      </div>

      {preset?.requiresKey && (
        <input
          className="onboarding-input"
          type="password"
          placeholder={preset.provider === 'openai' ? 'API key (sk-…)' : 'API key'}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          autoComplete="off"
        />
      )}

      {showBaseUrl && preset && (
        <input
          className="onboarding-input"
          placeholder={preset.baseUrl ? `Base URL (${preset.baseUrl})` : 'Base URL (https://…/v1)'}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          spellCheck={false}
        />
      )}

      {connectResult?.error && (
        <div className="onboarding-error">
          <span className="codicon codicon-warning" /> {connectResult.error}
        </div>
      )}

      <button
        className="btn-primary onboarding-connect"
        disabled={!preset || connecting || (preset.requiresKey && !apiKey.trim())}
        onClick={() => {
          if (!preset) {
            return;
          }
          setConnecting(true);
          onConnect(preset.id, apiKey, baseUrl);
          setTimeout(() => setConnecting(false), 1500);
        }}
      >
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
    </div>
  );
}
