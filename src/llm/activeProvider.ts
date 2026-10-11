import type * as vscode from 'vscode';
import { DevFirstConfig, getApiKeyForPreset, getConfig } from '../config';
import { ConnectionsStore, StoredConnection } from '../session/connections';
import { createProvider } from './index';
import { ProviderPreset, effectiveBaseUrl, findPreset } from './presets';
import type { LLMProvider } from './types';
import { modelInfo, reasoningLevelsFor } from './catalog';

export interface ActiveProvider {
  preset: ProviderPreset;
  label: string;
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  reasoningLevels?: string[];
  reasoningDefault?: string;
}

export type ModelRole = 'main' | 'scanner' | 'architecture';

interface ResolvedConnection {
  preset: ProviderPreset;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

function resolve(connection: ResolvedConnection, config: DevFirstConfig): ActiveProvider {
  const baseUrl = effectiveBaseUrl(connection.preset, connection.baseUrl);
  const provider = createProvider(
    { ...config, preset: connection.preset.id, provider: connection.preset.provider, baseUrl },
    connection.apiKey,
  );
  const catalog = modelInfo(connection.preset.id, connection.model);
  return {
    preset: connection.preset,
    label: connection.preset.label,
    provider,
    baseUrl,
    model: connection.model,
    apiKey: connection.apiKey,
    reasoningLevels: reasoningLevelsFor(connection.preset.id, connection.model),
  };
}

export async function activeProvider(
  context: vscode.ExtensionContext,
): Promise<ActiveProvider | undefined> {
  const config = getConfig();
  const current = findPreset(config.preset);
  if (current) {
    const apiKey = await getApiKeyForPreset(context, current);
    if (!current.requiresKey || apiKey) {
      return resolve({ preset: current, baseUrl: config.baseUrl, model: config.model, apiKey }, config);
    }
  }

  const store = new ConnectionsStore(context.globalState);
  const connections: StoredConnection[] = store.list();
  for (const entry of connections) {
    const preset = findPreset(entry.preset);
    if (!preset) {
      continue;
    }
    const apiKey = await getApiKeyForPreset(context, preset);
    if (preset.requiresKey && !apiKey) {
      continue;
    }
    return resolve(
      {
        preset,
        baseUrl: entry.baseUrl,
        model: entry.lastModel || preset.defaultModel || '',
        apiKey,
      },
      config,
    );
  }
  return undefined;
}

/** Resolve a role without changing the active chat connection. Empty role settings inherit main. */
export async function roleProvider(
  context: vscode.ExtensionContext,
  role: Exclude<ModelRole, 'main'>,
): Promise<ActiveProvider | undefined> {
  const config = getConfig();
  const presetId = role === 'scanner' ? config.scanPreset : config.architecturePreset;
  const modelSetting = role === 'scanner'
    ? (config.scanModel.trim() || config.scanAiModel.trim())
    : config.architectureModel.trim();
  if (!presetId && !modelSetting) {
    return activeProvider(context);
  }
  const preset = findPreset(presetId || config.preset);
  if (!preset) {
    return activeProvider(context);
  }
  const store = new ConnectionsStore(context.globalState);
  const saved = store.list().find((entry) => entry.preset === preset.id);
  const apiKey = await getApiKeyForPreset(context, preset);
  if (preset.requiresKey && !apiKey) {
    return undefined;
  }
  return resolve({
    preset,
    baseUrl: saved?.baseUrl ?? (preset.id === config.preset ? config.baseUrl : ''),
    model: modelSetting || saved?.lastModel || preset.defaultModel || '',
    apiKey,
  }, config);
}
