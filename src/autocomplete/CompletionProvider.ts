import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { fetchFim } from './FimClient';
import { fetchChatCompletion } from './ChatFallback';
import { looksLikeCode, resolveAutocompleteModel } from './modelDefaults';
import { defaultBaseUrl, getApiKeyForPreset, getConfig } from '../config';
import { PRESETS, effectiveBaseUrl, findPreset } from '../llm/presets';
import { createProvider } from '../llm';

const MAX_CACHE = 50;
const FIM_THROTTLE_MS = 150;
const CHAT_THROTTLE_MS = 1000;
const NOTICE_KEY = 'devFirst.autocompleteNoticeShown';

export class FimCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new Map<string, string>();
  private lastFimRequest = 0;
  private lastChatRequest = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = getConfig();
    if (!config.autocomplete || document.uri.scheme !== 'file' || document.lineCount > 20_000) {
      return undefined;
    }

    const offset = document.offsetAt(position);
    const prefix = document.getText(new vscode.Range(document.positionAt(Math.max(0, offset - 2500)), position));
    const suffix = document.getText(
      new vscode.Range(position, document.positionAt(Math.min(document.getText().length, offset + 1000))),
    );
    if (prefix.trim().length < 8) {
      return undefined;
    }

    const preset = findPreset(config.preset) ?? PRESETS[0];
    const resolution = resolveAutocompleteModel({
      presetId: preset.id,
      configured: config.autocompleteModel,
      chatModel: config.model,
    });

    const cacheKey = createHash('sha1')
      .update(`${resolution.kind}:${resolution.model}:${preset.id}:${prefix.slice(-400)}:${suffix.slice(0, 200)}`)
      .digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))];
    }

    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    try {
      const completion = await this.produce(preset, resolution, config, prefix, suffix, abort.signal);
      if (!completion || token.isCancellationRequested) {
        if (!completion) {
          this.maybeNotify(preset.label);
        }
        return undefined;
      }
      this.cache.set(cacheKey, completion);
      if (this.cache.size > MAX_CACHE) {
        const oldest = this.cache.keys().next().value;
        if (oldest) {
          this.cache.delete(oldest);
        }
      }
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch {
      return undefined;
    } finally {
      cancellation.dispose();
    }
  }

  private async produce(
    preset: ReturnType<typeof findPreset> & object,
    resolution: { model: string; kind: 'fim' | 'chat' },
    config: ReturnType<typeof getConfig>,
    prefix: string,
    suffix: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const apiKey = await getApiKeyForPreset(this.context, preset);
    const baseUrl = effectiveBaseUrl(preset, config.baseUrl) || defaultBaseUrl(preset.provider);

    if (resolution.kind === 'fim') {
      const now = Date.now();
      if (now - this.lastFimRequest >= FIM_THROTTLE_MS) {
        this.lastFimRequest = now;
        const completion = await fetchFim({
          baseUrl,
          apiKey: apiKey ?? 'not-needed',
          model: resolution.model,
          prefix,
          suffix,
          signal,
        }).catch(() => undefined);
        if (completion) {
          return completion;
        }
      }
    }

    if (!config.autocompleteFallback || !looksLikeCode(prefix)) {
      return undefined;
    }
    if (preset.requiresKey && !apiKey) {
      return undefined;
    }

    const now = Date.now();
    if (now - this.lastChatRequest < CHAT_THROTTLE_MS) {
      return undefined;
    }
    this.lastChatRequest = now;

    const provider = createProvider(
      { ...config, provider: preset.provider, baseUrl: effectiveBaseUrl(preset, config.baseUrl) },
      apiKey,
    );
    return fetchChatCompletion(provider, config.model, prefix, suffix, signal).catch(() => undefined);
  }

  private maybeNotify(presetLabel: string): void {
    if (this.context.globalState.get<boolean>(NOTICE_KEY)) {
      return;
    }
    void this.context.globalState.update(NOTICE_KEY, true);
    void vscode.window
      .showInformationMessage(
        `Dev-First: inline completions aren't available for ${presetLabel}. Set devFirst.autocompleteModel to a FIM-capable model, or keep the chat fallback enabled.`,
        'Open Settings',
      )
      .then((action) => {
        if (action === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'devFirst.autocomplete');
        }
      });
  }
}
