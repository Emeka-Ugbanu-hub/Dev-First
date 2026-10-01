import { DevFirstConfig, defaultBaseUrl } from '../config';
import { LLMProvider } from './types';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';

export function createProvider(config: DevFirstConfig, apiKey: string | undefined): LLMProvider {
  const baseUrl = config.baseUrl.trim() || defaultBaseUrl(config.provider);
  const timeouts = {
    headerMs: Math.max(0, config.headerTimeout ?? 120) * 1000,
    idleMs: Math.max(0, config.streamIdleTimeout ?? 120) * 1000,
  };
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: apiKey ?? '', baseUrl, timeouts });
    case 'gemini':
      return new GeminiProvider({ apiKey: apiKey ?? '', baseUrl, timeouts });
    default:
      return new OpenAIProvider({
        apiKey: apiKey ?? 'not-needed',
        baseUrl,
        deepSeek: config.preset === 'deepseek',
        ollama: config.preset === 'ollama',
        providerId: config.preset,
        timeouts,
      });
  }
}

export * from './types';
