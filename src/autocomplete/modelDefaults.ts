const FIM_MODELS: Record<string, string> = {
  openrouter: 'mistralai/codestral-2501',
  ollama: 'qwen2.5-coder:7b',
};

export function defaultAutocompleteModel(presetId: string): string | undefined {
  return FIM_MODELS[presetId];
}

export interface AutocompleteModelResolution {
  model: string;
  kind: 'fim' | 'chat';
}

export function resolveAutocompleteModel(options: {
  presetId: string;
  configured: string;
  chatModel: string;
}): AutocompleteModelResolution {
  const configured = options.configured.trim();
  if (configured) {
    return { model: configured, kind: 'fim' };
  }
  const presetDefault = defaultAutocompleteModel(options.presetId);
  if (presetDefault) {
    return { model: presetDefault, kind: 'fim' };
  }
  return { model: options.chatModel, kind: 'chat' };
}

export function looksLikeCode(prefix: string): boolean {
  const line = prefix.split('\n').pop() ?? '';
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  if (/^(\/\/|#|\*|\/\*)/.test(trimmed)) {
    return false;
  }
  const doubleQuotes = (line.match(/"/g) ?? []).length;
  const singleQuotes = (line.match(/'/g) ?? []).length;
  const backticks = (line.match(/`/g) ?? []).length;
  return doubleQuotes % 2 === 0 && singleQuotes % 2 === 0 && backticks % 2 === 0;
}
