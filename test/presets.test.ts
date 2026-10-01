import { describe, expect, it } from 'vitest';
import { PRESETS, connectionNotice, effectiveBaseUrl, findPreset } from '../src/llm/presets';

describe('findPreset', () => {
  it('finds presets by id', () => {
    expect(findPreset('openrouter')?.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(findPreset('openai')?.defaultModel).toBe('gpt-4o');
  });

  it('returns undefined for unknown or missing ids', () => {
    expect(findPreset('nope')).toBeUndefined();
    expect(findPreset(undefined)).toBeUndefined();
  });
});

describe('preset definitions', () => {
  it('marks local presets as keyless', () => {
    expect(findPreset('ollama')?.requiresKey).toBe(false);
    expect(findPreset('lmstudio')?.requiresKey).toBe(false);
    expect(findPreset('openai')?.requiresKey).toBe(true);
    expect(findPreset('anthropic')?.requiresKey).toBe(true);
  });

  it('maps every preset to a supported adapter', () => {
    for (const preset of PRESETS) {
      expect(['openai', 'anthropic', 'gemini']).toContain(preset.provider);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it('uses unique ids', () => {
    const ids = PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('effectiveBaseUrl', () => {
  it('prefers the explicit override', () => {
    const preset = findPreset('openai')!;
    expect(effectiveBaseUrl(preset, 'http://localhost:1234/v1')).toBe('http://localhost:1234/v1');
  });

  it('falls back to the preset base url', () => {
    const preset = findPreset('openrouter')!;
    expect(effectiveBaseUrl(preset, '')).toBe('https://openrouter.ai/api/v1');
    expect(effectiveBaseUrl(preset, undefined)).toBe('https://openrouter.ai/api/v1');
  });

  it('returns empty when the preset has no base url and no override', () => {
    const preset = findPreset('openai')!;
    expect(effectiveBaseUrl(preset, '')).toBe('');
  });
});

describe('connectionNotice', () => {
  it('asks for a key for presets that require one', () => {
    const notice = connectionNotice(findPreset('anthropic')!);
    expect(notice).toBe('Connect Anthropic — add your API key in Settings → Provider.');
  });

  it('never mentions keys for keyless presets', () => {
    for (const id of ['ollama', 'lmstudio']) {
      const notice = connectionNotice(findPreset(id)!);
      expect(notice).not.toMatch(/api key/i);
      expect(notice).toBe(`Connect ${findPreset(id)!.label} in Settings → Provider.`);
    }
  });
});
