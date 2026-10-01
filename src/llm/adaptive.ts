import type { CatalogReasoning } from './catalog.generated';
import type { AdaptiveReasoningKind, ReasoningEffort } from './types';

export const ANTHROPIC_ADAPTIVE_MODEL_PATTERNS: readonly RegExp[] = [
  /claude-(?:opus|sonnet)-4[-.]6/i,
  /claude-(?:opus|sonnet)-5(?:[-.]|$)/i,
];

export interface OllamaCapability {
  capabilities: string[];
  thinking: boolean;
  reasoningLevels?: string[];
  reasoningDefault?: string;
}

const ollamaCapabilityCache = new Map<string, OllamaCapability>();

export function resetOllamaCapabilityCache(): void {
  ollamaCapabilityCache.clear();
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
    };
    const capabilities = Array.isArray(json.capabilities)
      ? json.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    const advertised = capabilities.includes('thinking');
    const rawValues = Array.isArray(json.thinking?.values) ? json.thinking.values : undefined;
    const mapped = rawValues?.length === 1 && rawValues[0] === false
      ? []
      : rawValues?.map((value) => value === true ? 'on' : value === false ? 'off' : String(value));
    const levels = mapped && mapped.length > 0 ? mapped : advertised ? ['off', 'on'] : undefined;
    const defaultValue = json.thinking?.default;
    const info: OllamaCapability = {
      capabilities,
      thinking: advertised || (mapped?.length ?? 0) > 0,
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
