import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync, promises as fs } from 'fs';
import { DiffManager } from '../diff/DiffManager';
import { AgentService } from '../agent/AgentService';
import { ToolBox, ToolExecutionContext } from '../agent/ToolBox';
import { PlannerService } from '../planner/PlannerService';
import { ChatMessage, LLMProvider, ToolCall, ToolDef, UsageTotals } from '../llm/types';
import {
  ChangedFile,
  ConnectionState,
  HostMessage,
  MessageAttachment,
  ModelMetadata,
  PastedContent,
  PendingDecisionRecord,
  Phase,
  Plan,
  ProviderConnection,
  QueuedPromptRecord,
  QuestionRequest,
  RunChangedFile,
  RunOperation,
  RunRecord,
  RunReviewFile,
  RunStatus,
  SelectionContext,
  TerminalApprovalDecision,
  TerminalApprovalRequest,
  TodoItem,
  UiMessage,
  UiState,
  WebviewMessage,
} from '../shared/protocol';
import { ModelInfo, ModelRegistry } from '../llm/modelRegistry';
import { fetchModelMetadata } from '../llm/modelMetadata';
import {
  CatalogModel,
  clampReasoningLevel,
  modelInfo,
  modelsForProvider,
  readLiveModels,
  readLiveModelsUpdatedAt,
  reasoningLevelsFor,
  storeLiveModels,
  storeLiveModelsUpdatedAt,
} from '../llm/catalog';
import { HttpError } from '../llm/errors';
import { adaptiveKind } from '../llm/adaptive';
import { SessionStore, StoredSession } from './SessionStore';
import { RunJournalStore } from './RunJournalStore';
import {
  FILE_EDIT_TOOLS,
  absoluteWorkspacePath,
  appendStepHash,
  buildRunOperation,
  classifyOperationRetry,
  filterAlivePids,
  parseOperationExpectations,
  serializeOperationExpectations,
  sha1File,
  upsertRunChangedFile,
  validateRecoveredDecision,
} from './runRecovery';
import { PromptFamily, promptFamilyFor } from '../planner/prompts';
import { ReasoningOptions } from '../llm/types';
import {
  CompressionBlock,
  MIN_COMPRESS_MESSAGES,
  PRESERVE_RECENT_TOKENS,
  chooseRecentStart,
  estimateTokens,
  projectCompressedMessages,
  summarizeMessages,
} from '../agent/compaction';
import { usageTotal } from '../llm/usage';
import { DevFirstConfig, deleteApiKey, getApiKeyForPreset, getConfig, saveApiKey, workspaceRoot } from '../config';
import { createProvider } from '../llm';
import { activeProvider } from '../llm/activeProvider';
import { PRESETS, ProviderPreset, connectionNotice, effectiveBaseUrl, findPreset } from '../llm/presets';
import { ConnectionsStore, StoredConnection, connectionQualifies } from './connections';
import { formatSelectionAttachment } from '../util/selection';
import { errorMessage, isAbortError } from '../util/errors';
import { randomId } from '../util/id';
import { loadProjectRules } from '../planner/rules';
import { expandSlashCommand, listCommands, listSkills } from '../skills/SkillManager';
import { builtinCommand } from '../skills/builtinCommands';
import { planFromText, planSlug, planToText } from '../planner/planParser';
import { explanationToMarkdown, isExplanationPlan } from '../planner/explanation';
import { fetchLearnMore } from '../resources/LearnMoreService';
import { buildTranscript } from './transcript';
import { extractTakeaways } from './takeaways';
import { extractFailureConcept } from './failureConcept';
import { findNewlyStartedTodos, mergeTodoCheckpoints } from '../util/todos';
import { SETTING_KEYS } from '../shared/settingsSchema';
import { MemoryStore } from '../memory/MemoryStore';
import { BackgroundProcesses } from '../agent/BackgroundProcesses';
import { OriginalContentProvider } from '../diff/OriginalContentProvider';
import { listWorkspaceFiles } from '../util/fsWalk';
import { ActivityMeta, executionTools, plannerTools, subagentTools } from '../agent/tools';
import { ApprovalMemory, ExternalDirectoryConsent } from '../agent/approvals';
import { runSubagent } from '../agent/subagent';
import { SemanticIndex } from '../indexing/SemanticIndex';
import { LocalEmbedder } from '../indexing/LocalEmbedder';
import { McpManager } from '../mcp/McpManager';
import { BrowserSession } from '../browser/BrowserSession';
import { CheckpointManager } from '../checkpoints/CheckpointManager';
import { architectureFilesHash } from '../architecture/mapStore';
import { chatWithRetry } from '../llm/retry';
import { appendDelta } from '../shared/stream';
import { ReviewFileDiff } from '../review/changeset';
import { buildReviewSummaryPrompt } from '../review/summary';
import { buildCrossFileReviewPrompt } from '../review/crossFile';
import { matchConvention, parseConventionsSection } from '../scan/conventions';
import {
  formatRelevantProjectModel,
  parseProjectModelSection,
  relevanceTerms,
  relevantProjectModelBullets,
} from '../scan/projectModel';
import {
  EXPLAIN_CODEBASE_MAX_FILES,
  buildExplainCodebasePrompt,
} from '../scan/explainCodebase';
import type { ExplainCodebaseFile } from '../scan/explainCodebase';

const ACTIVE_SESSION_KEY = 'devFirst.activeSessionId';
const LEGACY_SESSION_KEY = 'devFirst.session';

function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeStoredMessage(value: unknown, index: number): UiMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const role = raw.role === 'user' || raw.role === 'assistant' || raw.role === 'notice' ? raw.role : undefined;
  if (!role) return undefined;
  const kind = raw.kind === 'error' || raw.kind === 'completion' || raw.kind === 'compaction' ? raw.kind : undefined;
  const compaction = raw.compaction && typeof raw.compaction === 'object'
    ? raw.compaction as UiMessage['compaction']
    : undefined;
  const activities = Array.isArray(raw.activities)
    ? raw.activities.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .filter((item) => typeof item.id === 'string' && typeof item.label === 'string')
        .map((item) => ({
          id: item.id as string,
          label: item.label as string,
          status: (item.status === 'running' || item.status === 'error' ? item.status : 'done') as NonNullable<UiMessage['activities']>[number]['status'],
          ...(typeof item.icon === 'string' ? { icon: item.icon } : {}),
          ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
          ...(item.detailKind === 'terminal' || item.detailKind === 'text' ? { detailKind: item.detailKind as 'terminal' | 'text' } : {}),
          ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
          ...(typeof item.filePath === 'string' ? { filePath: item.filePath } : {}),
        }))
    : undefined;
  const attachment = raw.attachment && typeof raw.attachment === 'object'
    ? raw.attachment as MessageAttachment
    : undefined;
  const changedFiles = Array.isArray(raw.changedFiles)
    ? raw.changedFiles
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .filter((item) => typeof item.path === 'string')
        .map((item) => ({
          path: item.path as string,
          status: (item.status === 'added' || item.status === 'deleted' ? item.status : 'modified') as ChangedFile['status'],
          additions: typeof item.additions === 'number' ? item.additions : 0,
          deletions: typeof item.deletions === 'number' ? item.deletions : 0,
        }))
    : undefined;
  const planSnapshot = raw.planSnapshot && typeof raw.planSnapshot === 'object'
    ? (() => {
        const snapshot = raw.planSnapshot as Record<string, unknown>;
        const title = typeof snapshot.title === 'string' ? snapshot.title : '';
        if (!title) {
          return undefined;
        }
        const steps = Array.isArray(snapshot.steps)
          ? snapshot.steps.filter((step): step is string => typeof step === 'string')
          : undefined;
        return { title, ...(steps && steps.length > 0 ? { steps } : {}) };
      })()
    : undefined;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `restored-${index}`,
    role,
    text: typeof raw.text === 'string' ? raw.text : '',
    streaming: false,
    ...(kind ? { kind } : {}),
    ...(compaction ? { compaction } : {}),
    ...(Array.isArray(raw.takeaways) ? { takeaways: raw.takeaways.filter((item): item is string => typeof item === 'string') } : {}),
    ...(typeof raw.failureConcept === 'string' ? { failureConcept: raw.failureConcept } : {}),
    ...(activities ? { activities } : {}),
    ...(typeof raw.checkpointId === 'string' ? { checkpointId: raw.checkpointId } : {}),
    ...(attachment && typeof attachment.path === 'string' ? { attachment } : {}),
    ...(Array.isArray(raw.images) ? { images: raw.images.filter((item): item is string => typeof item === 'string') } : {}),
    ...(typeof raw.reasoning === 'string' ? { reasoning: raw.reasoning } : {}),
    ...(typeof raw.quote === 'string' ? { quote: raw.quote } : {}),
    ...(raw.queued === true ? { queued: true } : {}),
    ...(raw.interrupted === true ? { interrupted: true } : {}),
    ...(raw.action === 'openSettings' ? { action: raw.action } : {}),
    ...(planSnapshot ? { planSnapshot } : {}),
    ...(typeof raw.runId === 'string' && raw.runId ? { runId: raw.runId } : {}),
    ...(changedFiles && changedFiles.length > 0 ? { changedFiles } : {}),
  };
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 401 || error.status === 403;
  }
  const message = errorMessage(error);
  return (
    /\b(401|403)\b/.test(message) ||
    /unauthorized|invalid api key|incorrect api key|authentication failed/i.test(message)
  );
}

export class SessionController {
  private phase: Phase = 'idle';
  private uiMessages: UiMessage[] = [];
  private conversation: ChatMessage[] = [];
  private plan: Plan | null = null;
  private todos: TodoItem[] = [];
  private planVersion = 0;
  private lastRequest = '';
  private lastUserMessageId: string | undefined;
  private abortController: AbortController | null = null;
  private reasoningOverride: string | undefined;
  private reasoningChanges = 0;
  private streamingMessageId: string | null = null;
  private activeStatusId: string | undefined;
  private currentApproval: TerminalApprovalRequest | null = null;
  private persistTimer: NodeJS.Timeout | undefined;
  private readonly pendingApprovals = new Map<string, (decision: TerminalApprovalDecision) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly mcp = new McpManager();
  private readonly checkpoints: CheckpointManager;
  private semanticIndex: SemanticIndex | undefined;
  private localEmbedder: LocalEmbedder | undefined;
  private browser: BrowserSession | undefined;
  private selection: SelectionContext | null = null;
  private connectionError: string | undefined;
  private connectionNoticeId: string | undefined;
  private keyPresent = false;
  private contextTokens = 0;
  private lastExactUsage: UsageTotals | undefined;
  private compressionBlocks: CompressionBlock[] = [];
  private compressionsThisTurn = 0;
  private lastCheckpointId: string | undefined;
  private redoCheckpointId: string | undefined;
  private readonly registry: ModelRegistry;
  private readonly connections: ConnectionsStore;
  private readonly memory: MemoryStore;
  private readonly background: BackgroundProcesses;
  private readonly store: SessionStore;
  private sessionId = newSessionId();
  private sessionTitle = 'New session';
  private sessionCreatedAt = Date.now();
  private currentQuestion: QuestionRequest | null = null;
  private readonly pendingQuestions = new Map<string, (answer: string) => void>();
  private readonly approvalMemory = new ApprovalMemory();
  private readonly externalDirectories = new ExternalDirectoryConsent();
  private subagentDepth = 0;
  private phaseListener?: (phase: Phase) => void;
  private errorListener?: (message: string) => void;
  private needsInputListener?: (message: string) => void;
  private connectionListener?: (connected: boolean) => void;
  private knowledgeSource?: { refreshKnowledge(): Promise<void> };

  private queuedMessages: Array<{
    id: string;
    text: string;
    selection?: SelectionContext;
    quote?: string;
    images?: string[];
    pastes?: PastedContent[];
    createdAt: number;
  }> = [];
  private readonly runJournal: RunJournalStore;
  private currentRun: RunRecord | undefined;
  private recoveryRun: RunRecord | undefined;
  private recoveryDrift = false;
  private stepHashChain: Promise<void> = Promise.resolve();
  private runningQueued: { id: string; text: string; createdAt: number } | undefined;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly post: (message: HostMessage) => void,
    private readonly diffManager: DiffManager,
  ) {
    this.checkpoints = new CheckpointManager(
      workspaceRoot() ?? process.cwd(),
      path.join(context.globalStorageUri.fsPath, 'checkpoints'),
    );
    this.registry = new ModelRegistry(path.join(context.globalStorageUri.fsPath, 'models-cache.json'));
    this.connections = new ConnectionsStore(context.globalState);
    this.memory = new MemoryStore(workspaceRoot() ?? process.cwd(), context.globalStorageUri.fsPath);
    this.background = new BackgroundProcesses(workspaceRoot() ?? process.cwd());
    this.background.onChange(() => this.refreshRunProcesses());
    this.store = new SessionStore(path.join(context.globalStorageUri.fsPath, 'sessions'));
    this.runJournal = new RunJournalStore(path.join(context.globalStorageUri.fsPath, 'runs'));
    void this.initializeSession();
    void this.cleanupPasteFiles();
    this.disposables.push(diffManager.onDidChangePendingChanges(() => this.pushChanges()));
    if (typeof diffManager.onDidChangeHistory === 'function') {
      this.disposables.push(diffManager.onDidChangeHistory(() => this.pushState()));
    }
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.pushSelection()),
      vscode.window.onDidChangeActiveTextEditor(() => this.pushSelection()),
    );
    void this.refreshConnection();
  }

  getState(): UiState {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const metadata = this.selectedModelMetadata(preset.id, config.model, preset.provider);
    const reasoningLevels = metadata.reasoningLevels ?? [];
    const reasoningEffort = this.selectedReasoningEffort(preset.id, config.model, reasoningLevels, metadata.reasoningDefault);
    return {
      phase: this.phase,
      messages: this.uiMessages,
      plan: this.plan,
      todos: this.todos,
      changes: this.diffManager.getChangeSummaries(),
      terminalApproval: this.currentApproval,
      question: this.currentQuestion,
      sandboxEnabled: config.sandbox !== 'off',
      connection: this.buildConnectionState(),
      connections: this.buildConnections(),
      selection: this.selection,
      contextUsage: {
        tokens: this.exactUsageTotal() ?? this.contextTokens,
        limit: this.effectiveContextLimit(),
        reserved: this.reservedOutputTokens(),
      },
      currentRunId: this.diffManager.getCurrentRunId(),
      viewableRuns: this.diffManager.viewableRunIds?.() ?? [],
      autoApproveTerminal: config.autoApproveTerminal,
      supportsVision: metadata.supportsVision !== false,
      visionSupportKnown: metadata.supportsVision !== undefined,
      modelDisplayName: metadata.name ?? config.model,
      reasoningEffort,
      reasoningLevels,
      reasoningCurrent: reasoningEffort,
      reasoningDefault: metadata.reasoningDefault ?? '',
      resources: config.resources,
      mcpDisplay: config.mcpDisplay,
      soundOnFinish: config.soundOnFinish,
      sessionTitle: this.sessionTitle,
      provider: config.provider,
      model: config.model,
      pasteFileLines: config.pasteFileLines,
      queued: this.queuedRecords(),
      ...(this.recoveryRun
        ? {
            recovery: {
              run: this.recoveryRun,
              ...(this.recoveryDrift ? { runDrift: true } : {}),
              ...this.recoveryProcessesAlive(),
            },
          }
        : {}),
    };
  }

  private recoveryProcessesAlive(): { processesAlive?: number[] } {
    const pids = (this.recoveryRun?.processes ?? []).map((entry) => entry.pid);
    if (pids.length === 0) {
      return {};
    }
    const alive = filterAlivePids(pids, (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    return alive.length > 0 ? { processesAlive: alive } : {};
  }

  private async initializeSession(): Promise<void> {
    const sessions = await this.store.list();
    const lastActive = this.context.workspaceState.get<string>(ACTIVE_SESSION_KEY);
    const target = sessions.find((session) => session.id === lastActive) ?? sessions[0];
    if (target) {
      const stored = await this.store.load(target.id);
      if (stored) {
        this.applySession(stored);
        await this.recoverRuns();
        await this.cleanupStaleConnectionNotice();
        this.postSessions(await this.store.list());
        return;
      }
    }
    await this.migrateLegacySession();
    await this.recoverRuns();
    await this.cleanupStaleConnectionNotice();
    this.postSessions(await this.store.list());
  }

  private async cleanupStaleConnectionNotice(): Promise<void> {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const key = await getApiKeyForPreset(this.context, preset);
    if (preset.requiresKey && !key) {
      return;
    }
    this.removeConnectionNotice();
  }

  private async migrateLegacySession(): Promise<void> {
    const legacy = this.context.workspaceState.get<{
      messages?: UiMessage[];
      conversation?: ChatMessage[];
      plan?: Plan | null;
      todos?: TodoItem[];
      planVersion?: number;
      lastRequest?: string;
    }>(LEGACY_SESSION_KEY);
    if (legacy?.messages?.length) {
      this.uiMessages = legacy.messages.map((message) => ({ ...message, streaming: false }));
      this.conversation = legacy.conversation ?? [];
      this.plan = this.restorablePlan(legacy.plan ?? null);
      this.todos = legacy.todos ?? [];
      this.planVersion = legacy.planVersion ?? 0;
      this.lastRequest = legacy.lastRequest ?? '';
      const firstUser = this.uiMessages.find((message) => message.role === 'user');
      this.sessionTitle = firstUser ? firstUser.text.slice(0, 50) : 'Imported session';
      await this.context.workspaceState.update(LEGACY_SESSION_KEY, undefined);
    }
    await this.persistNow();
  }

  private applySession(stored: StoredSession): void {
    this.sessionId = stored.id;
    this.sessionTitle = stored.title;
    this.sessionCreatedAt = stored.createdAt;
    this.uiMessages = (Array.isArray(stored.messages) ? stored.messages : [])
      .map((message, index) => normalizeStoredMessage(message, index))
      .filter((message): message is UiMessage => message !== undefined);
    this.conversation = stored.conversation ?? [];
    const plan = stored.plan ?? null;
    if (plan && !plan.flow) {
      const legacyFlow = (plan as { howDiagram?: string }).howDiagram;
      if (legacyFlow) {
        plan.flow = legacyFlow;
      }
    }
    this.plan = this.restorablePlan(plan);
    this.todos = Array.isArray(stored.todos)
      ? stored.todos.filter((todo) => todo && typeof todo.text === 'string' && todo.text.trim())
          .map((todo) => ({
            ...todo,
            status:
              todo.status === 'done' || todo.status === 'in_progress' || todo.status === 'cancelled'
                ? todo.status
                : 'pending',
          }))
      : [];
    this.planVersion = stored.planVersion ?? 0;
    this.approvalMemory.clear();
    this.externalDirectories.clear();
    this.lastRequest = stored.lastRequest ?? '';
    this.contextTokens = stored.contextTokens ?? 0;
    this.lastExactUsage = undefined;
    this.compressionBlocks = [];
    this.compressionsThisTurn = 0;
    this.lastUserMessageId = [...this.uiMessages].reverse().find((message) => message.role === 'user')?.id;
    this.lastCheckpointId = undefined;
    this.streamingMessageId = null;
    this.queuedMessages = (Array.isArray(stored.queued) ? stored.queued : [])
      .filter(
        (record) =>
          record &&
          typeof record.id === 'string' &&
          typeof record.text === 'string' &&
          record.status !== 'completed' &&
          record.status !== 'cancelled',
      )
      .map((record) => ({
        id: record.id,
        text: record.text,
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
      }));
    this.runningQueued = undefined;
    this.currentRun = undefined;
    void this.context.workspaceState.update(ACTIVE_SESSION_KEY, this.sessionId);
  }

  private restorablePlan(plan: Plan | null): Plan | null {
    if (!plan) {
      return null;
    }
    if (plan.status === 'draft' || this.phase === 'executing') {
      return plan;
    }
    return null;
  }

  private snapshotSession(): StoredSession {
    return {
      id: this.sessionId,
      title: this.sessionTitle,
      createdAt: this.sessionCreatedAt,
      updatedAt: Date.now(),
      messages: this.uiMessages,
      conversation: this.conversation,
      plan: this.plan,
      todos: this.todos,
      planVersion: this.planVersion,
      lastRequest: this.lastRequest,
      contextTokens: this.contextTokens,
      queued: this.queuedRecords(),
    };
  }

  private async postSessions(sessions?: Awaited<ReturnType<SessionStore['list']>>): Promise<void> {
    this.post({
      type: 'sessions',
      sessions: sessions ?? (await this.store.list()),
      activeId: this.sessionId,
    });
  }

  private async switchSession(id: string): Promise<void> {
    if (id === this.sessionId) {
      return;
    }
    if (this.phase === 'planning' || this.phase === 'executing') {
      this.addNotice('Stop the current task before switching sessions.');
      return;
    }
    await this.persistNow();
    const stored = await this.store.load(id);
    if (!stored) {
      this.addNotice('That session no longer exists.');
      return;
    }
    this.applySession(stored);
    await this.loadRecoveryRun();
    this.pushState();
    this.postSessions();
  }

  private async deleteSession(id: string): Promise<void> {
    await this.store.delete(id);
    if (id === this.sessionId) {
      const remaining = await this.store.list();
      if (remaining[0]) {
        const stored = await this.store.load(remaining[0].id);
        if (stored) {
          this.applySession(stored);
        }
      } else {
        this.resetSessionState();
        await this.persistNow();
      }
      this.pushState();
    }
    this.postSessions();
  }

  private async renameSession(id: string, title: string): Promise<void> {
    await this.store.rename(id, title);
    if (id === this.sessionId) {
      this.sessionTitle = title.trim().slice(0, 80) || this.sessionTitle;
      this.pushState();
    }
    this.postSessions();
  }

  private resetSessionState(): void {
    this.sessionId = newSessionId();
    this.sessionTitle = 'New session';
    this.sessionCreatedAt = Date.now();
    this.uiMessages = [];
    this.conversation = [];
    this.plan = null;
    this.todos = [];
    this.planVersion = 0;
    this.lastRequest = '';
    this.lastUserMessageId = undefined;
    this.lastCheckpointId = undefined;
    this.contextTokens = 0;
    this.lastExactUsage = undefined;
    this.compressionBlocks = [];
    this.compressionsThisTurn = 0;
    this.streamingMessageId = null;
    this.queuedMessages = [];
    this.runningQueued = undefined;
    this.currentRun = undefined;
    this.recoveryRun = undefined;
    this.recoveryDrift = false;
    this.approvalMemory.clear();
    this.externalDirectories.clear();
    void this.context.workspaceState.update(ACTIVE_SESSION_KEY, this.sessionId);
  }

  pushState(): void {
    this.post({ type: 'state', state: this.getState() });
  }

  private buildConnectionState(): ConnectionState {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const needsKey = preset.requiresKey && !this.keyPresent;
    const connection: ConnectionState = {
      preset: preset.id,
      provider: preset.provider,
      model: config.model,
      connected: !needsKey && Boolean(config.model),
      needsKey,
      error: this.connectionError,
    };
    this.connectionListener?.(connection.connected);
    return connection;
  }

  private buildConnections(): ProviderConnection[] {
    const config = getConfig();
    const entries = this.connections.list();
    const activePreset = findPreset(config.preset);
    if (
      activePreset &&
      connectionQualifies(activePreset, this.keyPresent) &&
      !entries.some((entry) => entry.preset === config.preset)
    ) {
      entries.push({ preset: config.preset, baseUrl: config.baseUrl, lastModel: config.model });
    }
    return entries.map((entry) => {
      const preset = findPreset(entry.preset);
      const active = entry.preset === config.preset;
      return {
        preset: entry.preset,
        label: preset?.label ?? entry.preset,
        model: active ? config.model || entry.lastModel : entry.lastModel,
        active,
      };
    });
  }

  private async refreshConnection(): Promise<void> {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const key = await getApiKeyForPreset(this.context, preset);
    this.keyPresent = Boolean(key);
    if (this.keyPresent) {
      this.removeConnectionNotice();
    }
    await this.migrateActiveConnection();
    this.post({ type: 'connection', connection: this.buildConnectionState() });
  }

  private async migrateActiveConnection(): Promise<void> {
    const config = getConfig();
    const preset = findPreset(config.preset);
    if (!preset || this.connections.get(config.preset)) {
      return;
    }
    const key = await getApiKeyForPreset(this.context, preset);
    if (!connectionQualifies(preset, Boolean(key))) {
      return;
    }
    await this.connections.addOrUpdate(config.preset, config.baseUrl, config.model);
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.pushState();
  }

  private async handleConnect(presetId: string, apiKey?: string, baseUrl?: string): Promise<void> {
    const preset = findPreset(presetId);
    if (!preset) {
      this.post({ type: 'connectResult', ok: false, error: `Unknown provider "${presetId}".` });
      return;
    }
    if (preset.requiresKey && !apiKey?.trim()) {
      this.post({ type: 'connectResult', ok: false, error: `An API key is required for ${preset.label}.` });
      return;
    }

    const config = getConfig();
    const presetChanged = config.preset !== preset.id;
    const effective: DevFirstConfig = {
      ...config,
      provider: preset.provider,
      baseUrl: effectiveBaseUrl(preset, baseUrl),
      model: (presetChanged ? '' : config.model) || preset.defaultModel || '',
    };
    const candidate = createProvider(effective, apiKey?.trim() || undefined);
    await this.registry.load();

    let live: string[] = [];
    let warning: string | undefined;
    try {
      live = await candidate.listModels();
    } catch (error) {
      const message = errorMessage(error);
      if (isAuthFailure(error)) {
        this.connectionError = message;
        this.post({ type: 'connectResult', ok: false, error: this.describeConnectError(preset, message) });
        return;
      }
      warning = `Connected, but the live model list could not be fetched (${message}). Showing known models.`;
    }

    const details = await fetchModelMetadata(preset.id, effective.baseUrl, apiKey?.trim() || undefined);
    await this.storeModelDetails(preset.id, details);
    if (Object.keys(details).length > 0) warning = undefined;

    if (apiKey?.trim()) {
      await saveApiKey(this.context, preset.id, apiKey);
    }
    if (live.length > 0) {
      await storeLiveModels(this.context.globalState, preset.id, live);
      await storeLiveModelsUpdatedAt(this.context.globalState, preset.id, Date.now());
    }
    const models = modelsForProvider(
      preset.id,
      [...live, ...Object.keys(details)],
      this.registry.providerModelIds(preset.id),
    );
    const chosenModel = effective.model || models[0] || (presetChanged ? '' : config.model);
    const settings = vscode.workspace.getConfiguration('devFirst');
    await settings.update('preset', preset.id, vscode.ConfigurationTarget.Global);
    await settings.update('baseUrl', baseUrl?.trim() ?? '', vscode.ConfigurationTarget.Global);
    await settings.update('model', chosenModel, vscode.ConfigurationTarget.Global);
    await this.connections.addOrUpdate(preset.id, baseUrl?.trim() ?? '', chosenModel);
    await this.migrateActiveConnection();

    this.keyPresent = Boolean(apiKey?.trim()) || !preset.requiresKey;
    this.connectionError = undefined;
    this.removeConnectionNotice();
    this.post({
      type: 'connectResult',
      ok: true,
      models,
      details,
      error: warning,
      preset: preset.id,
      updatedAt: readLiveModelsUpdatedAt(this.context.globalState, preset.id),
    });
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.pushState();
  }

  private async handleFetchModels(presetId: string, apiKey?: string, baseUrl?: string): Promise<void> {
    const preset = findPreset(presetId);
    if (!preset) {
      this.post({ type: 'models', models: [], error: 'Unknown provider.' });
      return;
    }
    const config = getConfig();
    const key = apiKey?.trim() || (await getApiKeyForPreset(this.context, preset));
    const effective: DevFirstConfig = {
      ...config,
      provider: preset.provider,
      baseUrl: effectiveBaseUrl(preset, baseUrl),
    };
    const stored = readLiveModels(this.context.globalState, preset.id);
    const details = await fetchModelMetadata(preset.id, effective.baseUrl, key);
    await this.storeModelDetails(preset.id, details);
    await this.registry.load();
    try {
      const live = await createProvider(effective, key).listModels();
      const available = [...live, ...Object.keys(details)];
      if (available.length > 0) {
        await storeLiveModels(this.context.globalState, preset.id, available);
        await storeLiveModelsUpdatedAt(this.context.globalState, preset.id, Date.now());
      }
      const models = modelsForProvider(preset.id, available, this.registry.providerModelIds(preset.id));
      this.post({
        type: 'models',
        models,
        details,
        preset: preset.id,
        updatedAt: readLiveModelsUpdatedAt(this.context.globalState, preset.id),
      });
      if (preset.id === getConfig().preset) this.pushState();
    } catch (error) {
      const fallback = modelsForProvider(
        preset.id,
        [...stored, ...Object.keys(details)],
        this.registry.providerModelIds(preset.id),
      );
      const message = errorMessage(error);
      const authFailure = isAuthFailure(error);
      const errorText = authFailure
        ? this.describeConnectError(preset, message)
        : fallback.length === 0
          ? 'Could not fetch models — type a model id.'
          : undefined;
      this.post({
        type: 'models',
        models: fallback,
        details,
        error: errorText,
        preset: preset.id,
        updatedAt: readLiveModelsUpdatedAt(this.context.globalState, preset.id),
        liveFailed: !authFailure && fallback.length > 0,
      });
      if (preset.id === getConfig().preset) this.pushState();
    }
  }

  private async postStoredModels(): Promise<void> {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    await this.registry.load();
    const models = modelsForProvider(
      preset.id,
      readLiveModels(this.context.globalState, preset.id),
      this.registry.providerModelIds(preset.id),
    );
    if (models.length > 0) {
      this.post({
        type: 'models',
        models,
        details: this.modelDetails(preset.id),
        preset: preset.id,
        updatedAt: readLiveModelsUpdatedAt(this.context.globalState, preset.id),
      });
    }
  }

  private async refreshModelsInBackground(): Promise<void> {
    const active = findPreset(getConfig().preset) ?? PRESETS[0];
    const presets = new Set<string>([active.id, ...this.connections.list().map((entry) => entry.preset)]);
    for (const presetId of presets) {
      const preset = findPreset(presetId);
      if (!preset) {
        continue;
      }
      if (preset.requiresKey) {
        const key = await getApiKeyForPreset(this.context, preset);
        if (!key) {
          continue;
        }
      }
      await this.handleFetchModels(preset.id);
    }
  }

  private async handleSetModel(model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed) {
      return;
    }
    const entry = this.connections.get(getConfig().preset);
    if (entry) {
      await this.connections.addOrUpdate(entry.preset, entry.baseUrl, trimmed);
    }
    await vscode.workspace
      .getConfiguration('devFirst')
      .update('model', trimmed, vscode.ConfigurationTarget.Global);
    await this.migrateActiveConnection();
    this.connectionError = undefined;
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.pushState();
  }

  private async handleDisconnectProvider(presetId: string): Promise<void> {
    await deleteApiKey(this.context, presetId);
    await this.connections.remove(presetId);
    if (presetId !== getConfig().preset) {
      this.pushState();
      return;
    }
    const next = this.connections.list()[0];
    if (next) {
      await this.activateConnection(next);
      return;
    }
    await this.clearActiveConnection();
  }

  private async activateConnection(entry: StoredConnection): Promise<void> {
    const preset = findPreset(entry.preset);
    if (!preset) {
      await this.clearActiveConnection();
      return;
    }
    const model = entry.lastModel || preset.defaultModel || '';
    const settings = vscode.workspace.getConfiguration('devFirst');
    await settings.update('preset', preset.id, vscode.ConfigurationTarget.Global);
    await settings.update('baseUrl', entry.baseUrl, vscode.ConfigurationTarget.Global);
    await settings.update('model', model, vscode.ConfigurationTarget.Global);
    this.keyPresent = Boolean(await getApiKeyForPreset(this.context, preset));
    this.connectionError = undefined;
    this.removeConnectionNotice();
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.pushState();
    await this.handleFetchModels(preset.id, undefined, entry.baseUrl);
  }

  private async clearActiveConnection(): Promise<void> {
    await vscode.workspace
      .getConfiguration('devFirst')
      .update('model', '', vscode.ConfigurationTarget.Global);
    this.keyPresent = false;
    this.connectionError = undefined;
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.pushState();
  }

  private async handleSetProvider(presetId: string, model: string): Promise<void> {
    const preset = findPreset(presetId);
    if (!preset) {
      return;
    }
    const apiKey = await getApiKeyForPreset(this.context, preset);
    if (preset.requiresKey && !apiKey) {
      this.post({ type: 'connectResult', ok: false, error: `An API key is required for ${preset.label}.` });
      this.post({ type: 'connection', connection: this.buildConnectionState() });
      this.pushState();
      return;
    }
    const entry = this.connections.get(preset.id);
    const chosen = model.trim() || entry?.lastModel || preset.defaultModel || '';
    const baseUrl = entry?.baseUrl ?? '';
    const settings = vscode.workspace.getConfiguration('devFirst');
    await settings.update('preset', preset.id, vscode.ConfigurationTarget.Global);
    await settings.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    await settings.update('model', chosen, vscode.ConfigurationTarget.Global);
    if (entry) {
      await this.connections.addOrUpdate(preset.id, entry.baseUrl, chosen);
    }
    this.keyPresent = Boolean(apiKey);
    this.connectionError = undefined;
    this.removeConnectionNotice();
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.pushState();
    await this.handleFetchModels(preset.id, undefined, baseUrl);
  }

  private describeConnectError(preset: ProviderPreset, message: string): string {
    if (preset.local) {
      return `Could not reach ${preset.label} at ${preset.baseUrl}. Is it running? (${message})`;
    }
    if (message.includes('401') || /unauthorized|invalid.*key/i.test(message)) {
      return 'The API key was rejected. Check it and try again.';
    }
    return message;
  }

  private pushSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') {
      if (this.selection !== null) {
        this.selection = null;
        this.post({ type: 'selection', selection: null });
      }
      return;
    }
    const text = editor.document.getText(editor.selection);
    if (!text.trim()) {
      return;
    }
    this.selection = {
      path: vscode.workspace.asRelativePath(editor.document.uri),
      startLine: editor.selection.start.line + 1,
      endLine: editor.selection.end.line + 1,
      text,
    };
    this.post({ type: 'selection', selection: this.selection });
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.pushState();
        this.postSessions();
        void this.postStoredModels();
        void this.refreshModelsInBackground();
        break;
      case 'switchSession':
        await this.switchSession(message.id);
        break;
      case 'deleteSession':
        await this.deleteSession(message.id);
        break;
      case 'renameSession':
        await this.renameSession(message.id, message.title);
        break;
      case 'sendMessage':
        await this.handleSend(message.text, message.selection, message.quote, message.images, message.pastes);
        break;
      case 'connect':
        await this.handleConnect(message.preset, message.apiKey, message.baseUrl);
        break;
      case 'fetchModels':
        await this.handleFetchModels(message.preset, message.apiKey, message.baseUrl);
        break;
      case 'disconnectProvider':
        await this.handleDisconnectProvider(message.preset);
        break;
      case 'setProvider':
        await this.handleSetProvider(message.preset, message.model);
        break;
      case 'setModel':
        await this.handleSetModel(message.model);
        break;
      case 'approvePlan':
        await this.handleApprove();
        break;
      case 'discardPlan':
        this.discardPlan();
        break;
      case 'stop':
        this.stop();
        break;
      case 'resumeRun':
        await this.resumeRun(message.id, message.force);
        break;
      case 'discardRun':
        await this.discardRun(message.id);
        break;
      case 'rollbackRun':
        await this.rollbackRun(message.id);
        break;
      case 'resolveRecoveredDecision':
        await this.resolveRecoveredDecision(message.runId, message.approved);
        break;
      case 'stopRunProcess':
        await this.stopRunProcess(message.runId, message.pid);
        break;
      case 'forgetRunProcess':
        await this.forgetRunProcess(message.runId, message.pid);
        break;
      case 'forgetBrowser':
        await this.forgetBrowser(message.runId);
        break;
      case 'newSession':
        this.newSession();
        break;
      case 'acceptChange':
        this.diffManager.acceptFile(message.path);
        break;
      case 'rejectChange':
        if ((await this.diffManager.rejectFile(message.path)) === 'conflict') {
          this.post({ type: 'rejectConflict', path: message.path });
        }
        break;
      case 'acceptAll':
        this.diffManager.acceptAllChanges();
        break;
      case 'rejectAll':
        for (const conflictPath of await this.diffManager.rejectAllChanges()) {
          this.post({ type: 'rejectConflict', path: conflictPath });
        }
        break;
      case 'acceptRun':
        if (await this.isRecoveredRun(message.runId)) {
          await this.acceptRunReview(message.runId);
        } else {
          await this.diffManager.acceptRun(message.runId);
        }
        break;
      case 'acceptRunReview':
        await this.acceptRunReview(message.runId);
        break;
      case 'openRunReview':
        await this.openRunReview(message.runId);
        break;
      case 'revertRunFile':
        await this.revertRunFile(message.path, message.runId);
        break;
      case 'rejectRun':
        for (const conflictPath of await this.diffManager.rejectRun(message.runId)) {
          this.post({ type: 'rejectConflict', path: conflictPath });
        }
        break;
      case 'resolveRejectConflict':
        if (message.action === 'revert-file') {
          await this.diffManager.revertWholeFile(message.path);
        } else {
          this.diffManager.keepFile(message.path);
        }
        break;
      case 'explainChange':
        await this.explainChange(message.path);
        break;
      case 'openChange':
        await this.openChange(message.path, message.changeId);
        break;
      case 'openFileDiff':
        await this.openFileDiff(message.path, message.runId);
        break;
      case 'terminalApproval':
        this.resolveApproval(message.id, message.decision);
        break;
      case 'questionAnswer':
        this.resolveQuestion(message.id, message.answer);
        break;
      case 'compactNow':
        await this.compactNow();
        break;
      case 'updatePlan':
        await this.handleUpdatePlan(message.markdown);
        break;
      case 'toggleStep':
        await this.handleToggleStep(message.index);
        break;
      case 'openPlan':
        await this.openPlan();
        break;
      case 'explainSection':
        await this.explainSection(message.key);
        break;
      case 'redoRevert':
        await this.redoRevert();
        break;
      case 'editMessage':
        await this.editMessage(message.id, message.text, message.restoreWorkspace);
        break;
      case 'cancelQueued':
        this.cancelQueued(message.id);
        break;
      case 'revertToCheckpoint':
        await this.revertToCheckpoint(message.checkpointId);
        break;
      case 'listCommands':
        this.post({ type: 'commands', commands: await listCommands(workspaceRoot()) });
        break;
      case 'requestSettings':
        this.postSettings();
        break;
      case 'updateSetting':
        await this.applySetting(message.key, message.value);
        break;
      case 'setReasoningEffort':
        await this.setReasoningEffort(message.preset, message.model, message.value);
        break;
      case 'openVSCodeSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', 'devFirst');
        break;
      case 'enhancePrompt':
        await this.enhancePrompt(message.text);
        break;
      case 'openFile':
        await this.openFileAt(message.path);
        break;
      case 'learnMore':
        await this.learnMore();
        break;
      case 'listFiles':
        this.post({
          type: 'files',
          files: await listWorkspaceFiles(workspaceRoot() ?? process.cwd(), { maxEntries: 2000 }),
        });
        break;
      case 'reviewChanges':
        await this.openMultiDiff();
        break;
      case 'summarizeReview':
        await this.summarizeReview();
        break;
      case 'reviewAcrossFiles':
        await this.reviewAcrossFiles();
        break;
      case 'openExternal':
        void vscode.env.openExternal(vscode.Uri.parse(message.url));
        break;
      case 'openSettings':
        this.post({ type: 'openSettings' });
        break;
      default:
        break;
    }
  }

  stop(): void {
    this.cancelPendingApprovals();
    this.cancelPendingQuestion();
    this.abortController?.abort();
    if (this.currentRun && (this.currentRun.status === 'executing' || this.currentRun.status === 'waiting')) {
      this.currentRun.pending = undefined;
      this.markRun('stopped');
    }
  }

  private requestUserAnswer(request: QuestionRequest): Promise<string> {
    this.currentQuestion = request;
    this.setRunPending({
      id: request.id,
      kind: 'question',
      prompt: request.question,
      createdAt: Date.now(),
      ...(this.activeStepLabel() ? { step: this.activeStepLabel() as string } : {}),
    });
    this.needsInputListener?.('the agent asked you a question');
    this.post({ type: 'question', request });
    return new Promise<string>((resolve) => {
      this.pendingQuestions.set(request.id, resolve);
    });
  }

  private resolveQuestion(id: string, answer: string): void {
    const resolve = this.pendingQuestions.get(id);
    if (!resolve) {
      return;
    }
    this.pendingQuestions.delete(id);
    this.currentQuestion = null;
    this.clearRunPending();
    this.post({ type: 'question', request: null });
    resolve(answer);
  }

  private cancelPendingQuestion(): void {
    for (const resolve of this.pendingQuestions.values()) {
      resolve('');
    }
    this.pendingQuestions.clear();
    if (this.currentQuestion) {
      this.currentQuestion = null;
      this.clearRunPending();
      this.post({ type: 'question', request: null });
    }
  }

  private cancelQueued(id: string): void {
    this.queuedMessages = this.queuedMessages.filter((message) => message.id !== id);
    this.uiMessages = this.uiMessages.filter((message) => message.id !== id);
    if (this.runningQueued?.id === id) {
      this.runningQueued = undefined;
    }
    this.post({ type: 'removeMessage', id });
    this.persist();
  }

  private takePendingUserMessage(): string | undefined {
    const next = this.queuedMessages.shift();
    if (!next) {
      return undefined;
    }
    this.runningQueued = { id: next.id, text: next.text, createdAt: next.createdAt };
    const uiMessage = this.uiMessages.find((message) => message.id === next.id);
    if (uiMessage) {
      uiMessage.queued = false;
    }
    this.post({ type: 'unqueueMessage', id: next.id });
    return next.text;
  }

  private async compactNow(): Promise<void> {
    if (this.phase === 'planning' || this.phase === 'executing') {
      this.addNotice('Cannot compact while a task is running.');
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }
    const messages = [{ role: 'system' as const, content: 'compact' }, ...this.conversation];
    const recentStart = chooseRecentStart(messages, PRESERVE_RECENT_TOKENS);
    if (recentStart <= 2) {
      this.addNotice('Nothing to compact yet.');
      return;
    }
    try {
      const summary = await summarizeMessages(
        provider,
        getConfig().model,
        messages.slice(2, recentStart),
        new AbortController().signal,
      );
      if (!summary) {
        this.addNotice('Compaction produced no summary.');
        return;
      }
      const recent = this.conversation.slice(recentStart - 2);
      this.conversation = [
        { role: 'assistant', content: `[Summary of earlier conversation]\n\n${summary}` },
        ...recent,
      ];
      this.compressionBlocks = [];
      this.lastExactUsage = undefined;
      this.addNotice('Conversation compacted.');
      this.reportUsage(estimateTokens([{ role: 'system', content: '' }, ...this.conversation]));
    } catch (error) {
      this.addError(`Compaction failed: ${errorMessage(error)}`);
    }
  }

  private async compressContext(focus?: string): Promise<string> {
    if (this.compressionsThisTurn >= 1) {
      return 'Error: compress_context can be called at most once per turn.';
    }
    this.compressionsThisTurn += 1;
    const active = this.compressionBlocks.filter((block) => block.active);
    const last = active.length > 0 ? active[active.length - 1] : undefined;
    const startIndex = last ? last.endIndex : 0;
    const recentStart = chooseRecentStart(this.conversation, PRESERVE_RECENT_TOKENS);
    const endIndex = Math.min(recentStart, this.conversation.length);
    const foldable = endIndex - startIndex;
    if (foldable < MIN_COMPRESS_MESSAGES) {
      return `Error: only ${foldable} earlier message${foldable === 1 ? '' : 's'} can be folded; at least ${MIN_COMPRESS_MESSAGES} are needed. Finish more of the earlier work first.`;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return 'Error: no provider is available for context compression.';
    }
    try {
      const summary = await summarizeMessages(
        provider,
        getConfig().model,
        this.conversation.slice(startIndex, endIndex),
        this.abortController?.signal ?? new AbortController().signal,
        focus,
      );
      if (!summary) {
        return 'Error: context compression produced no summary.';
      }
      this.compressionBlocks.push({ id: randomId('cmp'), startIndex, endIndex, summary, active: true });
      return `Compressed ${foldable} earlier messages into a summary.`;
    } catch (error) {
      return `Error: ${errorMessage(error)}`;
    }
  }

  private projectedConversation(): ChatMessage[] {
    return projectCompressedMessages(this.conversation, this.compressionBlocks);
  }

  private async editMessage(id: string, text: string, restoreWorkspace: boolean): Promise<void> {
    if (this.phase === 'planning' || this.phase === 'executing') {
      this.addNotice('Cannot edit messages while a task is running.');
      return;
    }
    const index = this.uiMessages.findIndex((message) => message.id === id);
    if (index === -1 || this.uiMessages[index].role !== 'user') {
      return;
    }
    const edited = text.trim();
    if (!edited) {
      return;
    }
    const original = this.uiMessages[index];
    if (restoreWorkspace && original.checkpointId) {
      await this.revertToCheckpoint(original.checkpointId);
    }
    this.uiMessages = this.uiMessages.slice(0, index);
    this.conversation = this.uiMessages
      .filter((message) => message.role === 'user' || (message.role === 'assistant' && message.text && !message.kind))
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.text }));
    this.compressionBlocks = [];
    this.plan = null;
    this.todos = [];
    this.planVersion = 0;
    this.post({ type: 'plan', plan: null });
    this.post({ type: 'todos', todos: [] });
    this.persist();
    this.pushState();
    await this.handleSend(edited, original.attachment ? this.selection ?? undefined : undefined);
  }

  newSession(): void {
    this.stop();
    void (async () => {
      await this.persistNow();
      this.resetSessionState();
      await this.persistNow();
      this.post({
        type: 'usage',
        tokens: 0,
        limit: this.effectiveContextLimit(),
        reserved: this.reservedOutputTokens(),
      });
      this.post({ type: 'todos', todos: [] });
      this.post({ type: 'plan', plan: null });
      this.setPhase(this.diffManager.hasPendingChanges() ? 'review' : 'idle');
      this.pushState();
      this.postSessions();
    })();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    clearTimeout(this.persistTimer);
    void this.store.save(this.snapshotSession()).catch(() => undefined);
    this.browser?.dispose();
    this.mcp.dispose();
    this.background.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  async openMultiDiff(): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      return;
    }
    const summaries = this.diffManager.getChangeSummaries().filter((summary) => !summary.isDeleted);
    if (summaries.length === 0) {
      return;
    }
    const resources: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = summaries.map((summary) => {
      const modified = vscode.Uri.file(path.join(root, summary.path));
      return [modified, OriginalContentProvider.uriFor(summary.path), modified];
    });
    try {
      await vscode.commands.executeCommand('vscode.changes', 'Dev-First changes', resources);
    } catch {
      this.addNotice('Could not open the diff view.');
    }
  }

  async summarizeReview(): Promise<void> {
    await this.runReview((files) => buildReviewSummaryPrompt(files));
  }

  async reviewAcrossFiles(): Promise<void> {
    await this.runReview((files) => buildCrossFileReviewPrompt(files));
  }

  async explainCodebase(): Promise<void> {
    if (this.phase === 'planning' || this.phase === 'executing') {
      this.addNotice('Wait for the current task to finish before asking for an explanation.');
      return;
    }
    const topic = await vscode.window.showInputBox({
      prompt: 'What should I explain about this codebase?',
      placeHolder: 'how authentication works',
      ignoreFocusOut: true,
    });
    if (!topic?.trim()) {
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }
    const files = await this.collectExplainFiles(topic.trim());
    if (files.length === 0) {
      this.addNotice('No indexed files matched that topic. Open some files or build the semantic index first.');
      return;
    }
    const prompt = buildExplainCodebasePrompt(topic.trim(), files);
    try {
      let text = '';
      let retried = false;
      for await (const event of chatWithRetry(
        provider,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        {
          model: getConfig().model,
          maxTokens: 2500,
          temperature: 0.2,
          signal: new AbortController().signal,
        },
        {
          retryOnEmpty: true,
          onRetry: (attempt) => {
            retried = true;
            this.setStatus('retry', `Retrying attempt ${attempt}…`);
          },
        },
      )) {
        if (event.type === 'text') {
          text += event.text;
        }
      }
      if (retried) {
        this.setStatus('retry', '', undefined, true);
      }
      const result = text.trim();
      if (!result) {
        this.addNotice('The explanation produced no output.');
        return;
      }
      this.addAssistantMessage(result);
    } catch (error) {
      this.setStatus('retry', '', undefined, true);
      this.addError(`Explanation failed: ${errorMessage(error)}`);
    }
  }

  private async collectExplainFiles(topic: string): Promise<ExplainCodebaseFile[]> {
    const index = this.getSemanticIndex();
    if (index) {
      try {
        const results = await index.search(topic, EXPLAIN_CODEBASE_MAX_FILES * 2);
        const byPath = new Map<string, ExplainCodebaseFile>();
        for (const result of results) {
          const existing = byPath.get(result.path);
          if (existing) {
            existing.content = `${existing.content}\n${result.text}`;
            continue;
          }
          if (byPath.size >= EXPLAIN_CODEBASE_MAX_FILES) {
            continue;
          }
          byPath.set(result.path, {
            path: result.path,
            startLine: result.start,
            content: result.text,
          });
        }
        const files = [...byPath.values()];
        if (files.length > 0) {
          return files;
        }
      } catch {
        return this.explainFallbackFiles(topic);
      }
    }
    return this.explainFallbackFiles(topic);
  }

  private async explainFallbackFiles(topic: string): Promise<ExplainCodebaseFile[]> {
    const root = workspaceRoot();
    if (!root) {
      return [];
    }
    const terms = relevanceTerms(topic);
    let paths: string[] = [];
    try {
      paths = await listWorkspaceFiles(root, { maxEntries: 2000 });
    } catch {
      return [];
    }
    const ranked = paths
      .map((relative) => {
        const lower = relative.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (lower.includes(term)) {
            score++;
          }
        }
        return { relative, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));
    const picked =
      ranked.length > 0
        ? ranked.slice(0, EXPLAIN_CODEBASE_MAX_FILES)
        : paths.slice(0, EXPLAIN_CODEBASE_MAX_FILES).map((relative) => ({ relative, score: 0 }));
    const files: ExplainCodebaseFile[] = [];
    for (const entry of picked) {
      try {
        const content = await fs.readFile(path.join(root, entry.relative), 'utf-8');
        if (content.includes('\u0000')) {
          continue;
        }
        files.push({ path: entry.relative, startLine: 1, content: content.slice(0, 12000) });
      } catch {
        continue;
      }
    }
    return files;
  }

  private async matchStoredConvention(plan: Plan): Promise<ReturnType<typeof matchConvention>> {
    const memory = await this.memory.read();
    const conventions = parseConventionsSection(memory);
    if (conventions.length === 0) {
      return undefined;
    }
    const text = [
      this.lastRequest,
      plan.title,
      plan.what,
      plan.how,
      plan.why,
      plan.tradeoff,
      ...(plan.steps ?? []),
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n');
    return matchConvention(conventions, text);
  }

  private async runReview(
    build: (files: ReviewFileDiff[]) => { system: string; user: string },
  ): Promise<void> {
    if (this.phase === 'planning' || this.phase === 'executing') {
      this.addNotice('Wait for the current task to finish before running a review.');
      return;
    }
    if (!this.hasReviewableChanges()) {
      return;
    }
    const files = this.collectReviewFiles();
    if (files.length === 0) {
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }
    const prompt = build(files);
    try {
      let text = '';
      let retried = false;
      for await (const event of chatWithRetry(
        provider,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        { model: getConfig().model, maxTokens: 1500, temperature: 0.2, signal: new AbortController().signal },
        {
          retryOnEmpty: true,
          onRetry: (attempt) => {
            retried = true;
            this.setStatus('retry', `Retrying attempt ${attempt}…`);
          },
        },
      )) {
        if (event.type === 'text') {
          text += event.text;
        }
      }
      if (retried) {
        this.setStatus('retry', '', undefined, true);
      }
      const result = text.trim();
      if (!result) {
        this.addNotice('The review produced no output.');
        return;
      }
      this.addAssistantMessage(result);
    } catch (error) {
      this.setStatus('retry', '', undefined, true);
      this.addError(`Review failed: ${errorMessage(error)}`);
    }
  }

  private hasReviewableChanges(): boolean {
    return this.diffManager.getChangeSummaries().filter((summary) => !summary.isDeleted).length > 0;
  }

  private collectReviewFiles(): ReviewFileDiff[] {
    return this.diffManager.getChangeSummaries().map((summary) => ({
      path: summary.path,
      additions: summary.additions,
      deletions: summary.deletions,
      isNew: summary.isNew,
      isDeleted: summary.isDeleted,
      blocks: this.diffManager
        .getPendingChanges(summary.path)
        .map((change) => ({ original: change.originalContent, updated: change.newContent })),
    }));
  }

  async buildSemanticIndex(): Promise<void> {
    const index = this.getSemanticIndex();
    if (!index) {
      void vscode.window.showInformationMessage(
        'Dev-First: enable devFirst.semanticIndex and use an embeddings-capable provider first.',
      );
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Dev-First: building semantic index…' },
      async () => {
        await index.ensureIndexed();
      },
    );
    const stats = index.stats();
    void vscode.window.showInformationMessage(
      `Dev-First: index ready — ${stats.files} files, ${stats.chunks} chunks.`,
    );
  }

  async clearSemanticIndex(): Promise<void> {
    const index = this.getSemanticIndex();
    index?.clear();
    await fs
      .rm(path.join(this.context.globalStorageUri.fsPath, 'semantic-index.json'), { force: true })
      .catch(() => undefined);
    void vscode.window.showInformationMessage('Dev-First: semantic index cleared.');
  }

  async showMcpStatus(): Promise<void> {
    await this.mcp.ensureLoaded(workspaceRoot());
    const tools = this.mcp.tools();
    void vscode.window.showInformationMessage(
      `MCP: ${this.mcp.status()} — ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`,
    );
  }

  async reloadMcp(): Promise<void> {
    this.mcp.dispose();
    await this.mcp.ensureLoaded(workspaceRoot());
  }

  async setModel(model: string): Promise<void> {
    await this.handleSetModel(model);
  }

  async refreshConnectionState(): Promise<void> {
    await this.refreshConnection();
  }

  async plannerToolDefs(): Promise<ToolDef[]> {
    const registry = await this.buildToolRegistry();
    return registry.planner;
  }

  readOnlyToolExecutor(): ((call: ToolCall) => Promise<string>) | undefined {
    return (call) => this.executePlannerTool(call);
  }

  private async handleSend(
    rawText: string,
    selection?: SelectionContext,
    quote?: string,
    images?: string[],
    pastes?: PastedContent[],
  ): Promise<void> {
    const text = rawText.trim();
    if (!text && !images?.length) {
      return;
    }
    const cappedImages = (images ?? []).slice(0, 4);
    const root = workspaceRoot();
    const materialized = await this.savePastesToFiles(text, pastes, root);
    if (this.phase === 'planning' || this.phase === 'executing') {
      const queued: UiMessage = {
        id: randomId('msg'),
        role: 'user',
        text,
        queued: true,
        images: cappedImages,
        ...(pastes?.length ? { pastes } : {}),
      };
      this.queuedMessages.push({
        id: queued.id,
        text: materialized,
        selection,
        quote,
        images: cappedImages,
        pastes,
        createdAt: Date.now(),
      });
      this.uiMessages.push(queued);
      this.post({ type: 'addMessage', message: queued });
      this.persist();
      return;
    }
    if (!root) {
      this.addNotice('Open a folder before sending a request.');
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }

    this.compressionsThisTurn = 0;
    this.lastExactUsage = undefined;

    let effective = materialized;
    if (effective.startsWith('/')) {
      const expansion = (await expandSlashCommand(root, effective)) ?? builtinCommand(effective);
      if (!expansion) {
        this.addNotice(
          `Unknown command ${effective.split(/\s/)[0]}. Add it as .dev-first/commands/<name>.md (use $ARGUMENTS for arguments).`,
        );
        return;
      }
      effective = expansion.expanded;
    }

    const config = getConfig();
    await this.knowledgeSource?.refreshKnowledge();
    const rules = await this.buildRules(root, text);
    const registry = await this.buildToolRegistry();
    await this.registry.load();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const registryInfo = this.registry.lookup(preset.provider, config.model);
    const catalogInfo = modelInfo(preset.id, config.model);
    const family = promptFamilyFor(preset.provider, config.model);

    const attachment: MessageAttachment | undefined = selection
      ? { path: selection.path, startLine: selection.startLine, endLine: selection.endLine }
      : undefined;
    const quotePrefix = quote?.trim() ? `[context] ${quote.trim()} [/context]\n\n` : '';
    let llmText = quotePrefix + (await this.expandSessionMentions(await this.expandFileMentions(effective, root)));
    if (selection) {
      llmText += formatSelectionAttachment(selection);
    }
    const editorContext = this.editorContext();
    if (editorContext) {
      llmText += editorContext;
    }

    if (this.plan && this.plan.status !== 'draft') {
      this.plan = null;
      this.post({ type: 'plan', plan: null });
      this.persist();
    }

    this.lastRequest = llmText;
    this.addUserMessage(effective, attachment, llmText, quote, cappedImages);
    this.setPhase('planning');

    const plannerReasoningSupported =
      Boolean(catalogInfo?.reasoning) || (registryInfo?.supportsReasoning ?? false) ||
      (this.selectedModelMetadata(preset.id, config.model, preset.provider).reasoningLevels?.length ?? 0) > 0;
    const planner = new PlannerService(provider, config.model, {
      maxSteps: config.plannerMaxSteps,
      tools: registry.planner,
      rules,
      family,
      reasoning: this.reasoningOptions(plannerReasoningSupported, preset.id),
      resolveReasoning: () => this.reasoningOptions(plannerReasoningSupported, preset.id),
      reasoningSwitch: this.reasoningSwitchEnabled(),
      workspaceRoot: root,
    });
    this.abortController = new AbortController();

    try {
      const result = await planner.plan(
        this.projectedConversation(),
        this.plan,
        this.planVersion + 1,
        {
          onTextDelta: (delta) => this.appendStreamingText(delta),
          onReasoningDelta: (delta) => this.appendStreamingReasoning(delta),
          onToolActivity: (id, label, status, icon, meta) => this.upsertActivity(id, label, status, icon, meta),
          executeTool: (call) => this.executePlannerTool(call),
          setReasoning: (level) => this.setRunReasoning(level),
          compressContext: (focus) => this.compressContext(focus),
          onNotice: (notice) => this.addNotice(notice),
          onStatus: (id, text, tone, done) => this.setStatus(id, text, tone, done),
          onUsage: (tokens) => this.reportUsage(tokens),
          onUsageExact: (usage) => this.reportExactUsage(usage),
        },
        this.abortController.signal,
      );

      if (result.plan && isExplanationPlan(result.plan)) {
        const markdown = explanationToMarkdown(result.plan);
        const content = markdown || result.text.trim();
        if (content) {
          this.conversation.push({ role: 'assistant', content });
        }
        if (markdown) {
          this.addAssistantMessage(markdown);
        }
      } else if (result.plan) {
        if (this.isDirectRun(result.plan)) {
          this.addNotice(`Trivial change — running it now: ${result.plan.steps?.[0] ?? ''}`);
          this.endStreaming();
          this.setPhase('idle');
          await this.startExecution(result.plan, provider, false);
        } else {
          this.planVersion += 1;
          this.plan = result.plan;
          if (getConfig().memory) {
            const convention = await this.matchStoredConvention(result.plan);
            if (convention) {
              result.plan.convention = convention.statement;
            }
          }
          await this.savePlanFile(this.plan, this.lastRequest);
          this.post({ type: 'plan', plan: this.plan });
          this.persist();
          this.needsInputListener?.('a plan is ready for your approval');
        }
      } else if (result.dismissed) {
        const hadDraft = this.plan !== null;
        if (hadDraft) {
          this.discardPlan();
        }
        this.addNotice(hadDraft ? 'Draft plan discarded — nothing was changed.' : 'There is no draft plan to discard.');
      } else {
        if (result.text.trim()) {
          this.conversation.push({ role: 'assistant', content: result.text });
        }
        if (result.exhausted) {
          this.addNotice('The planner reached its step limit. Try rephrasing or splitting the request.');
        } else if (!result.text.trim()) {
          this.addNotice('The model returned an empty response. Check the provider settings and try again.');
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        this.markStreamingInterrupted();
        this.addNotice('Stopped.');
      } else {
        this.markStreamingInterrupted();
        this.addError(errorMessage(error));
      }
    } finally {
      this.endStreaming();
      this.setPhase(this.diffManager.hasPendingChanges() ? 'review' : 'idle');
      this.abortController = null;
      this.reasoningOverride = undefined;
      this.reasoningChanges = 0;
      this.runningQueued = undefined;
      this.processNextQueued();
    }
  }

  sendFromEditor(prompt: string): void {
    void this.handleSend(prompt);
  }

  private safePasteId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'paste';
  }

  private async savePastesToFiles(
    text: string,
    pastes: PastedContent[] | undefined,
    root: string | undefined,
  ): Promise<string> {
    if (!pastes?.length) {
      return text;
    }
    let result = text;
    for (const paste of pastes) {
      const safeId = this.safePasteId(paste.id);
      if (result.includes(`${safeId}.txt`)) {
        continue;
      }
      const name = `paste-${Date.now()}-${safeId}.txt`;
      if (root) {
        try {
          const dir = path.join(root, '.dev-first', 'pastes');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, name), paste.text, 'utf-8');
        } catch {}
      }
      result += `\n\nPasted content saved to .dev-first/pastes/${name} — read it if needed.`;
    }
    return result;
  }

  private async cleanupPasteFiles(): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      return;
    }
    const dir = path.join(root, '.dev-first', 'pastes');
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.txt'))
        .map(async (entry) => {
          try {
            const filePath = path.join(dir, entry);
            const stat = await fs.stat(filePath);
            if (stat.mtimeMs < cutoff) {
              await fs.rm(filePath, { force: true });
            }
          } catch {}
        }),
    );
  }

  prefillInput(text: string): void {
    this.post({ type: 'prefill', text });
  }

  private async learnMore(): Promise<void> {
    if (!getConfig().resources) {
      this.post({ type: 'learnMoreResult', chosen: [], alternatives: [], error: 'Resources are disabled in settings.' });
      return;
    }
    if (!this.plan) {
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }
    try {
      const result = await fetchLearnMore(
        provider,
        getConfig().model,
        this.plan,
        this.lastRequest,
        new AbortController().signal,
      );
      this.post({ type: 'learnMoreResult', ...result });
    } catch (error) {
      this.post({ type: 'learnMoreResult', chosen: [], alternatives: [], error: errorMessage(error) });
    }
  }

  private async openFileAt(rawPath: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      return;
    }
    const match = /^(.*?)(?::(\d+))?$/.exec(rawPath.trim());
    const relative = (match?.[1] ?? rawPath).replace(/^\.\//, '');
    try {
      const uri = vscode.Uri.file(path.join(root, relative));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
      const line = match?.[2] ? Math.max(0, Number(match[2]) - 1) : 0;
      const position = new vscode.Position(Math.min(line, document.lineCount - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch {
      this.addNotice(`Could not open ${rawPath}.`);
    }
  }

  private processNextQueued(): void {
    const next = this.queuedMessages.shift();
    if (!next) {
      return;
    }
    this.runningQueued = { id: next.id, text: next.text, createdAt: next.createdAt };
    const uiMessage = this.uiMessages.find((message) => message.id === next.id);
    if (uiMessage) {
      uiMessage.queued = false;
      this.post({ type: 'removeMessage', id: next.id });
      this.uiMessages = this.uiMessages.filter((message) => message.id !== next.id);
    }
    void this.handleSend(next.text, next.selection, next.quote, next.images, next.pastes);
  }

  private isDirectRun(plan: Plan): boolean {
    return plan.intent !== 'explanation' && plan.trivial === true && !plan.skippedSteps?.length;
  }

  private async handleApprove(): Promise<void> {
    if (!this.plan || this.plan.status === 'approved' || this.phase === 'executing' || this.phase === 'planning') {
      return;
    }
    const root = workspaceRoot();
    if (!root) {
      this.addNotice('Open a folder first.');
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }
    await this.startExecution(this.plan, provider, true);
  }

  private async startExecution(plan: Plan, provider: LLMProvider, approve: boolean): Promise<void> {
    const config = getConfig();
    const root = workspaceRoot() ?? process.cwd();
    const rules = await this.buildRules(root, this.lastRequest);
    const registry = await this.buildToolRegistry();
    await this.registry.load();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const registryInfo = this.registry.lookup(preset.provider, config.model);
    const catalogInfo = modelInfo(preset.id, config.model);
    const family = promptFamilyFor(preset.provider, config.model);
    const executorReasoningSupported =
      Boolean(catalogInfo?.reasoning) || (registryInfo?.supportsReasoning ?? false) ||
      (this.selectedModelMetadata(preset.id, config.model, preset.provider).reasoningLevels?.length ?? 0) > 0;
    const executorReasoning = this.reasoningOptions(executorReasoningSupported, preset.id);
    const reasoningLabel = executorReasoning
      ? executorReasoning.effort ?? (executorReasoning.enabled ? 'on' : 'off')
      : undefined;

    await this.createCheckpoint(plan.title ?? 'run');
    this.diffManager.setRunContext({
      id: this.lastUserMessageId ?? randomId('run'),
      label: this.lastRequest.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Task',
    });
    const now = Date.now();
    if (!this.currentRun) {
      this.currentRun = {
        id: randomId('run'),
        sessionId: this.sessionId,
        request: this.lastRequest,
        provider: preset.provider,
        model: config.model,
        status: 'approved',
        planVersion: this.planVersion,
        stepIndex: 0,
        completedSteps: [],
        operations: [],
        ...(reasoningLabel ? { reasoning: reasoningLabel } : {}),
        ...(this.lastCheckpointId ? { checkpointId: this.lastCheckpointId } : {}),
        workspaceHash: this.lastCheckpointId ?? (await this.hashWorkspaceFiles()),
        createdAt: now,
        updatedAt: now,
      };
    } else {
      if (!this.currentRun.checkpointId && this.lastCheckpointId) {
        this.currentRun.checkpointId = this.lastCheckpointId;
      }
      if (reasoningLabel && !this.currentRun.reasoning) {
        this.currentRun.reasoning = reasoningLabel;
      }
      this.currentRun.updatedAt = now;
    }
    await this.saveRunNow();
    if (approve) {
      plan.status = 'approved';
      this.post({ type: 'plan', plan });
      this.persist();
    }
    this.setPhase('executing');
    this.markRun('executing');
    this.abortController = new AbortController();

    const agent = new AgentService(provider, config.model, this.buildToolbox(), {
      maxSteps: config.maxSteps,
      tools: registry.executor,
      rules,
      family,
      autoCompact: config.autoCompact,
      contextLimitTokens: this.effectiveContextLimit(),
      parallelTools: config.parallelTools,
      reasoning: executorReasoning,
      resolveReasoning: () => this.reasoningOptions(executorReasoningSupported, preset.id),
      planFilePath: plan.filePath,
    });

    try {
      const result = await agent.run(plan, this.lastRequest, this.abortController.signal, {
        onTextDelta: (delta) => this.appendStreamingText(delta),
        onReasoningDelta: (delta) => this.appendStreamingReasoning(delta),
        onToolActivity: (id, label, status, icon, meta) => this.upsertActivity(id, label, status, icon, meta),
        requestTerminalApproval: (command, cwd) => this.requestApproval(command, cwd),
        requestExternalDirectoryApproval: (directory) => this.requestExternalAccess(directory),
        askUser: (request) => this.requestUserAnswer(request),
        setReasoning: (level) => this.setRunReasoning(level),
        compressContext: (focus) => this.compressContext(focus),
        onNotice: (notice) => this.addNotice(notice),
        onStatus: (id, text, tone, done) => this.setStatus(id, text, tone, done),
        onUsage: (tokens) => this.reportUsage(tokens),
        onUsageExact: (usage) => this.reportExactUsage(usage),
        onCompaction: (info) => this.addCompactionMessage(info),
        takePendingUserMessage: () => this.takePendingUserMessage(),
      });
      if (result.files?.length) {
        this.diffManager.setFileSummaries(result.files);
      }
      const planSnapshot = this.completePlan(plan);
      if (result.summary) {
        const runId = this.diffManager.getCurrentRunId();
        this.addCompletionMessage(result.summary, planSnapshot, runId, runId ? this.diffManager.runFiles(runId) : []);
      }
      if (result.reachedLimit) {
        this.addNotice(
          `Reached the step limit (${config.maxSteps}). Review the changes, then send a message to continue.`,
        );
      }
      this.markRun('completed');
    } catch (error) {
      if (isAbortError(error)) {
        this.markStreamingInterrupted();
        if (this.currentRun) {
          this.currentRun.pending = undefined;
        }
        if (this.currentRun && (this.currentRun.status === 'executing' || this.currentRun.status === 'waiting')) {
          this.markRun('interrupted');
        }
        this.addNotice('Stopped.');
      } else {
        this.markStreamingInterrupted();
        if (this.currentRun) {
          this.currentRun.pending = undefined;
        }
        this.markRun('failed');
        this.addError(errorMessage(error));
      }
    } finally {
      this.completePlan(plan);
      this.endStreaming();
      this.setPhase(this.diffManager.hasPendingChanges() ? 'review' : 'idle');
      this.abortController = null;
      this.reasoningOverride = undefined;
      this.reasoningChanges = 0;
      this.pushChanges();
      this.notifyFinished();
      if (this.hasReviewableChanges()) {
        this.post({
          type: 'suggestion',
          text: 'Changes are ready — run a review of them?',
          command: '/review',
        });
      }
      this.processNextQueued();
    }
  }

  private notifyFinished(): void {
    const config = getConfig();
    if (!config.notifyOnFinish) {
      return;
    }
    void vscode.window
      .showInformationMessage('Dev-First: task finished.', 'Show')
      .then((action) => {
        if (action === 'Show') {
          void vscode.commands.executeCommand('devFirst.chatView.focus');
        }
      });
  }

  private async buildRules(root: string, request = ''): Promise<string | undefined> {
    const parts: string[] = [];
    const projectRules = await loadProjectRules(root);
    if (projectRules) {
      parts.push(projectRules);
    }
    if (getConfig().memory) {
      const memory = await this.memory.read();
      if (memory.trim()) {
        parts.push(`# Project memory\n${memory.trim()}`);
      }
      if (request.trim()) {
        const relevant = relevantProjectModelBullets(parseProjectModelSection(memory), request);
        const model = formatRelevantProjectModel(relevant);
        if (model) {
          parts.push(model);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
  }

  private async expandSessionMentions(text: string): Promise<string> {
    const matches = [...text.matchAll(/@session:([^\n@]{2,80})/g)].map((match) => match[1].trim());
    if (matches.length === 0) {
      return text;
    }
    const sessions = await this.store.list();
    const parts: string[] = [];
    for (const title of matches.slice(0, 3)) {
      const summary = sessions.find((session) => session.title.toLowerCase() === title.toLowerCase());
      if (!summary) {
        continue;
      }
      const stored = await this.store.load(summary.id);
      if (!stored) {
        continue;
      }
      const digest = stored.messages
        .slice(-6)
        .map((message) => `${message.role}: ${message.text.slice(0, 400)}`)
        .join('\n');
      parts.push(`Context — earlier session "${summary.title}":\n${digest}`);
    }
    return parts.length > 0 ? `${text}\n\n${parts.join('\n\n')}` : text;
  }

  private async expandFileMentions(text: string, root: string): Promise<string> {
    const matches = [...text.matchAll(/@([\w./-]{3,})/g)]
      .map((match) => match[1])
      .filter((candidate) => candidate.includes('/') || candidate.includes('.'));
    if (matches.length === 0) {
      return text;
    }
    const parts: string[] = [];
    let budget = 40_000;
    for (const relative of [...new Set(matches)].slice(0, 8)) {
      if (budget <= 0) {
        break;
      }
      const absolute = path.resolve(root, relative);
      const check = path.relative(root, absolute);
      if (check.startsWith('..') || path.isAbsolute(check)) {
        continue;
      }
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > 150_000) {
          continue;
        }
        const content = await fs.readFile(absolute, 'utf-8');
        if (content.includes('\u0000')) {
          continue;
        }
        const slice = content.slice(0, Math.min(8000, budget));
        budget -= slice.length;
        parts.push(`Context — @${relative}:\n\`\`\`\n${slice}\n\`\`\``);
      } catch {
        continue;
      }
    }
    return parts.length > 0 ? `${text}\n\n${parts.join('\n\n')}` : text;
  }

  private reasoningOptions(supported: boolean, presetId: string): ReasoningOptions | undefined {
    const config = getConfig();
    const levels = this.selectedModelMetadata(presetId, config.model, config.provider).reasoningLevels ?? [];
    const selected = this.selectedReasoningEffort(presetId, config.model, levels);
    const effort = this.reasoningOverride
      ? clampReasoningLevel(this.reasoningOverride, selected, levels)
      : selected;
    if (!supported || levels.length === 0) {
      return undefined;
    }
    const kind = adaptiveKind(presetId, config.model, modelInfo(presetId, config.model));
    const adaptive = kind ? { kind } : {};
    if (effort === 'off') {
      if (presetId === 'deepseek') return { enabled: false };
      return levels.includes('off') ? { enabled: true, effort: 'off', ...adaptive } : undefined;
    }
    if (effort === 'on') {
      return presetId === 'deepseek' ? { enabled: true } : { enabled: true, effort: 'on', ...adaptive };
    }
    return { enabled: true, effort, ...adaptive };
  }

  private setRunReasoning(level: string): string {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const metadata = this.selectedModelMetadata(preset.id, config.model, preset.provider);
    const levels = metadata.reasoningLevels ?? [];
    const requested = level.trim();
    if (levels.length === 0) {
      return 'Error: the selected model does not support reasoning levels.';
    }
    if (!requested || !levels.includes(requested)) {
      return `Error: invalid reasoning level "${requested}". Valid levels: ${levels.join(', ')}.`;
    }
    if (this.reasoningChanges >= 5) {
      return 'Error: reasoning effort can change at most 5 times per run.';
    }
    const selected = this.selectedReasoningEffort(preset.id, config.model, levels, metadata.reasoningDefault);
    const applied = clampReasoningLevel(requested, selected, levels);
    this.reasoningOverride = requested;
    this.reasoningChanges += 1;
    let result = `Reasoning effort set to ${applied} for this run.`;
    if (applied !== requested) {
      result += ` ${requested} is above the selected ${selected}.`;
    }
    return result;
  }

  private reasoningSwitchEnabled(): boolean {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const metadata = this.selectedModelMetadata(preset.id, config.model, preset.provider);
    const levels = metadata.reasoningLevels ?? [];
    if (levels.length >= 2) {
      return true;
    }
    if (levels.length === 0) {
      return false;
    }
    const selected = this.selectedReasoningEffort(preset.id, config.model, levels, metadata.reasoningDefault);
    return levels.some((level) => level !== selected);
  }

  private editorContext(): string | undefined {
    const editors = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.scheme === 'file');
    if (editors.length === 0) {
      return undefined;
    }
    const lines = editors.slice(0, 10).map((editor) => {
      const relative = vscode.workspace.asRelativePath(editor.document.uri);
      const selection = editor.selection.isEmpty
        ? ''
        : ` (selection lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1})`;
      return `- ${relative}${selection}`;
    });
    return `\n\nEditor context — files open in the editor:\n${lines.join('\n')}`;
  }

  private appendStreamingReasoning(delta: string): void {
    const message = this.ensureStreamingMessage();
    message.reasoning = appendDelta(message.reasoning ?? '', delta);
    this.post({ type: 'reasoningDelta', id: message.id, text: delta });
  }

  private async createCheckpoint(title: string): Promise<void> {
    try {
      const checkpointId = await this.checkpoints.snapshot(title);
      this.lastCheckpointId = checkpointId;
      if (this.currentRun && checkpointId && !this.currentRun.checkpointId) {
        this.currentRun.checkpointId = checkpointId;
      }
      if (!checkpointId || !this.lastUserMessageId) {
        return;
      }
      const message = this.uiMessages.find((candidate) => candidate.id === this.lastUserMessageId);
      if (message) {
        message.checkpointId = checkpointId;
        this.post({ type: 'checkpoint', messageId: message.id, checkpointId });
        this.persist();
      }
    } catch {
      // checkpoints are best effort
    }
  }

  private async revertToCheckpoint(checkpointId: string): Promise<void> {
    const files = this.diffManager.getChangeSummaries().map((change) => ({
      path: change.path,
      additions: change.additions,
      deletions: change.deletions,
    }));
    this.redoCheckpointId = await this.checkpoints.snapshot('redo point');
    const result = await this.checkpoints.restore(checkpointId);
    this.diffManager.acceptAllChanges();
    this.addNotice(result);
    this.post({ type: 'redoState', canRedo: Boolean(this.redoCheckpointId), files });
  }

  private async redoRevert(): Promise<void> {
    if (!this.redoCheckpointId) {
      return;
    }
    const redoId = this.redoCheckpointId;
    this.redoCheckpointId = undefined;
    const result = await this.checkpoints.restore(redoId);
    this.addNotice(result);
    this.post({ type: 'redoState', canRedo: false });
  }

  private async buildToolRegistry(): Promise<{ planner: ToolDef[]; executor: ToolDef[] }> {
    const root = workspaceRoot();
    const skills = await listSkills(root);
    const skillNames = skills.map((skill) => skill.name);
    const semanticSearch = Boolean(this.getSemanticIndex());
    const memory = getConfig().memory;
    await this.mcp.ensureLoaded(root);
    const mcpTools = this.mcp.tools();
    const reasoningSwitch = this.reasoningSwitchEnabled();
    return {
      planner: plannerTools({ skills: skillNames, semanticSearch, memory }),
      executor: executionTools({ skills: skillNames, semanticSearch, memory, mcpTools, reasoningSwitch, task: true }),
    };
  }

  private getSemanticIndex(): SemanticIndex | undefined {
    const config = getConfig();
    if (!config.semanticIndex) {
      return undefined;
    }
    if (!this.semanticIndex) {
      const embed =
        config.embeddingsProvider === 'api'
          ? async (texts: string[]) => {
              const provider = await this.buildProvider();
              if (!provider) {
                throw new Error('No LLM provider configured for embeddings.');
              }
              return provider.embed(texts, getConfig().embeddingsModel);
            }
          : (texts: string[]) => this.getLocalEmbedder().embed(texts);
      this.semanticIndex = new SemanticIndex({
        root: workspaceRoot() ?? process.cwd(),
        storageFile: path.join(this.context.globalStorageUri.fsPath, 'semantic-index.json'),
        embed,
      });
    }
    return this.semanticIndex;
  }

  private getLocalEmbedder(): LocalEmbedder {
    if (!this.localEmbedder) {
      this.localEmbedder = new LocalEmbedder(this.context.extensionUri.fsPath);
    }
    return this.localEmbedder;
  }

  private getBrowser(): BrowserSession | undefined {
    if (!this.browser) {
      const config = getConfig();
      this.browser = new BrowserSession(config.browserPort, {
        autoLaunch: config.browserAutoLaunch,
        profileDir: path.join(this.context.globalStorageUri.fsPath, 'browser-profile'),
      });
      const run = this.currentRun;
      if (run) {
        run.browser = { port: config.browserPort };
        void this.saveRunNow();
      }
    }
    return this.browser;
  }

  private async buildProvider(): Promise<LLMProvider | undefined> {
    const active = await activeProvider(this.context);
    if (active) {
      return active.provider;
    }
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    this.connectionError = `No API key for ${preset.label}.`;
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.connectionNoticeId = this.addNotice(connectionNotice(preset), 'openSettings').id;
    return undefined;
  }

  private buildToolbox(allowTask = true): ToolBox {
    const config = getConfig();
    const controller = this;
    class JournalToolBox extends ToolBox {
      async execute(name: string, argsJson: string, context: ToolExecutionContext): Promise<string> {
        const operationId = await controller.beginRunOperation(name, argsJson);
        try {
          const result = await super.execute(name, argsJson, context);
          controller.finishRunOperation(operationId, !result.startsWith('Error:'));
          return result;
        } catch (error) {
          controller.finishRunOperation(operationId, false);
          throw error;
        }
      }
    }
    return new JournalToolBox({
      root: workspaceRoot() ?? process.cwd(),
      diffManager: this.diffManager,
      terminalTimeoutSeconds: config.terminalTimeout,
      autoApproveTerminal: config.autoApproveTerminal,
      autoApproveEdits: config.autoApproveEdits,
      safeCommandsOnly: config.safeCommandsOnly,
      yolo: config.yolo,
      autoApproveMcp: config.autoApproveMcp,
      checkDiagnostics: config.checkDiagnostics,
      sandbox: config.sandbox,
      onTodos: (todos) => this.updateTodos(todos),
      semanticIndex: this.getSemanticIndex(),
      mcp: this.mcp,
      browser: this.getBrowser(),
      memory: config.memory ? this.memory : undefined,
      backgroundProcesses: this.background,
      ...(allowTask ? { runTask: (request, signal) => this.runTask(request, signal) } : {}),
      approvalMemory: this.approvalMemory,
      externalDirectories: this.externalDirectories,
    });
  }

  private async runTask(
    request: { description: string; prompt: string; subagentType?: string },
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.subagentDepth >= 1) {
      return 'Error: subagents cannot start further subagents.';
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return 'Error: no provider is available for the subagent.';
    }
    const config = getConfig();
    const root = workspaceRoot() ?? process.cwd();
    const rules = await this.buildRules(root, request.prompt);
    const family = promptFamilyFor(config.provider, config.model);
    this.subagentDepth += 1;
    try {
      return await runSubagent(request, {
        provider,
        model: config.model,
        toolbox: this.buildToolbox(false),
        tools: subagentTools({ semanticSearch: Boolean(this.getSemanticIndex()) }),
        rules,
        family,
        signal: signal ?? this.abortController?.signal ?? new AbortController().signal,
      });
    } finally {
      this.subagentDepth -= 1;
    }
  }

  private async requestExternalAccess(directory: string): Promise<boolean> {
    const decision = await this.requestApproval(`Access files outside the workspace: ${directory}`, directory);
    return decision !== 'deny';
  }

  private executePlannerTool(call: ToolCall): Promise<string> {
    return this.buildToolbox(false).execute(call.name, call.arguments, {
      requestTerminalApproval: () => Promise.resolve('deny' as TerminalApprovalDecision),
      requestExternalDirectoryApproval: () => Promise.resolve(false),
      askUser: (request) => this.requestUserAnswer(request),
      signal: this.abortController?.signal,
      planning: true,
    });
  }

  private requestApproval(command: string, cwd: string): Promise<TerminalApprovalDecision> {
    const id = randomId('term');
    this.currentApproval = { id, command, cwd };
    this.setRunPending({
      id,
      kind: 'terminal',
      prompt: command,
      command,
      cwd,
      createdAt: Date.now(),
      ...(this.activeStepLabel() ? { step: this.activeStepLabel() as string } : {}),
    });
    this.needsInputListener?.('a command is waiting for Allow or Deny');
    this.post({ type: 'terminalApproval', request: this.currentApproval });
    return new Promise<TerminalApprovalDecision>((resolve) => {
      this.pendingApprovals.set(id, resolve);
    });
  }

  private resolveApproval(id: string, decision: TerminalApprovalDecision): void {
    const resolve = this.pendingApprovals.get(id);
    if (!resolve) {
      return;
    }
    this.pendingApprovals.delete(id);
    this.currentApproval = null;
    this.clearRunPending();
    this.post({ type: 'terminalApproval', request: null });
    resolve(decision);
  }

  private cancelPendingApprovals(): void {
    for (const resolve of this.pendingApprovals.values()) {
      resolve('deny');
    }
    this.pendingApprovals.clear();
    if (this.currentApproval) {
      this.currentApproval = null;
      this.clearRunPending();
      this.post({ type: 'terminalApproval', request: null });
    }
  }

  private async openChange(filePath: string, changeId?: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      return;
    }
    const uri = vscode.Uri.file(path.join(root, filePath));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
    const changes = this.diffManager.getPendingChanges(filePath);
    const change = (changeId ? changes.find((candidate) => candidate.id === changeId) : undefined) ?? changes[0];
    const startLine = Math.max(0, Math.min(change?.startLine ?? 0, document.lineCount - 1));
    const endLine = Math.max(startLine, Math.min(change?.endLine ?? startLine, document.lineCount - 1));
    const range = new vscode.Range(
      startLine,
      0,
      endLine,
      document.lineAt(endLine).text.length,
    );
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    this.diffManager.forceRefreshDecorations();
  }

  private async openFileDiff(filePath: string, runId: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      return;
    }
    if (!this.diffManager.hasDiffContent(runId, filePath)) {
      const run = await this.loadAnyRun(runId);
      const entry = run?.changedFiles?.find((file) => file.path === filePath);
      if (!run?.checkpointId || !entry) {
        void vscode.window.setStatusBarMessage('Dev-First: diff no longer available', 3000);
        return;
      }
      const left =
        entry.status === 'added'
          ? OriginalContentProvider.emptyUri(filePath)
          : OriginalContentProvider.checkpointUriFor(filePath, run.checkpointId);
      const right =
        entry.status === 'deleted'
          ? OriginalContentProvider.emptyUri(filePath)
          : vscode.Uri.file(path.join(root, filePath));
      await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(filePath)} (Dev-First)`);
      return;
    }
    const status = this.diffManager.runFiles(runId).find((file) => file.path === filePath)?.status ?? 'modified';
    const left = status === 'added'
      ? OriginalContentProvider.emptyUri(filePath)
      : OriginalContentProvider.uriFor(filePath, runId);
    const right = status === 'deleted'
      ? OriginalContentProvider.emptyUri(filePath)
      : vscode.Uri.file(path.join(root, filePath));
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(filePath)} (Dev-First)`);
  }

  private async explainChange(filePath: string): Promise<void> {
    if (this.phase === 'planning' || this.phase === 'executing') {
      this.addNotice('Wait for the current task to finish before asking for an explanation.');
      return;
    }
    await this.handleSend(`Explain the pending changes to ${filePath}: what changed and why.`);
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.post({ type: 'phase', phase });
    this.phaseListener?.(phase);
  }

  setPhaseListener(listener: (phase: Phase) => void): void {
    this.phaseListener = listener;
  }

  setErrorListener(listener: (message: string) => void): void {
    this.errorListener = listener;
  }

  setNeedsInputListener(listener: (message: string) => void): void {
    this.needsInputListener = listener;
  }

  setConnectionListener(listener: (connected: boolean) => void): void {
    this.connectionListener = listener;
  }

  setKnowledgeSource(source: { refreshKnowledge(): Promise<void> }): void {
    this.knowledgeSource = source;
  }

  async exportTranscript(): Promise<void> {
    const root = workspaceRoot();
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(root ?? '', `dev-first-transcript-${stamp}.md`)),
      filters: { Markdown: ['md'] },
    });
    if (!target) {
      return;
    }
    const title = this.plan?.title || this.lastRequest || 'Dev-First session';
    await vscode.workspace.fs.writeFile(target, Buffer.from(buildTranscript(this.uiMessages, title, now), 'utf8'));
    this.addNotice(`Transcript exported to ${vscode.workspace.asRelativePath(target)}.`);
  }

  private async enhancePrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }
    try {
      let enhanced = '';
      for await (const event of provider.chat(
        [
          {
            role: 'system',
            content:
              'Rewrite the developer request as a clear, specific instruction for a coding agent. Keep the original meaning and intent. Output ONLY the rewritten request, no preamble, no quotes.',
          },
          { role: 'user', content: trimmed },
        ],
        { model: getConfig().model, maxTokens: 512, temperature: 0.3 },
      )) {
        if (event.type === 'text') {
          enhanced += event.text;
        }
      }
      const result = enhanced.trim();
      if (result) {
        this.post({ type: 'enhancedPrompt', text: result });
      } else {
        this.post({ type: 'enhancedPrompt', text: trimmed, error: 'No rewrite produced.' });
      }
    } catch (error) {
      this.post({ type: 'enhancedPrompt', text: trimmed, error: errorMessage(error) });
    }
  }

  private modelDetails(presetId: string): Record<string, ModelMetadata> {
    return this.context.globalState.get<Record<string, ModelMetadata>>(`devFirst.modelDetails.${presetId}`) ?? {};
  }

  private async storeModelDetails(presetId: string, details: Record<string, ModelMetadata>): Promise<void> {
    await this.context.globalState.update(`devFirst.modelDetails.${presetId}`, details);
  }

  private selectedModelMetadata(presetId: string, modelId: string, providerId: string): ModelMetadata {
    const live = this.modelDetails(presetId)[modelId];
    const catalog = modelInfo(presetId, modelId);
    const registry = this.registry.lookup(providerId, modelId);
    const catalogVisionKnown = Array.isArray(catalog?.capabilities);
    const vision = live?.supportsVision
      ?? (catalogVisionKnown ? catalog!.capabilities!.includes('vision') : registry?.supportsVision);
    const reasoningLevels = live?.reasoningLevels ?? reasoningLevelsFor(presetId, modelId);
    return {
      id: modelId,
      ...(live?.name ? { name: live.name } : {}),
      ...(vision !== undefined ? { supportsVision: vision } : {}),
      ...(reasoningLevels.length ? { reasoningLevels } : {}),
      ...(live?.reasoningDefault ? { reasoningDefault: live.reasoningDefault } : {}),
    };
  }

  private selectedReasoningEffort(presetId: string, modelId: string, levels: string[], declaredDefault?: string): string {
    const modelKey = `devFirst.reasoning.${encodeURIComponent(presetId)}.${encodeURIComponent(modelId)}`;
    const saved = this.context.globalState.get<string>(modelKey);
    if (saved && levels.includes(saved)) return saved;
    if (declaredDefault && levels.includes(declaredDefault)) return declaredDefault;
    const legacy = getConfig().reasoningEffort;
    if (levels.includes(legacy)) return legacy;
    return levels.includes('medium') ? 'medium' : levels[0] ?? '';
  }

  private async setReasoningEffort(presetId: string, modelId: string, value: string): Promise<void> {
    const preset = findPreset(presetId);
    if (!preset || presetId !== getConfig().preset || modelId !== getConfig().model) return;
    const levels = this.selectedModelMetadata(presetId, modelId, preset.provider).reasoningLevels ?? [];
    if (!levels.includes(value)) return;
    const key = `devFirst.reasoning.${encodeURIComponent(presetId)}.${encodeURIComponent(modelId)}`;
    await this.context.globalState.update(key, value);
    this.pushState();
  }

  private postSettings(): void {
    this.post({
      type: 'settings',
      values: { ...getConfig() } as unknown as Record<string, unknown>,
      version: String((this.context.extension as { packageJson?: { version?: string } }).packageJson?.version ?? '0.1.0'),
    });
  }

  private async applySetting(key: string, value: unknown): Promise<void> {
    if (!SETTING_KEYS.has(key)) {
      return;
    }
    await vscode.workspace.getConfiguration('devFirst').update(key, value, vscode.ConfigurationTarget.Global);
    this.postSettings();
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.pushState();
  }

  private pushChanges(): void {
    this.post({
      type: 'changes',
      changes: this.diffManager.getChangeSummaries(),
      currentRunId: this.diffManager.getCurrentRunId(),
    });
  }

  private updateTodos(todos: TodoItem[]): void {
    const previous = this.todos;
    this.todos = mergeTodoCheckpoints(previous, todos);
    this.post({ type: 'todos', todos: this.todos });
    this.persist();
    this.recordRunProgress();
    for (const index of findNewlyStartedTodos(previous, this.todos)) {
      void this.snapshotTodoStep(index);
    }
  }

  private async snapshotTodoStep(index: number): Promise<void> {
    try {
      const todo = this.todos[index];
      if (!todo || todo.checkpointId) {
        return;
      }
      const checkpointId = await this.checkpoints.snapshot(`step: ${todo.text}`);
      if (!checkpointId || !this.todos[index]) {
        return;
      }
      this.todos[index].checkpointId = checkpointId;
      this.post({ type: 'todos', todos: this.todos });
      this.persist();
    } catch {
      // best effort
    }
  }

  private async savePlanFile(plan: Plan, request: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      return;
    }
    try {
      const dir = path.join(root, '.dev-first', 'plans');
      await fs.mkdir(dir, { recursive: true });
      const slug = planSlug(plan, request);
      const filePath = path.join(dir, `${this.sessionId}-${slug}.md`);
      const content = `# ${plan.title ?? 'Plan'}\n\n_${new Date().toISOString()} · session ${this.sessionId}_\n\n${planToText(plan)}\n`;
      await fs.writeFile(filePath, content, 'utf-8');
      plan.filePath = path.relative(root, filePath).split(path.sep).join('/');
    } catch {
      // best effort
    }
  }

  private discardPlan(): void {
    this.plan = null;
    this.post({ type: 'plan', plan: null });
    this.persist();
  }

  private completePlan(plan: Plan | null): UiMessage['planSnapshot'] | undefined {
    this.completeTodos();
    if (!plan) {
      return undefined;
    }
    const title = plan.title?.trim() || 'Plan';
    const steps = plan.steps && plan.steps.length > 0 ? [...plan.steps] : undefined;
    if (plan === this.plan) {
      plan.status = 'completed';
      this.post({ type: 'plan', plan });
      this.plan = null;
      this.post({ type: 'plan', plan: null });
      this.persist();
    }
    return { title, ...(steps ? { steps } : {}) };
  }

  private completeTodos(): void {
    if (this.todos.length === 0) {
      return;
    }
    this.todos = this.todos.map((todo) => ({ ...todo, status: 'done' as const }));
    this.post({ type: 'todos', todos: this.todos });
    this.todos = [];
    this.post({ type: 'todos', todos: [] });
    this.persist();
  }

  private async handleUpdatePlan(markdown: string): Promise<void> {
    if (!this.plan) {
      return;
    }
    const parsed = planFromText(markdown, this.plan.version);
    if (!parsed) {
      this.addNotice('Could not parse the edited plan — keep the WHAT/HOW/WHY/TRADEOFF/CONTEXT/PLAN labels.');
      return;
    }
    parsed.status = this.plan.status;
    parsed.filePath = this.plan.filePath;
    parsed.skippedSteps = this.plan.skippedSteps;
    parsed.title = this.plan.title;
    this.plan = parsed;
    await this.savePlanFile(this.plan, this.lastRequest);
    this.post({ type: 'plan', plan: this.plan });
    this.persist();
  }

  private async handleToggleStep(index: number): Promise<void> {
    if (!this.plan?.steps?.[index]) {
      return;
    }
    const skipped = new Set(this.plan.skippedSteps ?? []);
    if (skipped.has(index)) {
      skipped.delete(index);
    } else {
      skipped.add(index);
    }
    this.plan.skippedSteps = [...skipped].sort((a, b) => a - b);
    await this.savePlanFile(this.plan, this.lastRequest);
    this.post({ type: 'plan', plan: this.plan });
    this.persist();
  }

  private async openPlan(): Promise<void> {
    const root = workspaceRoot();
    if (!root || !this.plan?.filePath) {
      this.addNotice('No plan file yet.');
      return;
    }
    const uri = vscode.Uri.file(path.join(root, this.plan.filePath));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, vscode.ViewColumn.Active);
  }

  private async explainSection(key: string): Promise<void> {
    if (this.phase === 'planning' || this.phase === 'executing') {
      this.addNotice('Wait for the current task to finish before asking for an explanation.');
      return;
    }
    await this.handleSend(`Explain the ${key.toUpperCase()} section of the current plan in more depth.`);
  }

  private addUserMessage(
    text: string,
    attachment?: MessageAttachment,
    llmText?: string,
    quote?: string,
    images?: string[],
  ): void {
    const message: UiMessage = { id: randomId('msg'), role: 'user', text, attachment, quote, images };
    this.lastUserMessageId = message.id;
    if (this.sessionTitle === 'New session' || this.sessionTitle === 'Imported session') {
      this.sessionTitle = text.replace(/\s+/g, ' ').slice(0, 50) || 'New session';
      this.postSessions();
    }
    this.uiMessages.push(message);
    this.conversation.push({ role: 'user', content: llmText ?? text, images });
    this.post({ type: 'addMessage', message });
    this.persist();
  }

  private addAssistantMessage(text: string): void {
    const message: UiMessage = { id: randomId('msg'), role: 'assistant', text };
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    this.persist();
  }

  private addNotice(text: string, action?: UiMessage['action']): UiMessage {
    const message: UiMessage = { id: randomId('msg'), role: 'notice', text, action };
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    this.persist();
    return message;
  }

  private removeConnectionNotice(): void {
    const ids = new Set<string>();
    if (this.connectionNoticeId) {
      ids.add(this.connectionNoticeId);
    }
    for (const message of this.uiMessages) {
      if (message.action === 'openSettings') {
        ids.add(message.id);
      }
    }
    this.connectionNoticeId = undefined;
    if (ids.size === 0) {
      return;
    }
    this.uiMessages = this.uiMessages.filter((message) => !ids.has(message.id));
    for (const id of ids) {
      this.post({ type: 'removeMessage', id });
    }
    this.persist();
  }

  private addError(text: string): void {
    const message: UiMessage = { id: randomId('msg'), role: 'notice', kind: 'error', text };
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    this.persist();
    this.errorListener?.(text);
  }

  private addCompactionMessage(info: {
    tokensBefore: number;
    tokensAfter: number;
    messagesBefore: number;
    messagesAfter: number;
  }): void {
    this.lastExactUsage = undefined;
    const message: UiMessage = {
      id: randomId('msg'),
      role: 'assistant',
      kind: 'compaction',
      text: '',
      compaction: info,
    };
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    this.persist();
  }

  private addCompletionMessage(
    text: string,
    planSnapshot?: UiMessage['planSnapshot'],
    runId?: string,
    changedFiles?: UiMessage['changedFiles'],
  ): void {
    const { text: withoutFailure, failureConcept } = extractFailureConcept(text);
    const { text: body, takeaways } = extractTakeaways(withoutFailure);
    const message: UiMessage = {
      id: randomId('msg'),
      role: 'assistant',
      kind: 'completion',
      text: body,
      takeaways,
      failureConcept,
      checkpointId: this.lastCheckpointId,
      ...(planSnapshot ? { planSnapshot } : {}),
      ...(runId ? { runId } : {}),
      ...(changedFiles && changedFiles.length > 0 ? { changedFiles } : {}),
    };
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    this.persist();
  }

  private ensureStreamingMessage(): UiMessage {
    if (this.streamingMessageId) {
      const existing = this.uiMessages.find((message) => message.id === this.streamingMessageId);
      if (existing) {
        return existing;
      }
    }
    const message: UiMessage = {
      id: randomId('msg'),
      role: 'assistant',
      text: '',
      streaming: true,
      activities: [],
    };
    this.streamingMessageId = message.id;
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    return message;
  }

  private appendStreamingText(delta: string): void {
    const message = this.ensureStreamingMessage();
    message.text = appendDelta(message.text, delta);
    this.post({ type: 'assistantDelta', id: message.id, text: delta });
  }

  private setStatus(id: string, text: string, tone: 'progress' | 'error' = 'progress', done = false): void {
    if (done) {
      if (this.activeStatusId !== id) {
        return;
      }
      this.activeStatusId = undefined;
      this.post({ type: 'status', id, text: '', tone, done: true });
      return;
    }
    this.activeStatusId = id;
    this.post({ type: 'status', id, text, tone, done: false });
  }

  private upsertActivity(
    id: string,
    label: string,
    status: 'running' | 'done' | 'error',
    icon?: string,
    meta?: ActivityMeta,
  ): void {
    const message = this.ensureStreamingMessage();
    const activities = message.activities ?? (message.activities = []);
    const existing = activities.find((activity) => activity.id === id);
    if (existing) {
      existing.label = label;
      existing.status = status;
      existing.icon = icon ?? existing.icon;
      existing.detail = meta?.detail ?? existing.detail;
      existing.detailKind = meta?.detailKind ?? existing.detailKind;
      existing.exitCode = meta?.exitCode ?? existing.exitCode;
      existing.filePath = meta?.filePath ?? existing.filePath;
    } else {
      activities.push({ id, label, status, icon, ...meta });
    }
    this.post({
      type: 'activity',
      messageId: message.id,
      activity: { id, label, status, icon, ...meta },
    });
  }

  private resolvedModelInfo(): { catalog: CatalogModel | undefined; registry: ModelInfo | undefined } {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    return {
      catalog: modelInfo(preset.id, config.model),
      registry: this.registry.lookup(preset.provider, config.model),
    };
  }

  private effectiveContextLimit(): number {
    const { catalog, registry } = this.resolvedModelInfo();
    return catalog?.contextWindow || registry?.contextWindow || getConfig().contextLimitTokens;
  }

  private reservedOutputTokens(): number {
    const { catalog, registry } = this.resolvedModelInfo();
    const catalogMax = catalog?.maxOutput;
    if (catalogMax && catalogMax > 0) {
      return catalogMax;
    }
    const registryMax = registry?.maxOutput;
    if (registryMax && registryMax > 0) {
      return registryMax;
    }
    return 8192;
  }

  private exactUsageTotal(): number | undefined {
    return this.lastExactUsage ? usageTotal(this.lastExactUsage) : undefined;
  }

  private reportUsage(tokens: number): void {
    this.contextTokens = this.exactUsageTotal() ?? tokens;
    this.post({
      type: 'usage',
      tokens: this.contextTokens,
      limit: this.effectiveContextLimit(),
      reserved: this.reservedOutputTokens(),
    });
  }

  private reportExactUsage(usage: UsageTotals): void {
    this.lastExactUsage = usage;
    this.contextTokens = this.exactUsageTotal() ?? this.contextTokens;
    this.post({
      type: 'usage',
      tokens: this.contextTokens,
      limit: this.effectiveContextLimit(),
      reserved: this.reservedOutputTokens(),
    });
  }

  private endStreaming(): void {
    if (!this.streamingMessageId) {
      return;
    }
    const message = this.uiMessages.find((candidate) => candidate.id === this.streamingMessageId);
    if (message) {
      message.streaming = false;
    }
    this.post({ type: 'assistantDone', id: this.streamingMessageId });
    this.streamingMessageId = null;
    this.persist();
  }

  private queuedRecords(): QueuedPromptRecord[] {
    const records: QueuedPromptRecord[] = [];
    if (this.runningQueued) {
      records.push({
        id: this.runningQueued.id,
        text: this.runningQueued.text,
        status: 'running',
        createdAt: this.runningQueued.createdAt,
      });
    }
    for (const message of this.queuedMessages) {
      records.push({ id: message.id, text: message.text, status: 'queued', createdAt: message.createdAt });
    }
    return records;
  }

  private async saveRunNow(): Promise<void> {
    const run = this.currentRun;
    if (!run) {
      return;
    }
    await this.saveRun(run);
  }

  private refreshRunProcesses(): void {
    if (!this.currentRun) {
      return;
    }
    void this.saveRunNow();
  }

  private async saveRun(run: RunRecord): Promise<void> {
    if (run === this.currentRun) {
      const records = this.background.records();
      run.processes = records.length > 0 ? records : undefined;
    }
    run.updatedAt = Date.now();
    try {
      await this.runJournal.save(run);
    } catch {}
  }

  private markRun(status: RunStatus): void {
    const run = this.currentRun;
    if (!run) {
      return;
    }
    run.status = status;
    run.updatedAt = Date.now();
    void this.saveRun(run);
    if (status === 'interrupted') {
      this.recoveryRun = run;
    } else if (this.recoveryRun?.id === run.id) {
      this.recoveryRun = undefined;
      this.recoveryDrift = false;
    }
    if (status === 'completed' || status === 'stopped' || status === 'failed' || status === 'interrupted') {
      this.currentRun = undefined;
    }
  }

  private async beginRunOperation(tool: string, argsJson: string): Promise<string | undefined> {
    const run = this.currentRun;
    if (!run || (run.status !== 'executing' && run.status !== 'waiting')) {
      return undefined;
    }
    const operation = await buildRunOperation(tool, argsJson, workspaceRoot() ?? process.cwd());
    if (!operation) {
      return undefined;
    }
    run.operations = [...run.operations, operation].slice(-500);
    run.activeTool = tool;
    run.updatedAt = Date.now();
    void this.saveRunNow();
    return operation.id;
  }

  private finishRunOperation(id: string | undefined, ok: boolean): void {
    if (!id) {
      return;
    }
    const run = this.currentRun;
    if (!run) {
      return;
    }
    const operation = run.operations.find((candidate) => candidate.id === id);
    if (operation) {
      operation.status = ok ? 'succeeded' : 'failed';
      operation.finishedAt = Date.now();
      if (ok) {
        void this.captureOperationOutcome(run, operation);
      }
    }
    run.activeTool = undefined;
    run.updatedAt = Date.now();
    void this.saveRunNow();
  }

  private async captureOperationOutcome(run: RunRecord, operation: RunOperation): Promise<void> {
    const root = workspaceRoot() ?? process.cwd();
    if ((operation.tool === 'write_file' || operation.tool === 'edit_file') && operation.target) {
      const afterHash = await sha1File(absoluteWorkspacePath(root, operation.target));
      if (afterHash) {
        operation.afterHash = afterHash;
      }
      if (afterHash && afterHash !== operation.beforeHash) {
        run.changedFiles = upsertRunChangedFile(run.changedFiles, {
          path: operation.target,
          status: operation.beforeHash ? 'modified' : 'added',
        });
      }
    } else if (operation.tool === 'apply_patch') {
      const expectations = parseOperationExpectations(operation);
      if (expectations.length === 0) {
        return;
      }
      let changed = false;
      for (const entry of expectations) {
        const after = (await sha1File(absoluteWorkspacePath(root, entry.path))) ?? null;
        entry.after = after;
        entry.captured = true;
        if (entry.status === 'deleted' ? entry.before !== null && after === null : after !== null && after !== entry.before) {
          changed = true;
        }
      }
      operation.expected = serializeOperationExpectations(expectations);
      if (changed) {
        for (const entry of expectations) {
          run.changedFiles = upsertRunChangedFile(run.changedFiles, {
            path: entry.path,
            status: entry.status,
          });
        }
      }
    } else {
      return;
    }
    run.updatedAt = Date.now();
    await this.saveRun(run);
  }

  private setRunPending(pending: PendingDecisionRecord): void {
    const run = this.currentRun;
    if (!run) {
      return;
    }
    run.pending = pending;
    if (run.status === 'executing') {
      run.status = 'waiting';
    }
    run.updatedAt = Date.now();
    void this.saveRunNow();
  }

  private clearRunPending(): void {
    const run = this.currentRun;
    if (!run || !run.pending) {
      return;
    }
    run.pending = undefined;
    if (run.status === 'waiting') {
      run.status = 'executing';
    }
    run.updatedAt = Date.now();
    void this.saveRunNow();
  }

  private activeStepLabel(): string | undefined {
    const inProgress = this.todos.find((todo) => todo.status === 'in_progress');
    if (inProgress) {
      return inProgress.text;
    }
    const index = this.currentRun?.stepIndex ?? 0;
    return this.plan?.steps?.[index];
  }

  private recordRunProgress(): void {
    const run = this.currentRun;
    if (!run) {
      return;
    }
    const done = this.todos
      .map((todo, index) => (todo.status === 'done' ? index : -1))
      .filter((index) => index >= 0);
    run.completedSteps = [...new Set([...run.completedSteps, ...done])].sort((a, b) => a - b);
    const active = this.todos.findIndex((todo) => todo.status === 'in_progress' || todo.status === 'pending');
    run.stepIndex = active >= 0 ? active : this.todos.length;
    run.updatedAt = Date.now();
    void this.saveRunNow();
    this.enqueueStepHash(run);
  }

  private enqueueStepHash(run: RunRecord): void {
    this.stepHashChain = this.stepHashChain.then(async () => {
      const hash = await this.hashWorkspaceFiles();
      if (!hash || this.currentRun?.id !== run.id) {
        return;
      }
      run.stepHashes = appendStepHash(run.stepHashes, hash);
      await this.saveRun(run);
    });
  }

  private async hashWorkspaceFiles(): Promise<string> {
    try {
      const root = workspaceRoot() ?? process.cwd();
      return architectureFilesHash(await listWorkspaceFiles(root, { maxEntries: 5000 }));
    } catch {
      return '';
    }
  }

  private async currentWorkspaceHash(run: RunRecord): Promise<string> {
    if (run.checkpointId) {
      return run.checkpointId;
    }
    return this.hashWorkspaceFiles();
  }

  private async recoverRuns(): Promise<void> {
    let runs: RunRecord[] = [];
    try {
      runs = await this.runJournal.list();
    } catch {
      runs = [];
    }
    for (const run of runs) {
      if (run.status === 'executing' || run.status === 'waiting') {
        run.status = 'interrupted';
        run.updatedAt = Date.now();
        try {
          await this.runJournal.save(run);
        } catch {}
      }
    }
    await this.selectRecoveryRun(runs);
  }

  private async loadRecoveryRun(): Promise<void> {
    let runs: RunRecord[] = [];
    try {
      runs = await this.runJournal.list();
    } catch {
      runs = [];
    }
    await this.selectRecoveryRun(runs);
  }

  private async selectRecoveryRun(runs: RunRecord[]): Promise<void> {
    this.recoveryRun = runs
      .filter((run) => run.sessionId === this.sessionId && run.status === 'interrupted')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    this.recoveryDrift = false;
    const stepHashes = this.recoveryRun?.stepHashes;
    if (!stepHashes?.length) {
      return;
    }
    const current = await this.hashWorkspaceFiles();
    this.recoveryDrift = Boolean(current) && current !== stepHashes[stepHashes.length - 1];
  }

  private async verifyStartedOperations(run: RunRecord): Promise<string | undefined> {
    const root = workspaceRoot() ?? process.cwd();
    for (const operation of run.operations) {
      if (operation.status !== 'started') {
        continue;
      }
      const outcome = await this.operationRetryOutcome(operation, root);
      if (outcome === 'succeeded') {
        operation.status = 'succeeded';
        operation.finishedAt = Date.now();
        continue;
      }
      if (outcome === 'failed') {
        operation.status = 'failed';
        operation.finishedAt = Date.now();
        run.activeTool = undefined;
        continue;
      }
      const expectations = parseOperationExpectations(operation);
      if (expectations.length > 0) {
        return expectations.map((entry) => entry.path).join(', ');
      }
      return operation.target || operation.tool;
    }
    return undefined;
  }

  private async operationRetryOutcome(operation: RunOperation, root: string): Promise<'succeeded' | 'failed' | 'uncertain'> {
    const expectations = parseOperationExpectations(operation);
    if (expectations.length > 0) {
      let matchesAfter = expectations.every((entry) => entry.captured);
      let matchesBefore = true;
      for (const entry of expectations) {
        const current = (await sha1File(absoluteWorkspacePath(root, entry.path))) ?? null;
        if (current !== entry.after) {
          matchesAfter = false;
        }
        if (current !== entry.before) {
          matchesBefore = false;
        }
      }
      if (matchesAfter) {
        return 'succeeded';
      }
      return matchesBefore ? 'failed' : 'uncertain';
    }
    const currentHash =
      operation.target && FILE_EDIT_TOOLS.has(operation.tool)
        ? await sha1File(absoluteWorkspacePath(root, operation.target))
        : undefined;
    return classifyOperationRetry(operation, currentHash);
  }

  private async resumeRun(id: string, force?: boolean): Promise<void> {
    void force;
    const run = await this.runJournal.load(id);
    if (!run || run.status !== 'interrupted') {
      this.addNotice('That run cannot be resumed.');
      return;
    }
    const uncertainTarget = await this.verifyStartedOperations(run);
    if (uncertainTarget) {
      await this.saveRun(run);
      if (this.recoveryRun?.id === run.id) {
        this.recoveryRun = run;
      }
      this.addNotice(
        `Cannot resume safely: the workspace state for ${uncertainTarget} is uncertain. Review the changes, then roll back or discard this run.`,
      );
      this.pushState();
      return;
    }
    await this.saveRun(run);
    if (this.recoveryRun?.id === run.id) {
      this.recoveryRun = run;
    }
    if (!run.stepHashes?.length && run.workspaceHash !== (await this.currentWorkspaceHash(run))) {
      this.addNotice('The workspace changed since that run was interrupted. Start a new request instead.');
      return;
    }
    if (run.sessionId !== this.sessionId) {
      const stored = await this.store.load(run.sessionId);
      if (!stored) {
        this.addNotice('The session for that run no longer exists.');
        return;
      }
      this.applySession(stored);
      if (stored.plan) {
        this.plan = stored.plan;
      }
    }
    if (!this.plan || this.plan.status === 'completed') {
      this.addNotice('The plan for that run is no longer available.');
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }
    run.status = 'approved';
    run.activeTool = undefined;
    run.pending = undefined;
    run.updatedAt = Date.now();
    this.currentRun = run;
    this.recoveryRun = undefined;
    this.recoveryDrift = false;
    await this.saveRunNow();
    this.pushState();
    await this.startExecution(this.plan, provider, true);
  }

  private async discardRun(id: string): Promise<void> {
    await this.runJournal.remove(id);
    if (this.currentRun?.id === id) {
      this.currentRun = undefined;
    }
    if (this.recoveryRun?.id === id) {
      this.recoveryRun = undefined;
      this.recoveryDrift = false;
    }
    this.pushState();
  }

  private async rollbackRun(id: string): Promise<void> {
    const run = this.recoveryRun?.id === id ? this.recoveryRun : await this.runJournal.load(id);
    if (run?.checkpointId) {
      await this.revertToCheckpoint(run.checkpointId);
    }
    await this.discardRun(id);
  }

  private async loadAnyRun(runId: string): Promise<RunRecord | undefined> {
    if (this.currentRun?.id === runId) {
      return this.currentRun;
    }
    if (this.recoveryRun?.id === runId) {
      return this.recoveryRun;
    }
    return this.runJournal.load(runId);
  }

  private async isRecoveredRun(runId: string): Promise<boolean> {
    if (this.recoveryRun?.id === runId) {
      return true;
    }
    if (this.diffManager.hasDiffContent(runId)) {
      return false;
    }
    const run = await this.loadAnyRun(runId);
    return Boolean(run?.changedFiles?.length);
  }

  async getRunReview(runId: string): Promise<RunReviewFile[] | undefined> {
    const run = await this.loadAnyRun(runId);
    if (!run) {
      return undefined;
    }
    if (this.diffManager.hasDiffContent(runId)) {
      return this.diffManager.runFiles(runId).map((file) => ({
        path: file.path,
        status: file.status,
        originalUri: (
          file.status === 'added'
            ? OriginalContentProvider.emptyUri(file.path)
            : OriginalContentProvider.uriFor(file.path, runId)
        ).toString(),
      }));
    }
    const changed = run.changedFiles ?? [];
    return changed.map((file) => ({
      path: file.path,
      status: file.status,
      ...(run.checkpointId
        ? {
            originalUri: (
              file.status === 'added'
                ? OriginalContentProvider.emptyUri(file.path)
                : OriginalContentProvider.checkpointUriFor(file.path, run.checkpointId)
            ).toString(),
          }
        : {}),
    }));
  }

  private async openRunReview(runId: string): Promise<void> {
    const files = await this.getRunReview(runId);
    if (!files) {
      this.addNotice('That run review is no longer available.');
      return;
    }
    this.post({ type: 'runReview', runId, files });
  }

  private async acceptRunReview(runId: string): Promise<void> {
    const run = await this.loadAnyRun(runId);
    if (!run) {
      return;
    }
    run.changedFiles = undefined;
    run.updatedAt = Date.now();
    await this.saveRun(run);
    this.post({ type: 'runReview', runId, files: [] });
    this.pushState();
  }

  private async revertRunFile(filePath: string, runId?: string): Promise<void> {
    const run = runId ? await this.loadAnyRun(runId) : this.recoveryRun ?? this.currentRun;
    if (!run) {
      this.addNotice('No recovered run to revert in.');
      return;
    }
    const entry = run.changedFiles?.find((file) => file.path === filePath);
    if (!entry) {
      this.addNotice(`${filePath} is not part of this run review.`);
      return;
    }
    const root = workspaceRoot() ?? process.cwd();
    if (entry.status === 'added') {
      await fs.rm(absoluteWorkspacePath(root, filePath), { force: true }).catch(() => undefined);
    } else if (run.checkpointId) {
      const restored = await this.checkpoints.restoreFile(run.checkpointId, filePath);
      if (!restored) {
        this.addNotice(`Could not restore ${filePath} from the run checkpoint.`);
        return;
      }
    } else {
      await this.diffManager.revertWholeFile(filePath);
    }
    run.changedFiles = (run.changedFiles ?? []).filter((file) => file.path !== filePath);
    run.updatedAt = Date.now();
    await this.saveRun(run);
    this.post({
      type: 'runReview',
      runId: run.id,
      files: (run.changedFiles ?? []).map((file) => ({ path: file.path, status: file.status })),
    });
    this.pushState();
  }

  private async resolveRecoveredDecision(runId: string, approved: boolean): Promise<void> {
    const run = await this.loadAnyRun(runId);
    if (!run || run.status !== 'interrupted') {
      this.addNotice('That run decision is no longer available.');
      return;
    }
    const pending = run.pending;
    if (!pending) {
      this.addNotice('That decision is no longer pending.');
      return;
    }
    if (!approved) {
      run.pending = undefined;
      run.status = 'stopped';
      run.updatedAt = Date.now();
      await this.saveRun(run);
      if (this.currentRun?.id === run.id) {
        this.currentRun = undefined;
      }
      if (this.recoveryRun?.id === run.id) {
        this.recoveryRun = undefined;
        this.recoveryDrift = false;
      }
      this.pushState();
      return;
    }
    if (pending.kind === 'terminal') {
      const command = (pending.command ?? '').trim();
      const cwd = pending.cwd ?? '';
      const valid = validateRecoveredDecision(
        { kind: 'terminal', command },
        { cwdExists: Boolean(cwd) && existsSync(cwd) },
      );
      if (!valid) {
        this.addNotice('That command decision is no longer valid. Resume the run to approve it again.');
        return;
      }
      this.approvalMemory.remember(command);
    }
    for (const operation of run.operations) {
      if (operation.status === 'started' && operation.startedAt <= pending.createdAt) {
        operation.status = 'failed';
        operation.finishedAt = Date.now();
      }
    }
    run.activeTool = undefined;
    run.pending = undefined;
    run.updatedAt = Date.now();
    await this.saveRun(run);
    if (this.recoveryRun?.id === run.id) {
      this.recoveryRun = undefined;
      this.recoveryDrift = false;
    }
    this.pushState();
    await this.resumeRun(run.id);
  }

  private async stopRunProcess(runId: string, pid: number): Promise<void> {
    try {
      if (process.platform !== 'win32') {
        process.kill(-pid, 'SIGTERM');
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await this.forgetRunProcess(runId, pid);
  }

  private async forgetRunProcess(runId: string, pid: number): Promise<void> {
    const run = await this.loadAnyRun(runId);
    if (!run) {
      return;
    }
    const remaining = (run.processes ?? []).filter((entry) => entry.pid !== pid);
    run.processes = remaining.length > 0 ? remaining : undefined;
    await this.saveRun(run);
    this.pushState();
  }

  private async forgetBrowser(runId: string): Promise<void> {
    const run = await this.loadAnyRun(runId);
    if (!run) {
      return;
    }
    run.browser = undefined;
    await this.saveRun(run);
    this.pushState();
  }

  private markStreamingInterrupted(): void {
    if (!this.streamingMessageId) {
      return;
    }
    const message = this.uiMessages.find((candidate) => candidate.id === this.streamingMessageId);
    if (!message || (!message.text.trim() && !message.reasoning?.trim())) {
      return;
    }
    message.interrupted = true;
    void this.persistNow();
  }

  private persist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void this.persistNow();
    }, 300);
  }

  async persistNow(): Promise<void> {
    try {
      await this.store.save(this.snapshotSession());
    } catch {
      // storage failure is non-fatal
    }
  }
}
