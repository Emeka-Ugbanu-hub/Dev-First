import { useEffect, useMemo, useRef, useState } from 'react';
import { SETTINGS_SCHEMA, SettingDef, SettingTab } from '../../../../src/shared/settingsSchema';
import type { ProviderConnection } from '../../../../src/shared/protocol';
import { post } from '../../vscode';
import { useOverlayDismiss } from '../../lib/overlays';
import { SettingsRow } from './SettingsRow';
import { NumberInput, SelectInput, Switch, TextInput } from './controls';

const TABS: Array<{ id: SettingTab; label: string; icon: string }> = [
  { id: 'provider', label: 'Provider', icon: 'plug' },
  { id: 'behavior', label: 'Behavior', icon: 'settings' },
  { id: 'display', label: 'Display', icon: 'eye' },
  { id: 'about', label: 'About', icon: 'info' },
];

export function SettingsPanel({
  values,
  version,
  connections,
  onClose,
  onAddProvider,
  onDisconnectProvider,
  onNewSession,
}: {
  values: Record<string, unknown>;
  version: string;
  connections: ProviderConnection[];
  onClose: () => void;
  onAddProvider: () => void;
  onDisconnectProvider: (preset: string) => void;
  onNewSession: () => void;
}) {
  const [tab, setTab] = useState<SettingTab>('provider');
  const [local, setLocal] = useState<Record<string, unknown>>(values);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useOverlayDismiss(true, onClose, rootRef);

  useEffect(() => {
    setLocal(values);
  }, [values]);

  const update = (key: string, value: unknown) => {
    setLocal((previous) => ({ ...previous, [key]: value }));
    post({ type: 'updateSetting', key, value });
    setSavedKey(key);
    setTimeout(() => setSavedKey((current) => (current === key ? null : current)), 900);
  };

  const groups = useMemo(() => {
    const defs = SETTINGS_SCHEMA.filter((setting) => setting.tab === tab);
    const map = new Map<string, SettingDef[]>();
    for (const def of defs) {
      const list = map.get(def.group) ?? [];
      list.push(def);
      map.set(def.group, list);
    }
    return [...map.entries()];
  }, [tab]);

  const renderControl = (def: SettingDef) => {
    const current = local[def.key];
    switch (def.type) {
      case 'boolean':
        return <Switch checked={Boolean(current)} onChange={(value) => update(def.key, value)} />;
      case 'enum':
        return (
          <SelectInput
            value={String(current ?? def.options?.[0] ?? '')}
            options={def.options ?? []}
            onChange={(value) => update(def.key, value)}
          />
        );
      case 'number':
        return (
          <NumberInput
            value={Number(current ?? def.min ?? 0)}
            min={def.min}
            max={def.max}
            onChange={(value) => update(def.key, value)}
          />
        );
      default:
        return (
          <TextInput
            value={String(current ?? '')}
            placeholder={def.key === 'autocompleteModel' ? 'auto' : undefined}
            onChange={(value) => update(def.key, value)}
          />
        );
    }
  };

  return (
    <div className="settings-panel" ref={rootRef}>
      <div className="settings-header">
        <span className="codicon codicon-settings-gear" />
        <span className="settings-title">Settings</span>
        <span className="spacer" />
        {savedKey && (
          <span className="settings-saved">
            <span className="codicon codicon-check" /> Saved
          </span>
        )}
        <button className="btn-secondary" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="settings-body">
        <nav className="settings-tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              className={`settings-tab ${tab === entry.id ? 'active' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              <span className={`codicon codicon-${entry.icon}`} />
              <span className="settings-tab-label">{entry.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {tab === 'about' ? (
            <div className="settings-group">
              <div className="settings-group-title">ABOUT</div>
              <SettingsRow label="Version" description="Dev-First extension version.">
                <span className="settings-static">{version}</span>
              </SettingsRow>
              <SettingsRow
                label="VS Code settings"
                description="Open the raw settings editor for advanced options."
              >
                <button className="btn-secondary" onClick={() => post({ type: 'openVSCodeSettings' })}>
                  Open
                </button>
              </SettingsRow>
              <SettingsRow label="New session" description="Start a fresh conversation." last>
                <button className="btn-secondary" onClick={onNewSession}>
                  New session
                </button>
              </SettingsRow>
            </div>
          ) : (
            <>
              {tab === 'provider' && (
                <div className="settings-group">
                  <div className="settings-group-title">PROVIDERS</div>
                  {connections.length === 0 ? (
                    <SettingsRow
                      label="No providers connected"
                      description="Connect a provider to start using Dev-First."
                      last
                    >
                      <button className="btn-secondary" onClick={onAddProvider}>
                        Add provider…
                      </button>
                    </SettingsRow>
                  ) : (
                    <>
                      {connections.map((connection) => (
                        <SettingsRow
                          key={connection.preset}
                          label={connection.label}
                          description={`${connection.model || 'No model selected'}${connection.active ? ' · Active' : ''}`}
                        >
                          <button
                            className="btn-secondary"
                            onClick={() => onDisconnectProvider(connection.preset)}
                          >
                            Disconnect
                          </button>
                        </SettingsRow>
                      ))}
                      <SettingsRow
                        label="Add provider"
                        description="Connect another provider and switch from the model picker."
                        last
                      >
                        <button className="btn-secondary" onClick={onAddProvider}>
                          Add provider…
                        </button>
                      </SettingsRow>
                    </>
                  )}
                </div>
              )}
              {groups.map(([group, defs]) => (
                <div className="settings-group" key={group}>
                  <div className="settings-group-title">{group.toUpperCase()}</div>
                  {defs.map((def, index) => (
                    <SettingsRow
                      key={def.key}
                      label={def.label}
                      description={def.description}
                      last={index === defs.length - 1}
                    >
                      {renderControl(def)}
                    </SettingsRow>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
