import type { ProviderId } from '../config';

export interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  provider: ProviderId;
  baseUrl?: string;
  requiresKey: boolean;
  defaultModel?: string;
  local?: boolean;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT models',
    provider: 'openai',
    requiresKey: true,
    defaultModel: 'gpt-4o',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models',
    provider: 'anthropic',
    requiresKey: true,
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini models',
    provider: 'gemini',
    requiresKey: true,
    defaultModel: 'gemini-2.0-flash',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'One key, hundreds of models',
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Fast open models',
    provider: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek models',
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Local models — no key needed',
    provider: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    requiresKey: false,
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    description: 'Local models — no key needed',
    provider: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    requiresKey: false,
    local: true,
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Any OpenAI-compatible endpoint',
    provider: 'openai',
    requiresKey: false,
  },
];

export function findPreset(id: string | undefined): ProviderPreset | undefined {
  if (!id) {
    return undefined;
  }
  return PRESETS.find((preset) => preset.id === id);
}

export function effectiveBaseUrl(preset: ProviderPreset, override: string | undefined): string {
  return override?.trim() || preset.baseUrl || '';
}

export function connectionNotice(preset: ProviderPreset): string {
  if (preset.requiresKey) {
    return `Connect ${preset.label} — add your API key in Settings → Provider.`;
  }
  return `Connect ${preset.label} in Settings → Provider.`;
}
