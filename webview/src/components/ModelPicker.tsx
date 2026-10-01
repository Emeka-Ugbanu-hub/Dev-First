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

export function ModelPicker({
  connection,
  connections,
  models,
  modelsByProvider,
  modelDetailsByProvider,
  modelsError,
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
                  const modelName = (modelDetailsByProvider?.[entry.preset] ?? []).find((detail) => detail.id === model)?.name;
                  const selected = entry.preset === connection.preset && model === connection.model;
                  return (
                    <button
                      key={`${entry.preset}:${model}`}
                      className={`model-item ${selected ? 'selected' : ''}`}
                      role="option"
                      aria-selected={selected}
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
