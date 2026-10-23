import { createHash } from 'node:crypto';
import type { Memento } from 'vscode';
import type { FileFacts } from '../scan/duplication';
import type { ChatMessage, LLMProvider } from '../llm/types';

interface CachedSummary {
  fingerprint: string;
  summary: string;
}

type SummaryStore = Record<string, CachedSummary>;
const STORE_KEY = 'devFirst.architecture.fileSummaries';

function fingerprint(fact: FileFacts, model: string): string {
  return createHash('sha1').update(JSON.stringify({ model, fact })).digest('hex');
}

function factPrompt(file: string, fact: FileFacts): string {
  return JSON.stringify({
    file,
    imports: fact.imports.map((item) => ({ specifier: item.specifier, line: item.line })),
    exports: fact.exports.map((item) => item.name),
    functions: fact.functions.map((item) => item.name),
    handlers: fact.handlers.map((item) => ({ method: item.method, path: item.pathShape, line: item.line })),
    databaseQueries: fact.sql.length,
    httpClients: fact.httpClients.map((item) => item.name),
    listeners: fact.listeners.map((item) => item.event),
  });
}

interface CachedModuleSummary {
  fingerprint: string;
  summary: string;
}

type ModuleSummaryStore = Record<string, CachedModuleSummary>;
const MODULE_STORE_KEY = 'devFirst.architecture.moduleSummaries';

export async function summarizeModules(
  provider: LLMProvider,
  model: string,
  state: Memento,
  modules: Array<{ key: string; files: Array<{ path: string; summary: string }> }>,
  signal: AbortSignal,
  onProgress?: (key: string) => void,
  cacheNamespace = 'default',
): Promise<Record<string, string>> {
  const store = state.get<ModuleSummaryStore>(MODULE_STORE_KEY) ?? {};
  const result: Record<string, string> = {};
  for (const module of modules) {
    if (signal.aborted) break;
    const fingerprint = createHash('sha1')
      .update(JSON.stringify({ model, files: module.files.map((file) => [file.path, file.summary]) }))
      .digest('hex');
    const cacheKey = `${cacheNamespace}:${module.key}`;
    const cached = store[cacheKey];
    if (cached?.fingerprint === fingerprint && cached.summary) {
      result[module.key] = cached.summary;
      continue;
    }
    onProgress?.(module.key);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'Summarize this verified code module from its file summaries. Do not invent behavior. Return one concise sentence, without markdown.',
      },
      { role: 'user', content: JSON.stringify({ module: module.key, files: module.files }) },
    ];
    let summary = '';
    try {
      for await (const event of provider.chat(messages, {
        model,
        maxTokens: 128,
        temperature: 0,
        reasoning: { enabled: false },
        signal,
      })) {
        if (event.type === 'text') summary += event.text;
      }
    } catch {
      summary = '';
    }
    summary = summary.trim().replace(/\s+/g, ' ');
    if (!summary) continue;
    store[cacheKey] = { fingerprint, summary };
    result[module.key] = summary;
    await state.update(MODULE_STORE_KEY, store);
  }
  return result;
}

export async function summarizeFiles(
  provider: LLMProvider,
  model: string,
  state: Memento,
  files: Array<{ path: string; fact: FileFacts }>,
  signal: AbortSignal,
  onProgress?: (path: string) => void,
  cacheNamespace = 'default',
): Promise<Record<string, string>> {
  const store = state.get<SummaryStore>(STORE_KEY) ?? {};
  const result: Record<string, string> = {};
  for (const file of files) {
    if (signal.aborted) break;
    const key = file.path.replace(/\\/g, '/');
    const hash = fingerprint(file.fact, model);
    const cacheKey = `${cacheNamespace}:${key}`;
    const cached = store[cacheKey];
    if (cached?.fingerprint === hash && cached.summary) {
      result[key] = cached.summary;
      continue;
    }
    onProgress?.(key);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'Summarize this source file from its verified AST facts. Do not invent behavior. Return one concise sentence, without markdown.',
      },
      { role: 'user', content: factPrompt(key, file.fact) },
    ];
    let summary = '';
    try {
      for await (const event of provider.chat(messages, {
        model,
        maxTokens: 96,
        temperature: 0,
        reasoning: { enabled: false },
        signal,
      })) {
        if (event.type === 'text') summary += event.text;
      }
    } catch {
      summary = '';
    }
    summary = summary.trim().replace(/\s+/g, ' ');
    if (!summary) continue;
    store[cacheKey] = { fingerprint: hash, summary };
    result[key] = summary;
    await state.update(STORE_KEY, store);
  }
  return result;
}
