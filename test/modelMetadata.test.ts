import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModelMetadata } from '../src/llm/modelMetadata';

afterEach(() => vi.unstubAllGlobals());

describe('fetchModelMetadata', () => {
  it('reads LM Studio names, vision support, exact reasoning options, and default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{
        type: 'llm',
        key: 'publisher/model-q4',
        display_name: 'Model Q4',
        capabilities: { vision: true, reasoning: { allowed_options: ['low', 'high'], default: 'low' } },
      }],
    }), { status: 200 })));

    await expect(fetchModelMetadata('lmstudio', 'http://localhost:1234/v1')).resolves.toEqual({
      'publisher/model-q4': {
        id: 'publisher/model-q4',
        name: 'Model Q4',
        supportsVision: true,
        reasoningLevels: ['low', 'high'],
        reasoningDefault: 'low',
      },
    });
  });

  it('reads Ollama image and thinking capabilities without inventing choices', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capabilities: ['completion', 'vision'],
        thinking: { values: ['low', 'medium', 'high'], default: 'medium' },
      }), { status: 200 })));

    await expect(fetchModelMetadata('ollama', 'http://localhost:11434/v1')).resolves.toEqual({
      'qwen3:8b': {
        id: 'qwen3:8b',
        supportsVision: true,
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'medium',
      },
    });
  });

  it('derives a toggle when Ollama advertises thinking without explicit values', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'thinking-model' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capabilities: ['completion', 'thinking'],
      }), { status: 200 })));

    await expect(fetchModelMetadata('ollama', 'http://localhost:22434/v1')).resolves.toEqual({
      'thinking-model': {
        id: 'thinking-model',
        supportsVision: false,
        reasoningLevels: ['off', 'on'],
      },
    });
  });

  it('hides reasoning for Ollama models without thinking capability', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'plain-model' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        capabilities: ['completion', 'vision'],
      }), { status: 200 })));

    await expect(fetchModelMetadata('ollama', 'http://localhost:32434/v1')).resolves.toEqual({
      'plain-model': {
        id: 'plain-model',
        supportsVision: true,
      },
    });
  });

  it('leaves unknown providers without guessed metadata', async () => {
    await expect(fetchModelMetadata('custom', 'http://localhost:1234/v1')).resolves.toEqual({});
  });
});
