import { promises as fs } from 'fs';
import * as path from 'path';

export interface ModelCapabilities {
  contextWindow: number;
  maxOutput: number;
  supportsTools: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
}

export interface ModelInfo extends ModelCapabilities {
  id: string;
  name: string;
}

const DEFAULT_CAPS: ModelCapabilities = {
  contextWindow: 128_000,
  maxOutput: 16_384,
  supportsTools: true,
};

const FALLBACK_MODELS: Record<string, Partial<ModelCapabilities>> = {
  'gpt-4o': { contextWindow: 128_000, maxOutput: 16_384, supportsVision: true },
  'gpt-4o-mini': { contextWindow: 128_000, maxOutput: 16_384, supportsVision: true },
  'gpt-4.1': { contextWindow: 1_047_576, maxOutput: 32_768, supportsVision: true },
  'gpt-4.1-mini': { contextWindow: 1_047_576, maxOutput: 32_768, supportsVision: true },
  'o3': { contextWindow: 200_000, maxOutput: 100_000, supportsReasoning: true, supportsVision: true },
  'o3-mini': { contextWindow: 200_000, maxOutput: 100_000, supportsReasoning: true },
  'o4-mini': { contextWindow: 200_000, maxOutput: 100_000, supportsReasoning: true, supportsVision: true },
  'gpt-5': { contextWindow: 400_000, maxOutput: 128_000, supportsReasoning: true, supportsVision: true },
  'claude-sonnet-4-5': { contextWindow: 200_000, maxOutput: 64_000, supportsReasoning: true, supportsVision: true },
  'claude-opus-4-1': { contextWindow: 200_000, maxOutput: 32_000, supportsReasoning: true, supportsVision: true },
  'claude-3-5-sonnet': { contextWindow: 200_000, maxOutput: 8_192, supportsVision: true },
  'claude-3-7-sonnet': { contextWindow: 200_000, maxOutput: 64_000, supportsReasoning: true, supportsVision: true },
  'gemini-2.0-flash': { contextWindow: 1_048_576, maxOutput: 8_192, supportsVision: true, supportsReasoning: true },
  'gemini-2.5-pro': { contextWindow: 1_048_576, maxOutput: 65_536, supportsVision: true, supportsReasoning: true },
  'gemini-2.5-flash': { contextWindow: 1_048_576, maxOutput: 65_536, supportsVision: true, supportsReasoning: true },
  'deepseek-chat': { contextWindow: 128_000, maxOutput: 8_192 },
  'deepseek-reasoner': { contextWindow: 128_000, maxOutput: 64_000, supportsReasoning: true },
};

interface CacheShape {
  version: number;
  fetchedAt: number;
  models: Record<string, ModelInfo>;
  byProvider?: Record<string, string[]>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export class ModelRegistry {
  private models = new Map<string, ModelInfo>();
  private providerModels = new Map<string, string[]>();
  private loaded = false;

  constructor(private readonly cacheFile: string) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    await this.loadCache();
    if (this.models.size === 0) {
      await this.fetchCatalog();
    }
  }

  lookup(provider: string, modelId: string): ModelInfo | undefined {
    if (!modelId) {
      return undefined;
    }
    const normalized = normalizeModelId(modelId);
    const keys = [
      `${provider}:${normalized}`,
      normalized,
      `${provider}:${modelId.toLowerCase()}`,
      modelId.toLowerCase(),
    ];
    for (const key of keys) {
      const found = this.models.get(key);
      if (found) {
        return found;
      }
    }
    const fallback = FALLBACK_MODELS[normalized];
    if (fallback) {
      return { id: modelId, name: modelId, ...DEFAULT_CAPS, ...fallback };
    }
    return undefined;
  }

  contextWindowFor(provider: string, modelId: string, fallbackLimit: number): number {
    return this.lookup(provider, modelId)?.contextWindow ?? fallbackLimit;
  }

  providerModelIds(providerId: string): string[] {
    return this.providerModels.get(providerId.toLowerCase()) ?? [];
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await fs.readFile(this.cacheFile, 'utf-8');
      const parsed = JSON.parse(raw) as CacheShape;
      if (parsed?.version === 3 && parsed?.models && Date.now() - (parsed.fetchedAt ?? 0) < CACHE_TTL_MS) {
        for (const [key, info] of Object.entries(parsed.models)) {
          this.models.set(key, info);
        }
        for (const [providerId, ids] of Object.entries(parsed.byProvider ?? {})) {
          if (Array.isArray(ids) && ids.length > 0) {
            this.providerModels.set(providerId, ids);
          }
        }
        return;
      }
    } catch {
      // no cache
    }
    await this.fetchCatalog();
  }

  private async fetchCatalog(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch('https://models.dev/api.json', { signal: controller.signal });
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as Record<string, any>;
      const models: Record<string, ModelInfo> = {};
      const byProvider: Record<string, string[]> = {};
      for (const [providerId, provider] of Object.entries(data ?? {})) {
        const providerModels = (provider as any)?.models ?? {};
        const ids: string[] = [];
        for (const [modelId, model] of Object.entries<any>(providerModels)) {
          const info: ModelInfo = {
            id: modelId,
            name: String(model?.name ?? modelId),
            contextWindow: Number(model?.limit?.context) || DEFAULT_CAPS.contextWindow,
            maxOutput: Number(model?.limit?.output) || DEFAULT_CAPS.maxOutput,
            supportsTools: model?.tool_call !== false,
            ...(typeof model?.attachment === 'boolean' ? { supportsVision: model.attachment } : {}),
            ...(typeof model?.reasoning === 'boolean' ? { supportsReasoning: model.reasoning } : {}),
          };
          models[`${providerId}:${modelId}`.toLowerCase()] = info;
          models[modelId.toLowerCase()] = info;
          ids.push(modelId);
        }
        if (ids.length > 0) {
          byProvider[providerId.toLowerCase()] = ids;
        }
      }
      if (Object.keys(models).length > 0) {
        this.models = new Map(Object.entries(models));
        this.providerModels = new Map(Object.entries(byProvider));
        await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
        await fs.writeFile(this.cacheFile, JSON.stringify({ version: 3, fetchedAt: Date.now(), models, byProvider }));
      }
    } catch {
      // offline — fallback table covers common models
    } finally {
      clearTimeout(timer);
    }
  }
}

export function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^[a-z0-9_-]+\//, '');
}
