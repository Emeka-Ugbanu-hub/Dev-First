import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const API_URL = 'https://models.dev/api.json';

const PROVIDERS = [
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['gemini', 'google'],
  ['openrouter', 'openrouter'],
  ['groq', 'groq'],
  ['deepseek', 'deepseek'],
  ['ollama', 'ollama'],
  ['lmstudio', 'lmstudio'],
];

function limitOf(model, key) {
  const value = Number(model?.limit?.[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function capabilitiesOf(model) {
  const capabilities = [];
  if (model?.tool_call) {
    capabilities.push('tools');
  }
  const input = Array.isArray(model?.modalities?.input) ? model.modalities.input : [];
  if (model?.attachment || input.includes('image')) {
    capabilities.push('vision');
  }
  for (const modality of ['audio', 'video', 'pdf']) {
    if (input.includes(modality)) {
      capabilities.push(modality);
    }
  }
  return capabilities;
}

function reasoningOf(model) {
  if (!model?.reasoning) {
    return undefined;
  }
  const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  const effort = options.find(
    (option) => option?.type === 'effort' && Array.isArray(option.values) && option.values.length > 0,
  );
  if (effort) {
    return { kind: 'effort', values: effort.values.map(String) };
  }
  const budget = options.find((option) => option?.type === 'budget_tokens');
  if (budget) {
    return { kind: 'budget', min: Number(budget.min) || 0, max: Number(budget.max) || 0 };
  }
  return { kind: 'toggle' };
}

function trimModel(model, id) {
  const trimmed = {
    id,
    name: String(model?.name ?? id),
    contextWindow: limitOf(model, 'context'),
    maxOutput: limitOf(model, 'output'),
  };
  const reasoning = reasoningOf(model);
  if (reasoning) {
    trimmed.reasoning = reasoning;
  }
  const capabilities = capabilitiesOf(model);
  if (capabilities.length > 0) {
    trimmed.capabilities = capabilities;
  }
  return trimmed;
}

async function main() {
  let data;
  try {
    const response = await fetch(API_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    data = await response.json();
  } catch (error) {
    console.error(`Could not fetch ${API_URL}: ${error instanceof Error ? error.message : String(error)}`);
    console.error('The generator is kept; rerun it with network access. No hand-written fallback is generated.');
    process.exitCode = 1;
    return;
  }

  const catalog = {};
  const coverage = [];
  for (const [presetId, sourceId] of PROVIDERS) {
    const source = data?.[sourceId]?.models ?? {};
    const models = {};
    for (const id of Object.keys(source).sort()) {
      models[id] = trimModel(source[id], id);
    }
    catalog[presetId] = models;
    coverage.push(`${presetId}=${Object.keys(models).length}`);
  }

  const header = `export type CatalogReasoning =\n  | { kind: 'toggle' }\n  | { kind: 'effort'; values: string[] }\n  | { kind: 'budget'; min: number; max: number };\n\nexport interface CatalogModel {\n  id: string;\n  name: string;\n  contextWindow: number;\n  maxOutput: number;\n  reasoning?: CatalogReasoning;\n  capabilities?: string[];\n}\n\nexport const CATALOG: Record<string, Record<string, CatalogModel>> = `;

  const body = `${JSON.stringify(catalog, null, 2)};\n`;
  const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'llm', 'catalog.generated.ts');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, header + body, 'utf-8');

  const total = Object.values(catalog).reduce((sum, models) => sum + Object.keys(models).length, 0);
  const bytes = Buffer.byteLength(header + body, 'utf-8');
  console.log(`wrote ${target}`);
  console.log(`providers: ${coverage.join(', ')}`);
  console.log(`models: ${total}, bytes: ${bytes}`);
}

await main();
