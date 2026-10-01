import * as vscode from 'vscode';
import type { ProviderPreset } from './llm/presets';

export type ProviderId = 'openai' | 'anthropic' | 'gemini';

export type SandboxMode = 'off' | 'workspace-write';
export type EmbeddingsProvider = 'local' | 'api';
export type ReasoningEffortSetting = 'off' | 'low' | 'medium' | 'high' | (string & {});
export type NotifySound = 'off' | 'chime' | 'beep';

export interface DevFirstConfig {
  preset: string;
  provider: ProviderId;
  baseUrl: string;
  model: string;
  maxSteps: number;
  plannerMaxSteps: number;
  terminalTimeout: number;
  headerTimeout: number;
  streamIdleTimeout: number;
  autoApproveTerminal: boolean;
  autoApproveEdits: boolean;
  safeCommandsOnly: boolean;
  yolo: boolean;
  checkDiagnostics: boolean;
  autoCompact: boolean;
  contextLimitTokens: number;
  semanticIndex: boolean;
  embeddingsProvider: EmbeddingsProvider;
  embeddingsModel: string;
  sandbox: SandboxMode;
  browserPort: number;
  browserAutoLaunch: boolean;
  reasoningEffort: ReasoningEffortSetting;
  parallelTools: boolean;
  memory: boolean;
  autocomplete: boolean;
  autocompleteModel: string;
  autocompleteFallback: boolean;
  autoApproveMcp: boolean;
  resources: boolean;
  mcpDisplay: 'plain' | 'markdown';
  notifyOnFinish: boolean;
  soundOnFinish: boolean;
  notifyOnComplete: boolean;
  notifyOnError: boolean;
  notifyOnInput: boolean;
  notifySound: NotifySound;
  keepAwake: boolean;
  scanEnabled: boolean;
  scanAst: boolean;
  scanHotspots: boolean;
  scanDuplication: boolean;
  scanDuplicationThreshold: number;
  scanCrossFile: boolean;
  scanConventions: boolean;
  scanMaxFileKb: number;
  scanIgnore: string[];
  scanNewOnly: boolean;
  scanDisabledCategories: string[];
  scanAi: boolean;
  scanAiModel: string;
  scanAiCrossFile: boolean;
  scanAiCrossFileMaxPairs: number;
  architecture: boolean;
  pasteFileLines: number;
}

const DEFAULT_SCAN_IGNORE =
  '**/node_modules/**,**/dist/**,**/out/**,**/.next/**,**/vendor/**,**/target/**,**/build/**,**/coverage/**,**/*.min.*,**/*.pb.go,**/*.generated.*,**/generated/**,**/package-lock.json,**/yarn.lock,**/pnpm-lock.yaml';

export function getConfig(): DevFirstConfig {
  const config = vscode.workspace.getConfiguration('devFirst');
  return {
    preset: config.get<string>('preset', 'openai'),
    provider: config.get<ProviderId>('provider', 'openai'),
    baseUrl: config.get<string>('baseUrl', ''),
    model: config.get<string>('model', 'gpt-4o'),
    maxSteps: config.get<number>('maxSteps', 60),
    plannerMaxSteps: config.get<number>('plannerMaxSteps', 12),
    terminalTimeout: config.get<number>('terminalTimeout', 120),
    headerTimeout: Math.max(0, config.get<number>('headerTimeout', 120)),
    streamIdleTimeout: Math.max(0, config.get<number>('streamIdleTimeout', 120)),
    autoApproveTerminal: config.get<boolean>('autoApproveTerminal', false),
    autoApproveEdits: config.get<boolean>('autoApproveEdits', true),
    safeCommandsOnly: config.get<boolean>('safeCommandsOnly', true),
    yolo: config.get<boolean>('yolo', false),
    checkDiagnostics: config.get<boolean>('checkDiagnostics', true),
    autoCompact: config.get<boolean>('autoCompact', true),
    contextLimitTokens: config.get<number>('contextLimitTokens', 128000),
    semanticIndex: config.get<boolean>('semanticIndex', true),
    embeddingsProvider: config.get<EmbeddingsProvider>('embeddingsProvider', 'local'),
    embeddingsModel: config.get<string>('embeddingsModel', 'text-embedding-3-small'),
    sandbox: config.get<SandboxMode>('sandbox', 'workspace-write'),
    browserPort: config.get<number>('browserPort', 9222),
    browserAutoLaunch: config.get<boolean>('browserAutoLaunch', true),
    reasoningEffort: config.get<ReasoningEffortSetting>('reasoningEffort', 'off'),
    parallelTools: config.get<boolean>('parallelTools', true),
    memory: config.get<boolean>('memory', true),
    autocomplete: config.get<boolean>('autocomplete', false),
    autocompleteModel: config.get<string>('autocompleteModel', ''),
    autocompleteFallback: config.get<boolean>('autocompleteFallback', true),
    autoApproveMcp: config.get<boolean>('autoApproveMcp', true),
    resources: config.get<boolean>('resources', true),
    mcpDisplay: config.get<'plain' | 'markdown'>('mcpDisplay', 'markdown'),
    notifyOnFinish: config.get<boolean>('notifyOnFinish', false),
    soundOnFinish: config.get<boolean>('soundOnFinish', false),
    notifyOnComplete: config.get<boolean>('notifyOnComplete', true),
    notifyOnError: config.get<boolean>('notifyOnError', true),
    notifyOnInput: config.get<boolean>('notifyOnInput', true),
    notifySound: config.get<NotifySound>('notifySound', 'chime'),
    keepAwake: config.get<boolean>('keepAwake', false),
    scanEnabled: config.get<boolean>('scanEnabled', true),
    scanAst: config.get<boolean>('scanAst', true),
    scanHotspots: config.get<boolean>('scanHotspots', true),
    scanDuplication: config.get<boolean>('scanDuplication', true),
    scanDuplicationThreshold: Math.min(
      1,
      Math.max(0.5, config.get<number>('scanDuplicationThreshold', 0.8)),
    ),
    scanCrossFile: config.get<boolean>('scanCrossFile', true),
    scanConventions: config.get<boolean>('scanConventions', true),
    scanMaxFileKb: config.get<number>('scanMaxFileKb', 1024),
    scanIgnore: config
      .get<string>('scanIgnore', DEFAULT_SCAN_IGNORE)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    scanNewOnly: config.get<boolean>('scanNewOnly', false),
    scanDisabledCategories: config
      .get<string>('scanDisabledCategories', '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    scanAi: config.get<boolean>('scanAi', true),
    scanAiModel: config.get<string>('scanAiModel', ''),
    scanAiCrossFile: config.get<boolean>('scanAiCrossFile', true),
    scanAiCrossFileMaxPairs: Math.max(
      0,
      Math.floor(config.get<number>('scanAiCrossFileMaxPairs', 3)),
    ),
    architecture: config.get<boolean>('architecture', true),
    pasteFileLines: Math.max(20, config.get<number>('pasteFileLines', 120)),
  };
}

export function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'gemini':
      return 'https://generativelanguage.googleapis.com';
    default:
      return 'https://api.openai.com/v1';
  }
}

const SECRET_PREFIX = 'devFirst.apiKey.';

export async function getApiKeyForPreset(
  context: vscode.ExtensionContext,
  preset: ProviderPreset,
): Promise<string | undefined> {
  const key = await context.secrets.get(SECRET_PREFIX + preset.id);
  if (key) {
    return key;
  }
  return context.secrets.get(SECRET_PREFIX + preset.provider);
}

export async function saveApiKey(
  context: vscode.ExtensionContext,
  presetId: string,
  apiKey: string,
): Promise<void> {
  await context.secrets.store(SECRET_PREFIX + presetId, apiKey.trim());
}

export async function deleteApiKey(
  context: vscode.ExtensionContext,
  presetId: string,
): Promise<void> {
  await context.secrets.delete(SECRET_PREFIX + presetId);
}

export async function promptForApiKey(
  context: vscode.ExtensionContext,
  preset: ProviderPreset,
): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: `API key for ${preset.label}`,
    placeHolder: preset.provider === 'openai' ? 'sk-...' : 'Paste your API key',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  await saveApiKey(context, preset.id, value);
  await vscode.workspace
    .getConfiguration('devFirst')
    .update('preset', preset.id, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Dev-First: API key saved for ${preset.label}.`);
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
