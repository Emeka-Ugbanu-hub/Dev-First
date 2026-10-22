import type { CatalogReasoning } from './catalog.generated';
import type { AdaptiveReasoningKind, ReasoningEffort } from './types';

export const ANTHROPIC_ADAPTIVE_MODEL_PATTERNS: readonly RegExp[] = [
  /claude-(?:opus|sonnet)-4[-.]6/i,
  /claude-(?:opus|sonnet)-5(?:[-.]|$)/i,
];

export interface OllamaCapability {
  capabilities: string[];
  thinking: boolean;
  contextWindow?: number;
  reasoningLevels?: string[];
  reasoningDefault?: string;
}

const ollamaCapabilityCache = new Map<string, OllamaCapability>();
const ollamaOpenAIReasoningCache = new Map<string, string[]>();

export function resetOllamaCapabilityCache(): void {
  ollamaCapabilityCache.clear();
  ollamaOpenAIReasoningCache.clear();
}

/** Probe Ollama's OpenAI-compatible endpoint only when native effort levels are absent. */
export async function ollamaOpenAIReasoningLevels(baseUrl: string, modelId: string): Promise<string[]> {
  const key = `${baseUrl.replace(/\/+$/, '')}|${modelId}`;
  const cached = ollamaOpenAIReasoningCache.get(key);
  if (cached) return cached;
  const levels: string[] = [];
  try {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/v1\/?$/i, '').replace(/\/$/, '')}/v1/chat/completions`;
    url.search = '';
    url.hash = '';
    for (const effort of ['low', 'medium', 'high']) {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply with one word.' }],
          max_tokens: 1,
          stream: false,
          reasoning_effort: effort,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) levels.push(effort);
    }
    ollamaOpenAIReasoningCache.set(key, levels);
    return levels;
  } catch {
    ollamaOpenAIReasoningCache.set(key, levels);
    return levels;
  }
}

export function isAnthropicAdaptiveModel(modelId: string): boolean {
  return ANTHROPIC_ADAPTIVE_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

export function isDynamicBudget(reasoning: CatalogReasoning | undefined): boolean {
  if (reasoning?.kind !== 'budget') {
    return false;
  }
  return reasoning.min === -1 || reasoning.max === -1;
}

export function hasImplicitEffort(reasoning: CatalogReasoning | undefined): boolean {
  if (reasoning?.kind !== 'effort') {
    return false;
  }
  return reasoning.values.some((value) => value === 'default' || value === 'auto');
}

export function adaptiveKind(
  providerId: string,
  modelId: string,
  catalogInfo?: { reasoning?: CatalogReasoning } | undefined,
): AdaptiveReasoningKind | undefined {
  if (providerId === 'anthropic' && isAnthropicAdaptiveModel(modelId)) {
    return 'anthropic-adaptive';
  }
  const reasoning = catalogInfo?.reasoning;
  if (providerId === 'gemini' && isDynamicBudget(reasoning)) {
    return 'gemini-dynamic';
  }
  if (hasImplicitEffort(reasoning)) {
    if (providerId === 'anthropic') {
      return 'anthropic-adaptive';
    }
    if (providerId === 'gemini') {
      return 'gemini-dynamic';
    }
    return 'toggle';
  }
  if (reasoning?.kind === 'toggle') {
    return 'toggle';
  }
  return undefined;
}

export function adaptiveEffort(effort: ReasoningEffort | undefined): boolean {
  return effort === 'high' || effort === 'max' || effort === 'default' || effort === 'auto';
}

export async function fetchOllamaCapability(
  baseUrl: string,
  modelId: string,
): Promise<OllamaCapability | undefined> {
  const key = `${baseUrl.replace(/\/+$/, '')}|${modelId}`;
  const cached = ollamaCapabilityCache.get(key);
  if (cached) {
    return cached;
  }
  try {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/v1\/?$/i, '').replace(/\/$/, '')}/api/show`;
    url.search = '';
    url.hash = '';
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return undefined;
    }
    const json = (await response.json()) as {
      capabilities?: unknown;
      thinking?: { values?: unknown; default?: unknown };
      parameters?: unknown;
      model_info?: unknown;
    };
    // Ollama reports the base model's maximum in model_info, but a Modelfile
    // can lower the effective runtime context with `PARAMETER num_ctx N`.
    // Use the explicit runtime setting when it is present.
    const configuredContext = parseOllamaNumCtx(json.parameters);
    const contextWindow = configuredContext ?? findContextWindow(json.model_info);
    const capabilities = Array.isArray(json.capabilities)
      ? json.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    const advertised = capabilities.includes('thinking');
    const rawValues = Array.isArray(json.thinking?.values) ? json.thinking.values : undefined;
    const allBooleans = Boolean(rawValues?.length) && rawValues!.every((value) => typeof value === 'boolean');
    const allStrings = Boolean(rawValues?.length) && rawValues!.every((value) => typeof value === 'string');
    const mapped = rawValues?.length === 1 && rawValues[0] === false
      ? []
      : allBooleans
        ? rawValues!.map((value) => value ? 'on' : 'off')
        : allStrings
          ? rawValues!.map((value) => String(value))
          : undefined;
    const levels = mapped && mapped.length > 0 ? mapped : advertised ? ['off', 'on'] : undefined;
    const defaultValue = json.thinking?.default;
    const info: OllamaCapability = {
      capabilities,
      thinking: advertised || (mapped?.length ?? 0) > 0,
      ...(contextWindow ? { contextWindow } : {}),
      ...(levels ? { reasoningLevels: levels } : {}),
      ...(typeof defaultValue === 'boolean'
        ? { reasoningDefault: defaultValue ? 'on' : 'off' }
        : typeof defaultValue === 'string' ? { reasoningDefault: defaultValue } : {}),
    };
    ollamaCapabilityCache.set(key, info);
    return info;
  } catch {
    return undefined;
  }
}

function parseOllamaNumCtx(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /(?:^|\n)\s*num_ctx\s+(\d+)/i.exec(value);
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

/** Read only an explicitly advertised context length; never infer it from a model name. */
function findContextWindow(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[-.]/g, '_');
    const leaf = normalized.split('_').pop() === 'length' ? normalized.slice(normalized.lastIndexOf('_') + 1) : normalized;
    if ((normalized === 'context_length' || normalized.endsWith('_context_length')
      || normalized === 'context_window' || normalized.endsWith('_context_window')
      || leaf === 'num_ctx' || leaf === 'n_ctx')
      && typeof entry === 'number' && Number.isFinite(entry) && entry > 0) {
      return Math.floor(entry);
    }
    const nested = findContextWindow(entry);
    if (nested) return nested;
  }
  return undefined;
}
