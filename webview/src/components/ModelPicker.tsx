import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionState, ModelMetadata, ProviderConnection, WebviewMessage } from '../../../src/shared/protocol';
import { post } from '../vscode';
import { filterModels } from '../lib/models';
import { isEscapeKey, useOverlayDismiss } from '../lib/overlays';

export function modelSelectionMessage(preset: string, model: string, activePreset: string): WebviewMessage {
  if (preset === activePreset) {
    return { type: 'setModel', model };
  }
  return { type: 'setProvider', preset, model };
}

const ALIAS_SIBLINGS: Record<string, { prefix: string; exclude?: string[] }> = {
  'deepseek-chat': { prefix: 'deepseek-chat-' },
  'deepseek-reasoner': { prefix: 'deepseek-r1-', exclude: ['distill'] },
};

function versionScore(modelId: string): { dotted: boolean; parts: number[] } {
  const dotted = modelId.match(/v(\d+(?:\.\d+)+)/i);
  if (dotted) {
    return { dotted: true, parts: dotted[1].split('.').map((part) => Number(part)) };
  }
  const digits = modelId.match(/\d+/g);
  return { dotted: false, parts: digits ? digits.map((part) => Number(part)) : [] };
}

function compareScores(a: { dotted: boolean; parts: number[] }, b: { dotted: boolean; parts: number[] }): number {
  if (a.dotted !== b.dotted) {
    return a.dotted ? 1 : -1;
  }
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.parts[index] ?? 0;
    const right = b.parts[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }
  return 0;
}

export function latestVersionedSibling(aliasId: string, models: string[]): string | undefined {
  const rule = ALIAS_SIBLINGS[aliasId.toLowerCase()];
  if (!rule) {
    return undefined;
  }
  const candidates = models.filter((model) => {
    const lower = model.toLowerCase();
    return lower.startsWith(rule.prefix) && !(rule.exclude ?? []).some((part) => lower.includes(part));
  });
  if (candidates.length === 0) {
    return undefined;
  }
  return [...candidates].sort((a, b) => compareScores(versionScore(a), versionScore(b))).at(-1);
}

export function formatAge(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export function ModelPicker({
  connection,
  connections,
  models,
  modelsByProvider,
  modelDetailsByProvider,
  modelsError,
  modelsUpdatedAtByProvider,
  modelsLiveFailedByProvider,
  anchorRight,
  onAddProvider,
  onClose,
}: {
  connection: ConnectionState;
  connections: ProviderConnection[];
  models: string[];
  modelsByProvider?: Record<string, string[]>;
  modelDetailsByProvider?: Record<string, ModelMetadata[]>;
  modelsError?: string;
  modelsUpdatedAtByProvider?: Record<string, number>;
  modelsLiveFailedByProvider?: Record<string, boolean>;
  anchorRight?: number;
  onAddProvider: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState('');
  const [loading, setLoading] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  useOverlayDismiss(true, onClose, rootRef);
  const grouped = connections.length > 1;
  const noConnections = connections.length === 0;

  useEffect(() => {
    post({ type: 'fetchModels', preset: connection.preset });
    for (const entry of connections) {
      if (entry.preset !== connection.preset) {
        post({ type: 'fetchModels', preset: entry.preset });
      }
    }
    const timer = setTimeout(() => setLoading(false), 8000);
    return () => clearTimeout(timer);
  }, [connection.preset]);

  useEffect(() => {
    if (models.length > 0 || modelsError) {
      setLoading(false);
    }
  }, [models, modelsError]);

  const groups = useMemo(
    () =>
      connections.map((entry) => {
        const list = entry.preset === connection.preset ? models : modelsByProvider?.[entry.preset] ?? [];
        const details = modelDetailsByProvider?.[entry.preset] ?? [];
        const names = new Map(details.map((detail) => [detail.id, detail.name ?? detail.id]));
        return { entry, all: list, models: filterModels(list, query, names) };
      }),
    [connections, connection.preset, models, modelsByProvider, modelDetailsByProvider, query],
  );
  const totalModels = groups.reduce((sum, group) => sum + group.all.length, 0);
  const totalFiltered = groups.reduce((sum, group) => sum + group.models.length, 0);
  const visibleGroups = groups.filter((group) => group.models.length > 0);

  return (
    <>
      <button type="button" className="df-backdrop" aria-label="Close model picker" onClick={onClose} />
      <div className="model-picker anim-scale-in" ref={rootRef} style={anchorRight === undefined ? undefined : { right: anchorRight }}>
      <div className="model-picker-header">
        <span className="model-picker-title">
          <span className="codicon codicon-symbol-method" /> {noConnections ? 'Models' : connection.provider}
        </span>
        <button
          className="icon-btn"
          title="Refresh models"
          aria-label="Refresh models"
          onClick={() => {
            setLoading(true);
            for (const entry of connections) {
              post({ type: 'fetchModels', preset: entry.preset });
            }
          }}
        >
          <span className="codicon codicon-refresh" />
        </button>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
          <span className="codicon codicon-close" />
        </button>
      </div>
      {noConnections ? (
        <div className="model-empty model-empty-connect">
          <span>No model connected</span>
          <button className="btn-primary" onClick={onAddProvider}>
            Add provider
          </button>
        </div>
      ) : (
        <>
          <input
            className="onboarding-input"
            placeholder="Search models…"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (isEscapeKey(event.key)) {
                onClose();
              }
            }}
          />
          {(modelsUpdatedAtByProvider?.[connection.preset] || modelsLiveFailedByProvider?.[connection.preset]) && (
            <div className="model-freshness">
              {modelsUpdatedAtByProvider?.[connection.preset] && (
                <span>Updated {formatAge(modelsUpdatedAtByProvider[connection.preset]!)}</span>
              )}
              {modelsLiveFailedByProvider?.[connection.preset] && (
                <span className="model-stale">Live refresh failed — showing cached models</span>
              )}
            </div>
          )}
          <div className="model-list" role="listbox" aria-label="Models">
            {loading && totalModels === 0 && (
              <div className="model-skeleton">
                {[0, 1, 2, 3, 4].map((index) => (
                  <div className="skeleton-row" key={index} />
                ))}
              </div>
            )}
            {!loading && totalModels === 0 && modelsError && <div className="model-empty">{modelsError}</div>}
            {!loading && totalModels === 0 && !modelsError && (
              <div className="model-empty">Could not fetch models — type a model id.</div>
            )}
            {!loading && totalModels > 0 && totalFiltered === 0 && (
              <div className="model-empty">No models matched.</div>
            )}
            {visibleGroups.map(({ entry, models: list }) => (
              <div className="model-group" key={entry.preset}>
                {grouped && (
                  <div className="model-group-title">
                    <span className="codicon codicon-symbol-namespace" />
                    {entry.label}
                    {entry.active && <span className="model-group-badge">active</span>}
                  </div>
                )}
                {list.slice(0, 200).map((model) => {
                  const details = modelDetailsByProvider?.[entry.preset] ?? [];
                  const modelName = details.find((detail) => detail.id === model)?.name;
                  const sibling = latestVersionedSibling(model, list);
                  const siblingName = sibling ? details.find((detail) => detail.id === sibling)?.name ?? sibling : undefined;
                  const selected = entry.preset === connection.preset && model === connection.model;
                  return (
                    <button
                      key={`${entry.preset}:${model}`}
                      className={`model-item ${selected ? 'selected' : ''}`}
                      role="option"
                      aria-selected={selected}
                      title={siblingName ? `API alias — newest versioned model: ${siblingName}` : undefined}
                      onClick={() => {
                        post(modelSelectionMessage(entry.preset, model, connection.preset));
                        onClose();
                      }}
                    >
                      <span className="codicon codicon-symbol-method" />
                      {modelName && modelName !== model ? <><span>{modelName}</span><small className="model-item-id">{model}</small></> : model}
                      {selected && <span className="codicon codicon-check model-item-check" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="onboarding-row">
            <input
              className="onboarding-input"
              placeholder="Or type a model id…"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && custom.trim()) {
                  post({ type: 'setModel', model: custom.trim() });
                  onClose();
                }
              }}
            />
            <button
              className="btn-primary"
              disabled={!custom.trim()}
              onClick={() => {
                post({ type: 'setModel', model: custom.trim() });
                onClose();
              }}
            >
              Use
            </button>
          </div>
        </>
      )}
      </div>
    </>
  );
}
