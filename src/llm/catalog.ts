import { CATALOG, type CatalogModel, type CatalogReasoning } from './catalog.generated';
import { normalizeModelId } from './modelRegistry';

export type { CatalogModel, CatalogReasoning } from './catalog.generated';

interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export function modelsStorageKey(presetId: string): string {
  return `devFirst.models.${presetId}`;
}

export function readLiveModels(state: Pick<MementoLike, 'get'>, presetId: string): string[] {
  const stored = state.get<string[]>(modelsStorageKey(presetId));
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored.filter((model): model is string => typeof model === 'string' && model.trim().length > 0);
}

export async function storeLiveModels(
  state: Pick<MementoLike, 'update'>,
  presetId: string,
  models: string[],
): Promise<void> {
  await state.update(modelsStorageKey(presetId), models);
}

export function liveModelsUpdatedKey(presetId: string): string {
  return `devFirst.models.${presetId}.updated`;
}

export function readLiveModelsUpdatedAt(state: Pick<MementoLike, 'get'>, presetId: string): number | undefined {
  const value = state.get<number>(liveModelsUpdatedKey(presetId));
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function storeLiveModelsUpdatedAt(
  state: Pick<MementoLike, 'update'>,
  presetId: string,
  fetchedAt: number,
): Promise<void> {
  await state.update(liveModelsUpdatedKey(presetId), fetchedAt);
}

export function resolveCatalogModels(providerId: string, liveModels: string[]): string[] {
  const catalog = CATALOG[providerId] ?? {};
  const merged: string[] = [];
  const seen = new Set<string>();
  const add = (model: string) => {
    const trimmed = model.trim();
    const key = trimmed.toLowerCase();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(trimmed);
  };
  for (const model of liveModels) {
    add(model);
  }
  for (const model of Object.keys(catalog)) {
    add(model);
  }
  return merged;
}

export function modelsForProvider(providerId: string, liveModels: string[], runtimeModels: string[] = []): string[] {
  const extras = [...liveModels, ...runtimeModels];
  if (extras.length > 0) {
    return resolveCatalogModels(providerId, extras);
  }
  const catalog = CATALOG[providerId];
  return catalog ? Object.keys(catalog) : [];
}

export function modelInfo(providerId: string, modelId: string): CatalogModel | undefined {
  const catalog = CATALOG[providerId];
  if (!catalog || !modelId) {
    return undefined;
  }
  const exact = catalog[modelId];
  if (exact) {
    return exact;
  }
  const lower = modelId.trim().toLowerCase();
  if (catalog[lower]) {
    return catalog[lower];
  }
  const normalized = normalizeModelId(modelId);
  if (catalog[normalized]) {
    return catalog[normalized];
  }
  for (const [id, model] of Object.entries(catalog)) {
    if (id.toLowerCase() === lower || normalizeModelId(id) === normalized) {
      return model;
    }
  }
  return undefined;
}

export function reasoningFor(providerId: string, modelId: string): CatalogReasoning | undefined {
  return modelInfo(providerId, modelId)?.reasoning;
}

const INTERLEAVED_REASONING_CAPABILITIES = new Set([
  'interleaved',
  'interleaved-reasoning',
  'interleaved_reasoning',
  'reasoning-content',
  'reasoning_content',
]);

export function hasInterleavedReasoning(providerId: string, modelId: string): boolean {
  const capabilities = modelInfo(providerId, modelId)?.capabilities ?? [];
  return capabilities.some((capability) =>
    INTERLEAVED_REASONING_CAPABILITIES.has(capability.trim().toLowerCase()),
  );
}

export function reasoningLevelsFrom(reasoning: CatalogReasoning | undefined): string[] {
  if (!reasoning) {
    return [];
  }
  if (reasoning.kind === 'toggle') {
    return ['off', 'on'];
  }
  if (reasoning.kind === 'effort') {
    return [...reasoning.values];
  }
  return [];
}

export function reasoningLevelsFor(providerId: string, modelId: string): string[] {
  return reasoningLevelsFrom(reasoningFor(providerId, modelId));
}

export function snapReasoning(value: string, levels: string[]): string {
  if (levels.length === 0) {
    return value;
  }
  if (levels.includes(value)) {
    return value;
  }
  return levels[0];
}

const REASONING_ORDER = ['off', 'low', 'medium', 'high', 'max'];

export function reasoningRank(level: string): number | undefined {
  const index = REASONING_ORDER.indexOf(level.trim().toLowerCase());
  return index >= 0 ? index : undefined;
}

export function clampReasoningLevel(level: string, ceiling: string, levels: string[]): string {
  const requested = level.trim();
  if (!levels.includes(requested)) {
    return ceiling;
  }
  const requestedRank = reasoningRank(requested);
  const ceilingRank = reasoningRank(ceiling);
  if (requestedRank === undefined || ceilingRank === undefined) {
    return ceiling;
  }
  return requestedRank <= ceilingRank ? requested : ceiling;
}
