import type { ModelMetadata } from '../shared/protocol';
import { fetchOllamaCapability } from './adaptive';

type LmStudioModel = {
  key?: unknown;
  display_name?: unknown;
  type?: unknown;
  capabilities?: {
    vision?: unknown;
    reasoning?: { allowed_options?: unknown; default?: unknown };
  };
};

function apiUrl(baseUrl: string, route: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/i, '').replace(/\/$/, '');
  url.pathname = `${url.pathname}${route}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Fetch richer metadata for local providers whose native API exposes it. */
export async function fetchModelMetadata(
  presetId: string,
  baseUrl: string,
  apiKey?: string,
): Promise<Record<string, ModelMetadata>> {
  if (presetId === 'ollama') return fetchOllamaMetadata(baseUrl);
  if (presetId !== 'lmstudio') return {};
  try {
    const response = await fetch(apiUrl(baseUrl, '/api/v1/models'), {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return {};
    const json = (await response.json()) as { models?: LmStudioModel[] };
    const details: Record<string, ModelMetadata> = {};
    for (const model of json.models ?? []) {
      const id = typeof model.key === 'string' ? model.key : '';
      if (!id || model.type === 'embedding') continue;
      const reasoning = model.capabilities?.reasoning;
      const levels = Array.isArray(reasoning?.allowed_options)
        ? reasoning.allowed_options.filter((item): item is string => typeof item === 'string')
        : undefined;
      details[id] = {
        id,
        ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}),
        ...(typeof model.capabilities?.vision === 'boolean' ? { supportsVision: model.capabilities.vision } : {}),
        ...(levels && levels.length > 0 ? { reasoningLevels: levels } : {}),
        ...(typeof reasoning?.default === 'string' ? { reasoningDefault: reasoning.default } : {}),
      };
    }
    return details;
  } catch {
    return {};
  }
}

async function fetchOllamaMetadata(baseUrl: string): Promise<Record<string, ModelMetadata>> {
  try {
    const response = await fetch(apiUrl(baseUrl, '/api/tags'), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return {};
    const json = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const models = (json.models ?? []).map((entry) => entry.model ?? entry.name).filter((id): id is string => Boolean(id));
    const details: Record<string, ModelMetadata> = {};
    await Promise.all(models.map(async (id) => {
      const capability = await fetchOllamaCapability(baseUrl, id);
      if (!capability) return;
      details[id] = {
        id,
        ...(capability.capabilities.length ? { supportsVision: capability.capabilities.includes('vision') } : {}),
        ...(capability.reasoningLevels?.length ? { reasoningLevels: capability.reasoningLevels } : {}),
        ...(capability.reasoningDefault ? { reasoningDefault: capability.reasoningDefault } : {}),
      };
    }));
    return details;
  } catch {
    return {};
  }
}
