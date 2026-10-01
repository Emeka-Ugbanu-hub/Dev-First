import type * as vscode from 'vscode';
import type { ProviderPreset } from '../llm/presets';

export function connectionQualifies(preset: ProviderPreset, keyPresent: boolean): boolean {
  return !preset.requiresKey || keyPresent;
}

export interface StoredConnection {
  preset: string;
  baseUrl: string;
  lastModel: string;
}

export const CONNECTIONS_KEY = 'devFirst.connections';

function normalize(entry: unknown): StoredConnection | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.preset !== 'string' || !record.preset.trim()) {
    return undefined;
  }
  return {
    preset: record.preset,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
    lastModel: typeof record.lastModel === 'string' ? record.lastModel : '',
  };
}

export class ConnectionsStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): StoredConnection[] {
    const stored = this.state.get<unknown[]>(CONNECTIONS_KEY);
    if (!Array.isArray(stored)) {
      return [];
    }
    return stored
      .map((entry) => normalize(entry))
      .filter((entry): entry is StoredConnection => Boolean(entry));
  }

  get(preset: string): StoredConnection | undefined {
    return this.list().find((entry) => entry.preset === preset);
  }

  async addOrUpdate(preset: string, baseUrl: string, model: string): Promise<void> {
    const entries = this.list().filter((entry) => entry.preset !== preset);
    entries.push({ preset, baseUrl: baseUrl.trim(), lastModel: model.trim() });
    await this.state.update(CONNECTIONS_KEY, entries);
  }

  async remove(preset: string): Promise<void> {
    const entries = this.list().filter((entry) => entry.preset !== preset);
    await this.state.update(CONNECTIONS_KEY, entries);
  }
}
