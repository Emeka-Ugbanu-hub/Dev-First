import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync, promises as fs } from 'fs';
import { DiffManager } from '../diff/DiffManager';
import { AgentService } from '../agent/AgentService';
import type { FinishCheckSummary } from '../agent/AgentService';
import { ToolBox, ToolExecutionContext } from '../agent/ToolBox';
import { PlannerService } from '../planner/PlannerService';
import { ChatMessage, ChatOptions, LLMProvider, StreamStopReason, ToolCall, ToolDef, UsageTotals } from '../llm/types';
import {
  ChangedFile,
  ConnectionState,
  ContextProfileInfo,
  HostMessage,
  MessageAttachment,
  ModelMetadata,
  PastedContent,
  PendingDecisionRecord,
  Phase,
  Plan,
  PlannerStats,
  PlanningMode,
  PlanningState,
  ProviderConnection,
  QueuedPromptRecord,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  RunChangedFile,
  RunOperation,
  RunRecord,
  RunReviewFile,
  RunStatus,
  SelectionContext,
  DurableTaskState,
  LastAnswerState,
  ContinuationKind,
  ContinuationState,
  SessionMemoryCard,
  TaskRouteEvent,
  TaskStateStatus,
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
import { adaptiveKind, resetOllamaCapabilityCache } from '../llm/adaptive';
import { SessionStore, SessionContextEntry, StoredSession } from './SessionStore';
import { workspaceStoragePath } from '../util/workspaceStorage';
import { classifyIncomingMessage, classifyMessageRoute } from './messageRouting';
import {
  ContextMetadataUpdate,
  buildContextEntry,
  decisionContextMetadata,
  diagnosticsContextMetadata,
  mergeContextMetadata,
  mergeMetadataUpdates,
  mutationContextMetadata,
  planContextMetadata,
  rebuildContextIndex,
  toolContextMetadata,
} from './contextIndex';
import { RunJournalStore } from './RunJournalStore';
import { EventLedger } from './EventLedger';
import {
  FILE_EDIT_TOOLS,
  absoluteWorkspacePath,
  appendStepHash,
  buildRunOperation,
  classifyOperationRetry,
  filterAlivePids,
  mutationTargets,
  operationAfterHash,
  parseOperationExpectations,
  questionAnswerId,
  serializeOperationExpectations,
  sha1File,
  upsertRunChangedFile,
  validateRecoveredAnswers,
  validateRecoveredDecision,
} from './runRecovery';
import { PromptFamily, promptFamilyFor } from '../planner/prompts';
import { ReasoningOptions, ReasoningRouteContext } from '../llm/types';
import { createChildAbortController, StreamLoopGuard, streamLoopRecoveryPrompt } from '../llm/streamLoopGuard';
import { routeReasoning } from '../llm/reasoningRouter';
import {
  ADAPTIVE_RECENT_FLOOR,
  CompressionBlock,
  MIN_COMPRESS_MESSAGES,
  buildCompactedMessages,
  buildDeterministicCheckpoint,
  checkCompaction,
  chooseRecentStart,
  estimateTokens,
  projectCompressedMessages,
  summarizeMessages,
} from '../agent/compaction';
import { ContextProfile, ContextProfileTier, contextProfileFor, preserveBudgetTokens, reserveRatioTotal } from '../agent/modelProfile';
import { usageTotal } from '../llm/usage';
import { DevFirstConfig, deleteApiKey, getApiKeyForPreset, getConfig, saveApiKey, workspaceRoot } from '../config';
import { createProvider } from '../llm';
import { activeProvider, roleProvider } from '../llm/activeProvider';
import type { ActiveProvider, ModelRole } from '../llm/activeProvider';
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
import { stripInternalContext } from './internalContext';
import { extractFailureConcept } from './failureConcept';
import { findNewlyStartedTodos, mergeTodoCheckpoints } from '../util/todos';
import { SETTING_KEYS } from '../shared/settingsSchema';
import { MemoryStore } from '../memory/MemoryStore';
import { BackgroundProcesses } from '../agent/BackgroundProcesses';
import { OriginalContentProvider } from '../diff/OriginalContentProvider';
import { listWorkspaceFiles } from '../util/fsWalk';
import { ActivityMeta, activityMeta, compactExecutorToolView, describeToolCall, executionTools, loadToolsTool, plannerTools, readOnlyTools, subagentTools, toolIcon } from '../agent/tools';
import { attachToolPreflights } from '../agent/compoundPreflight';
import { PARALLEL_SAFE } from '../agent/parallelTools';
import { clearRepoMapCache } from '../agent/repoMap';
import type { ToolPreflight } from '../agent/compoundPreflight';
import { matchesRiskPath, planCheckRequirementFromPlan } from '../agent/verificationPolicy';
import { checkFinish } from '../agent/finishGate';
import type { FinishGateResult } from '../agent/finishGate';
import { reliabilityStateForPlan, reliabilityVerification } from '../agent/reliabilityState';
import { ApprovalMemory, ExternalDirectoryConsent } from '../agent/approvals';
import { runSubagent } from '../agent/subagent';
import { SemanticIndex } from '../indexing/SemanticIndex';
import { EmbedWorkerClient } from '../indexing/EmbedWorkerClient';
import { CodebaseIndex } from '../indexing/CodebaseIndex';
import { projectBootstrap } from '../indexing/projectBootstrap';
import { McpManager } from '../mcp/McpManager';
import { BrowserSession } from '../browser/BrowserSession';
import { CheckpointManager } from '../checkpoints/CheckpointManager';
import { FileSnapshotEntry, FileSnapshotStore, SnapshotCaptureResult } from '../checkpoints/FileSnapshotStore';
import { sha1Of, writeFileAtomic } from '../util/atomicWrite';
import { architectureFilesHash } from '../architecture/mapStore';
import { selectPlannerConversation, composePlannerRequest, relevanceBudget } from '../planner/relevance';
import type { PinnedPlannerContext } from '../planner/relevance';
import { buildTaskEvidencePack } from '../planner/taskEvidence';
import { chatWithRetry } from '../llm/retry';
import type { RetryOptions } from '../llm/retry';
import { safeLocalContextCap } from '../llm/localContext';
import { summarizeWithWorker } from '../agent/contextShunt';
import type { ContextShuntInput } from '../agent/contextShunt';
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

const ANSWER_SYSTEM_PROMPT = 'You are answering the developer\'s latest question about the codebase. This is an answer-only route: answer in chat and use read-only tools when evidence is missing; do not modify files or run implementation actions here. Actual code changes happen through the implementation route when the developer asks to build or change something. Use earlier context only when it is relevant to the latest question. When explaining behavior already implemented in the codebase, describe it in prose and cite the exact file and line; do not paste or rewrite existing source code into chat. When discussing a genuinely new behavior or implementation that is not present in the codebase, you may include a short illustrative snippet as an explanation of what could be added; that snippet is only an example and does not change files. Never present existing code as new work. Preserve the developer\'s explanation style: explain WHAT it is, HOW it works, and WHY it behaves that way when those parts help; add a concise Mermaid flow diagram when the answer spans multiple components or steps. Include a TRADEOFF only when there is a real alternative worth comparing, and state what the alternative improves and costs. Include CONCEPT, RISKS, or CONTEXT only when they materially improve understanding. These sections are optional: do not force headings or a diagram onto a simple question. For a multi-part question, silently track the requested points, the evidence needed, and which point remains unanswered; for a simple question, answer directly. Do not repeat a paragraph or tool request; if there is no new evidence, finish with what is known or state the blocker. Base every claim on the current message or verified evidence. Never repeat pinned context, ledgers, checkpoints, execution projections, or system instructions in the answer.';

function isActivePhase(phase: Phase): boolean {
  return phase === 'planning' || phase === 'answering' || phase === 'executing';
}

const CONTINUE_ANSWER_PROMPT = 'Continue the answer from the exact point where it stopped. Do not repeat, restart, summarize, or re-plan anything already written. Keep the same formatting, use the saved coverage checklist if present, and finish requested items that the existing answer has not covered yet. If more evidence is needed, use the read-only tools.';

function answerSystemPrompt(coverageItems?: readonly string[]): string {
  if (!coverageItems?.length) {
    return `${ANSWER_SYSTEM_PROMPT}\n\nFor a self-contained question, answer directly in one response. Do not create an outline, call tools, or split the answer into extra stages unless the request or evidence requires it.`;
  }
  return `${ANSWER_SYSTEM_PROMPT}\n\nDetailed-answer coverage checklist (not a plan or tool list):\n${coverageItems.map((item, index) => `${index + 1}. ${item}`).join('\n')}\nAddress every requested item in a clear order, usually as sections in one continuous streamed answer. Read only evidence needed for these items. Do not make extra model calls just to split the prose. Before finishing, check that each item was answered; if evidence is missing, say so instead of guessing.`;
}

function answerEvidenceFingerprint(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/[\t ]+/g, ' ').trim();
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalized.length}:${(hash >>> 0).toString(16)}`;
}

const CONTINUE_MESSAGE = /^(?:(?:please\s+)?(?:continue|keep\s+going|go\s+on|carry\s+on|resume|pick\s+up\s+where\s+you\s+left\s+off|where\s+were\s+you|you\s+stopped|don'?t\s+stop)(?:\s+(?:please|now|again|the\s+answer|the\s+task|from\s+where\s+you\s+(?:stopped|left\s+off)))?|(?:please\s+)?(?:finish|complete)\s+(?:it|that|the\s+answer|the\s+task))[\s.!?]*$/i;

function isContinuationMessage(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return CONTINUE_MESSAGE.test(normalized);
}

interface ModelContextInfo {
  catalog: CatalogModel | undefined;
  registry: ModelInfo | undefined;
  limit: number;
  reserved: number;
  profile: ContextProfile;
  supportsReasoning: boolean;
  local: boolean;
}

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

function normalizeQuestionOptions(value: unknown): QuestionOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const options = value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => typeof item.label === 'string' && item.label)
    .map((item) => ({
      label: item.label as string,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    }));
  return options.length > 0 ? options : undefined;
}

function normalizeQuestionItems(value: unknown): QuestionItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const questions: QuestionItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    if (!question) {
      continue;
    }
    questions.push({
      ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),
      question,
      ...(typeof raw.header === 'string' && raw.header ? { header: raw.header } : {}),
      options: normalizeQuestionOptions(raw.options) ?? [],
      ...(raw.multiple === true ? { multiple: true } : {}),
      ...(raw.custom === false ? { custom: false } : {}),
    });
  }
  return questions.length > 0 ? questions : undefined;
}

function normalizeStoredPending(value: unknown): PendingDecisionRecord | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== 'question' ||
    typeof raw.id !== 'string' ||
    !raw.id ||
    typeof raw.prompt !== 'string' ||
    !raw.prompt.trim()
  ) {
    return undefined;
  }
  const options = normalizeQuestionOptions(raw.options);
  const questions = normalizeQuestionItems(raw.questions);
  return {
    id: raw.id,
    kind: 'question',
    prompt: raw.prompt,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    ...(typeof raw.requestId === 'string' && raw.requestId ? { requestId: raw.requestId } : {}),
    ...(typeof raw.allowCustom === 'boolean' ? { allowCustom: raw.allowCustom } : {}),
    ...(raw.multiple === true ? { multiple: true } : {}),
    ...(options ? { options } : {}),
    ...(questions ? { questions } : {}),
    ...(typeof raw.step === 'string' && raw.step ? { step: raw.step } : {}),
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
  private contextIndex: SessionContextEntry[] = [];
  private archivedConversation: ChatMessage[] = [];
  private archivedContextIndex: SessionContextEntry[] = [];
  private pendingContextMetadata: ContextMetadataUpdate | undefined;
  private diagnosticsSummary: string | undefined;
  private plan: Plan | null = null;
  private planningState: PlanningState = { status: 'idle', planVersion: 0, updatedAt: Date.now() };
  private todos: TodoItem[] = [];
  private planVersion = 0;
  private lastRequest = '';
  private lastPlannerStats: PlannerStats | undefined;
  private activePlannerToolbox: ToolBox | undefined;
  private activeExecutorToolbox: ToolBox | undefined;
  private completedRunBoundary = false;
  private lastUserMessageId: string | undefined;
  private abortController: AbortController | null = null;
  private reasoningOverride: string | undefined;
  private activeReasoningModel: { presetId: string; model: string } | undefined;
  private reasoningChanges = 0;
  private streamingMessageId: string | null = null;
  private activeStatusId: string | undefined;
  private currentApproval: TerminalApprovalRequest | null = null;
  private persistTimer: NodeJS.Timeout | undefined;
  private readonly pendingApprovals = new Map<string, (decision: TerminalApprovalDecision) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly mcp = new McpManager();
  private readonly checkpoints: CheckpointManager;
  private readonly fileSnapshots: FileSnapshotStore;
  private semanticIndex: SemanticIndex | undefined;
  private embedWorker: EmbedWorkerClient | undefined;
  private readonly codebaseIndex: CodebaseIndex;
  private browser: BrowserSession | undefined;
  private selection: SelectionContext | null = null;
  private connectionError: string | undefined;
  private connectionNoticeId: string | undefined;
  private keyPresent = false;
  private contextTokens = 0;
  private lastExactUsage: UsageTotals | undefined;
  private compressionBlocks: CompressionBlock[] = [];
  private plannerConversationCache: { fingerprint: string; messages: ChatMessage[] } | null = null;
  private backgroundCompaction: { fingerprint: string; summary: string } | null = null;
  private backgroundCompactionInFlight = false;
  private backgroundCompactionTimer: NodeJS.Timeout | undefined;
  private readonly contextShuntCache = new Map<string, string>();
  private readonly sessionReady: Promise<void>;
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
  private readonly recoveredAnswers = new Map<
    string,
    { prompt: string; questions?: Array<{ id: string; question: string }>; values: Map<string, string> }
  >();
  private sessionPending: PendingDecisionRecord | undefined;
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
    newTask?: boolean;
    createdAt: number;
  }> = [];
  private readonly runJournal: RunJournalStore;
  private readonly eventLedger: EventLedger;
  private currentRun: RunRecord | undefined;
  private taskState: DurableTaskState = {
    taskId: randomId('task'),
    state: 'idle',
    completedSteps: [],
    nextSteps: [],
    blockers: [],
    lastHeartbeatAt: Date.now(),
  };
  private routeLog: TaskRouteEvent[] = [];
  private lastAnswer: LastAnswerState | undefined;
  private continuation: ContinuationState | undefined;
  private sessionMemoryCard: SessionMemoryCard = { decisions: [], touchedFiles: [], blockers: [], updatedAt: Date.now() };
  private recoveryRun: RunRecord | undefined;
  private recoveryDrift = false;
  private stepHashChain: Promise<void> = Promise.resolve();
  private readonly toolPreflights = new Map<string, ToolPreflight>();
  private runningQueued: {
    id: string;
    text: string;
    selection?: SelectionContext;
    quote?: string;
    images?: string[];
    pastes?: PastedContent[];
    createdAt: number;
  } | undefined;
  private disposed = false;
  private knowledgeRefresh: Promise<void> | null = null;
  private rulesBaseCache: { projectRules: string | undefined; memory: string } | null = null;
  private toolRegistryCache: { planner: ToolDef[]; executor: ToolDef[]; lazyExecutor: ToolDef[] } | null = null;
  private toolRegistryCacheKey: string | null = null;
  private plannerToolCache: ToolDef[] | null = null;
  private plannerToolCacheTier: string | null = null;
  private questionToolCache: ToolDef[] | null = null;
  private scannerToolbox: { key: string; toolbox: ToolBox } | undefined;
  private preparedProvider: { key: string; provider: LLMProvider } | undefined;
  private enhanceAbort: AbortController | undefined;
  private enhanceRequestId = 0;
  private lastWarmupAt = 0;
  private warmupInFlight = false;
  private warmupPromise: Promise<void> | null = null;
  private taskWatchdog?: ReturnType<typeof setInterval>;
  private taskWatchdogLastActivity = 0;
  private taskWatchdogTriggered = false;
  private answerWatchdog?: ReturnType<typeof setInterval>;
  private answerWatchdogLastActivity = 0;

  private beginTaskWatchdog(): void {
    this.endTaskWatchdog();
    this.taskWatchdogLastActivity = Date.now();
    this.taskWatchdogTriggered = false;
    // A provider can legitimately pause while loading a model or doing a
    // large tool operation. Only recover after sustained inactivity.
    const inactivityWindowMs = 120_000;
    this.taskWatchdog = setInterval(() => {
      if ((this.phase !== 'planning' && this.phase !== 'executing') || !this.abortController) {
        return;
      }
      if (Date.now() - this.taskWatchdogLastActivity < inactivityWindowMs) {
        return;
      }
      this.taskWatchdogTriggered = true;
      this.taskState = { ...this.taskState, state: 'stalled', lastHeartbeatAt: Date.now(), blockers: ['No provider or tool activity within the recovery window.'] };
      this.setContinuation('task', this.taskState.taskId, 'paused');
      void this.persistNow();
      this.addNotice('Task stopped after prolonged inactivity. Completed work was preserved; you can ask a new question or continue.');
      this.abortController.abort();
      this.endTaskWatchdog();
    }, 5_000);
  }

  private touchTaskWatchdog(): void {
    this.taskState = { ...this.taskState, lastHeartbeatAt: Date.now(), blockers: [] };
    if (this.taskWatchdog) {
      this.taskWatchdogLastActivity = Date.now();
    }
  }

  private endTaskWatchdog(): void {
    if (this.taskWatchdog) {
      clearInterval(this.taskWatchdog);
      this.taskWatchdog = undefined;
    }
  }

  private beginAnswerWatchdog(controller: AbortController): void {
    this.endAnswerWatchdog();
    this.answerWatchdogLastActivity = Date.now();
    const inactivityWindowMs = 120_000;
    this.answerWatchdog = setInterval(() => {
      if (Date.now() - this.answerWatchdogLastActivity < inactivityWindowMs) {
        return;
      }
      this.setStage('ANSWER — timed out; stopping…');
      controller.abort();
      this.addNotice('Answer stopped after prolonged inactivity. Ask “continue” to resume it.');
      this.endAnswerWatchdog();
    }, 5_000);
  }

  private touchAnswerWatchdog(): void {
    if (this.answerWatchdog) {
      this.answerWatchdogLastActivity = Date.now();
    }
  }

  private endAnswerWatchdog(): void {
    if (this.answerWatchdog) {
      clearInterval(this.answerWatchdog);
      this.answerWatchdog = undefined;
    }
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly post: (message: HostMessage) => void,
    private readonly diffManager: DiffManager,
  ) {
    const projectRoot = workspaceRoot() ?? process.cwd();
    const projectStorage = (...segments: string[]): string =>
      workspaceStoragePath(context.globalStorageUri.fsPath, projectRoot, ...segments);
    this.checkpoints = new CheckpointManager(
      projectRoot,
      projectStorage('checkpoints'),
    );
    this.fileSnapshots = new FileSnapshotStore(projectStorage('file-snapshots'));
    this.codebaseIndex = new CodebaseIndex({
      root: projectRoot,
      storageFile: projectStorage('codebase-index.json'),
      maxFiles: getConfig().codebaseIndexMaxFiles,
      onProgress: (message) => {
        // Background indexing must never create an empty assistant row. Only
        // surface progress when a request is already displaying a stage.
        if (this.streamingMessageId && this.phase !== 'idle') this.setStage(message);
      },
    });
    this.registry = new ModelRegistry(path.join(context.globalStorageUri.fsPath, 'models-cache.json'));
    this.connections = new ConnectionsStore(context.globalState);
    this.memory = new MemoryStore(projectRoot, context.globalStorageUri.fsPath);
    this.background = new BackgroundProcesses(projectRoot);
    this.background.onChange(() => this.refreshRunProcesses());
    this.store = new SessionStore(projectStorage('sessions'));
    this.runJournal = new RunJournalStore(projectStorage('runs'));
    this.eventLedger = new EventLedger(projectStorage('event-ledger'), this.sessionId);
    // Gate inbound messages on session restore so a late restore can never
    // overwrite a message the developer already sent after activation.
    this.sessionReady = this.initializeSession().catch(() => undefined);
    this.codebaseIndex.startBackgroundRefresh();
    void this.cleanupPasteFiles();
    this.disposables.push(diffManager.onDidChangePendingChanges(() => this.pushChanges()));
    if (typeof diffManager.onDidChangeHistory === 'function') {
      this.disposables.push(diffManager.onDidChangeHistory(() => this.pushState()));
    }
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.pushSelection()),
      vscode.window.onDidChangeActiveTextEditor(() => this.pushSelection()),
    );
    if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
      this.disposables.push(
        vscode.workspace.onDidChangeConfiguration(() => this.invalidateDerivedCaches()),
      );
    }
    if (typeof vscode.workspace.onDidChangeTextDocument === 'function') {
      this.disposables.push(
        vscode.workspace.onDidChangeTextDocument(() => this.invalidateActiveCaches()),
      );
    }
    if (typeof vscode.workspace.onDidSaveTextDocument === 'function') {
      this.disposables.push(
        vscode.workspace.onDidSaveTextDocument(() => this.invalidateActiveCaches()),
      );
    }
    if (typeof vscode.workspace.createFileSystemWatcher === 'function') {
      try {
        const codebaseWatcher = vscode.workspace.createFileSystemWatcher('**/*');
        const invalidateCodebase = (uri: vscode.Uri) => {
          this.codebaseIndex.invalidate(uri.fsPath);
          this.semanticIndex?.invalidate(uri.fsPath);
          this.invalidateActiveCaches();
        };
        codebaseWatcher.onDidChange(invalidateCodebase);
        codebaseWatcher.onDidCreate(invalidateCodebase);
        codebaseWatcher.onDidDelete(invalidateCodebase);
        this.disposables.push(codebaseWatcher);
        for (const pattern of ['**/AGENTS.md', '**/.dev-first/**']) {
          const watcher = vscode.workspace.createFileSystemWatcher(pattern);
          const invalidate = () => this.invalidateDerivedCaches();
          watcher.onDidChange(invalidate);
          watcher.onDidCreate(invalidate);
          watcher.onDidDelete(invalidate);
          this.disposables.push(watcher);
        }
      } catch {}
    }
    void this.refreshConnection();
  }

  getState(): UiState {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const metadata = this.selectedModelMetadata(preset.id, config.model, preset.provider);
    const reasoningLevels = metadata.reasoningLevels ?? [];
    const reasoningEffort = this.selectedReasoningEffort(preset.id, config.model, reasoningLevels, metadata.reasoningDefault);
    const reasoningSliderLevels = reasoningLevels.length > 0 ? ['auto', ...reasoningLevels] : [];
    const reasoningCurrent = config.plannerThinking === 'auto' ? 'auto' : config.plannerThinking === 'off' ? 'off' : reasoningEffort;
    const recovery = this.buildRecoveryState();
    return {
      phase: this.phase,
      messages: this.uiMessages,
      plan: this.plan,
      planningState: this.planningState,
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
        profile: this.contextProfileInfo(),
      },
      currentRunId: this.diffManager.getCurrentRunId(),
      viewableRuns: this.diffManager.viewableRunIds?.() ?? [],
      autoApproveTerminal: config.autoApproveTerminal,
      supportsVision: metadata.supportsVision !== false,
      visionSupportKnown: metadata.supportsVision !== undefined,
      modelDisplayName: metadata.name ?? config.model,
      reasoningEffort,
      reasoningLevels: reasoningSliderLevels,
      reasoningCurrent,
      reasoningDefault: metadata.reasoningDefault ?? '',
      resources: config.resources,
      mcpDisplay: config.mcpDisplay,
      soundOnFinish: config.soundOnFinish,
      sessionTitle: this.sessionTitle,
      provider: config.provider,
      model: config.model,
      pasteFileLines: config.pasteFileLines,
      queued: this.queuedRecords(),
      taskState: this.taskState,
      ...(recovery ? { recovery } : {}),
    };
  }

  private buildRecoveryState(): UiState['recovery'] | undefined {
    if (!this.recoveryRun && !this.sessionPending) {
      return undefined;
    }
    return {
      ...(this.recoveryRun ? { run: this.recoveryRun } : {}),
      ...(this.recoveryRun && this.recoveryDrift ? { runDrift: true } : {}),
      ...(this.recoveryRun ? this.recoveryProcessesAlive() : {}),
      ...(this.sessionPending ? { pending: this.sessionPending } : {}),
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
        await this.eventLedger.hydrate();
        await this.restoreSessionContext();
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
      this.uiMessages = legacy.messages.map((message) => ({ ...message, streaming: false, stage: undefined }));
      this.conversation = legacy.conversation ?? [];
      this.plan = this.restorablePlan(legacy.plan ?? null);
      this.todos = legacy.todos ?? [];
      this.planVersion = legacy.planVersion ?? 0;
      this.lastRequest = legacy.lastRequest ?? '';
      const firstUser = this.uiMessages.find((message) => message.role === 'user');
      this.sessionTitle = firstUser ? firstUser.text.slice(0, 50) : 'Imported session';
      this.contextIndex = rebuildContextIndex(this.conversation);
      await this.context.workspaceState.update(LEGACY_SESSION_KEY, undefined);
    }
    await this.persistNow();
  }

  private applySession(stored: StoredSession): void {
    this.sessionId = stored.id;
    this.eventLedger.setSession(this.sessionId);
    this.sessionTitle = stored.title;
    this.sessionCreatedAt = stored.createdAt;
    this.uiMessages = (Array.isArray(stored.messages) ? stored.messages : [])
      .map((message, index) => normalizeStoredMessage(message, index))
      .filter((message): message is UiMessage => message !== undefined);
    this.conversation = stored.conversation ?? [];
    this.contextIndex = [];
    this.archivedConversation = [];
    this.archivedContextIndex = [];
    this.pendingContextMetadata = undefined;
    this.diagnosticsSummary = undefined;
    const plan = stored.plan ?? null;
    if (plan && !plan.flow) {
      const legacyFlow = (plan as { howDiagram?: string }).howDiagram;
      if (legacyFlow) {
        plan.flow = legacyFlow;
      }
    }
    this.plan = this.restorablePlan(plan);
    this.planningState = stored.planningState ?? {
      status: this.plan ? 'ready' : 'idle',
      ...(this.plan?.planningMode ? { mode: this.plan.planningMode } : {}),
      planVersion: this.planVersion,
      updatedAt: Date.now(),
    };
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
    this.scannerToolbox = undefined;
    this.lastAnswer = stored.lastAnswer;
    this.continuation = stored.continuation;
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
        newTask: record.newTask,
        selection: record.selection,
        quote: record.quote,
        images: record.images,
        pastes: record.pastes,
        createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
      }));
    this.runningQueued = undefined;
    this.taskState = stored.taskState ?? {
      taskId: randomId('task'),
      state: this.plan ? 'awaiting_approval' : 'idle',
      completedSteps: [],
      nextSteps: this.plan?.steps?.map((_, index) => index) ?? [],
      blockers: [],
      lastHeartbeatAt: Date.now(),
    };
    this.sessionMemoryCard = stored.memoryCard ?? this.buildSessionMemoryCard();
    this.routeLog = Array.isArray(stored.routeLog) ? stored.routeLog.slice(-100) : [];
    this.currentRun = undefined;
    this.sessionPending = normalizeStoredPending(stored.pending);
    this.recoveredAnswers.clear();
    void this.context.workspaceState.update(ACTIVE_SESSION_KEY, this.sessionId);
  }

  private async restoreSessionContext(): Promise<void> {
    try {
      const stored = await this.store.loadContext(this.sessionId);
      this.contextIndex = stored.active;
      this.archivedContextIndex = stored.archived;
      this.archivedConversation = await this.store.loadArchive(this.sessionId);
    } catch {
      this.contextIndex = rebuildContextIndex(this.conversation);
      this.archivedContextIndex = [];
      this.archivedConversation = [];
    }
  }

  private restorablePlan(plan: Plan | null): Plan | null {
    if (!plan) {
      return null;
    }
    // Drafts still need approval. Approved plans are kept so an interrupted
    // run can be resumed after a restart instead of being silently dropped.
    if (plan.status === 'draft' || plan.status === 'approved' || this.phase === 'executing') {
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
      planningState: this.planningState,
      todos: this.todos,
      planVersion: this.planVersion,
      lastRequest: this.lastRequest,
      contextTokens: this.contextTokens,
      queued: this.queuedRecords(),
      taskState: this.taskState,
      lastAnswer: this.lastAnswer,
      ...(this.continuation ? { continuation: this.continuation } : {}),
      memoryCard: this.buildSessionMemoryCard(),
      routeLog: this.routeLog.slice(-100),
      ...(this.sessionPending ? { pending: this.sessionPending } : {}),
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
    if (isActivePhase(this.phase)) {
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
    await this.restoreSessionContext();
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
          await this.restoreSessionContext();
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
    this.eventLedger.setSession(this.sessionId);
    this.sessionTitle = 'New session';
    this.sessionCreatedAt = Date.now();
    this.uiMessages = [];
    this.conversation = [];
    this.contextIndex = [];
    this.archivedConversation = [];
    this.archivedContextIndex = [];
    this.pendingContextMetadata = undefined;
    this.diagnosticsSummary = undefined;
    this.plan = null;
    this.planningState = { status: 'idle', planVersion: 0, updatedAt: Date.now() };
    this.todos = [];
    this.planVersion = 0;
    this.lastAnswer = undefined;
    this.continuation = undefined;
    this.sessionMemoryCard = { decisions: [], touchedFiles: [], blockers: [], updatedAt: Date.now() };
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
    this.sessionPending = undefined;
    this.recoveredAnswers.clear();
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
    void this.primeActiveProvider();
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
    this.preparedProvider = undefined;
    await this.primeActiveProvider();
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
    this.preparedProvider = undefined;
    await this.primeActiveProvider();
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
    this.preparedProvider = undefined;
    await this.primeActiveProvider();
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
    this.preparedProvider = undefined;
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
    this.preparedProvider = undefined;
    await this.primeActiveProvider();
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
    await this.sessionReady;
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
      case 'warmup':
        void this.warmLocalModel();
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
      case 'answerRecoveredQuestion':
        await this.answerRecoveredQuestion(message.runId, message.answers);
        break;
      case 'skipRecoveredQuestion':
        await this.skipRecoveredQuestion(message.runId);
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
      case 'revertRunFileForce':
        await this.revertRunFileForce(message.path, message.runId);
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
    this.endAnswerWatchdog();
    this.abortController?.abort();
    if (this.currentRun && (this.currentRun.status === 'executing' || this.currentRun.status === 'waiting')) {
      this.currentRun.pending = undefined;
      this.markRun('stopped');
    }
  }

  private requestUserAnswer(request: QuestionRequest): Promise<string> {
    const recovered = this.consumeRecoveredAnswer(request);
    if (recovered !== undefined) {
      return Promise.resolve(recovered);
    }
    this.currentQuestion = request;
    const record = this.pendingQuestionRecord(request);
    if (this.currentRun) {
      this.setRunPending(record);
    } else {
      this.sessionPending = record;
      this.recordContextMetadata(decisionContextMetadata(record));
      void this.persistNow();
    }
    this.needsInputListener?.('the agent asked you a question');
    this.post({ type: 'question', request });
    return new Promise<string>((resolve) => {
      this.pendingQuestions.set(request.id, resolve);
    });
  }

  private pendingQuestionRecord(request: QuestionRequest): PendingDecisionRecord {
    const step = this.activeStepLabel();
    const questions = request.questions?.map((item, index) => ({
      id: item.id ?? `${request.id}:${index}`,
      question: item.question,
      ...(item.header ? { header: item.header } : {}),
      options: item.options,
      ...(item.multiple ? { multiple: true } : {}),
      ...(item.custom === false ? { custom: false } : {}),
    }));
    return {
      id: request.id,
      kind: 'question',
      prompt: request.question,
      requestId: request.id,
      options: request.options,
      allowCustom: questions ? questions.some((item) => item.custom !== false) : true,
      ...(request.multiple ? { multiple: true } : {}),
      ...(questions && questions.length > 0 ? { questions } : {}),
      createdAt: Date.now(),
      ...(step ? { step } : {}),
    };
  }

  private consumeRecoveredAnswer(request: QuestionRequest): string | undefined {
    const keys = [this.currentRun?.id, this.recoveryRun?.id, 'session'];
    for (const key of keys) {
      if (!key) {
        continue;
      }
      const entry = this.recoveredAnswers.get(key);
      if (!entry) {
        continue;
      }
      const answer = this.matchRecoveredAnswer(entry, request);
      if (answer === undefined) {
        continue;
      }
      this.recoveredAnswers.delete(key);
      if (key === 'session') {
        this.sessionPending = undefined;
        void this.persistNow();
      } else {
        this.clearRecoveredRunPending(key);
      }
      return answer;
    }
    return undefined;
  }

  private matchRecoveredAnswer(
    entry: { prompt: string; questions?: Array<{ id: string; question: string }>; values: Map<string, string> },
    request: QuestionRequest,
  ): string | undefined {
    const incoming = request.questions ?? [];
    if (incoming.length > 0) {
      if (!entry.questions || entry.questions.length !== incoming.length) {
        return undefined;
      }
      const matches = incoming.every(
        (item, index) => item.question.trim() === entry.questions![index].question.trim(),
      );
      if (!matches) {
        return undefined;
      }
      const lines = incoming.map(
        (item, index) => `${item.question}: ${entry.values.get(entry.questions![index].id) ?? ''}`,
      );
      return `Developer answered:\n${lines.join('\n')}`;
    }
    if (entry.questions?.length || request.question.trim() !== entry.prompt.trim()) {
      return undefined;
    }
    const value = [...entry.values.values()][0] ?? '';
    return value ? `Developer answered: ${value}` : undefined;
  }

  private clearRecoveredRunPending(runId: string): void {
    const run =
      this.currentRun?.id === runId ? this.currentRun : this.recoveryRun?.id === runId ? this.recoveryRun : undefined;
    if (!run) {
      void this.runJournal.load(runId).then((stored) => {
        if (!stored?.pending) {
          return;
        }
        stored.pending = undefined;
        if (stored.status === 'waiting') {
          stored.status = 'executing';
        }
        stored.updatedAt = Date.now();
        return this.saveRun(stored);
      });
      return;
    }
    run.pending = undefined;
    if (run.status === 'waiting') {
      run.status = 'executing';
    }
    run.updatedAt = Date.now();
    void this.saveRun(run);
    this.pushState();
  }

  private resolveQuestion(id: string, answer: string): void {
    const resolve = this.pendingQuestions.get(id);
    if (!resolve) {
      return;
    }
    this.pendingQuestions.delete(id);
    this.currentQuestion = null;
    this.clearRunPending();
    this.clearSessionPending();
    this.post({ type: 'question', request: null });
    resolve(answer);
  }

  private clearSessionPending(): void {
    if (!this.sessionPending) {
      return;
    }
    this.sessionPending = undefined;
    void this.persistNow();
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
    this.clearSessionPending();
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
    const index = this.queuedMessages.findIndex((message) => !message.newTask);
    if (index < 0) {
      return undefined;
    }
    const [next] = this.queuedMessages.splice(index, 1);
    if (!next) {
      return undefined;
    }
    if (!next) {
      return undefined;
    }
    this.runningQueued = {
      id: next.id,
      text: next.text,
      selection: next.selection,
      quote: next.quote,
      images: next.images,
      pastes: next.pastes,
      createdAt: next.createdAt,
    };
    const uiMessage = this.uiMessages.find((message) => message.id === next.id);
    if (uiMessage) {
      uiMessage.queued = false;
    }
    this.post({ type: 'unqueueMessage', id: next.id });
    return next.text;
  }

  private async compactNow(): Promise<void> {
    if (isActivePhase(this.phase)) {
      this.addNotice('Cannot compact while a task is running.');
      return;
    }
    const provider = await this.buildProvider();
    if (!provider) {
      return;
    }
    const messages = [{ role: 'system' as const, content: 'compact' }, ...this.conversation];
    const profile = this.buildContextProfile();
    const preserve = preserveBudgetTokens(profile, this.effectiveContextLimit(), this.profileSupportsReasoning());
    const recentStart = chooseRecentStart(messages, preserve, ADAPTIVE_RECENT_FLOOR);
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
        { id: randomId('msg'), role: 'assistant', content: `[Summary of earlier conversation]\n\n${summary}` },
        ...recent,
      ];
      this.contextIndex = rebuildContextIndex(this.conversation);
      this.pendingContextMetadata = undefined;
      this.compressionBlocks = [];
      this.lastExactUsage = undefined;
      this.addNotice('Conversation compacted.');
      this.reportUsage(estimateTokens([{ role: 'system', content: '' }, ...this.conversation]));
    } catch (error) {
      this.addError(`Compaction failed: ${errorMessage(error)}`);
    }
  }

  private async compressContext(
    focus?: string,
    context: ModelContextInfo = this.mainModelContext(),
    activeProvider?: LLMProvider,
    activeModel?: string,
  ): Promise<string> {
    if (this.compressionsThisTurn >= 1) {
      return 'Error: compress_context can be called at most once per turn.';
    }
    this.compressionsThisTurn += 1;
    const active = this.compressionBlocks.filter((block) => block.active);
    const last = active.length > 0 ? active[active.length - 1] : undefined;
    const startIndex = last ? last.endIndex : 0;
    const preserve = preserveBudgetTokens(context.profile, context.limit, context.supportsReasoning);
    const recentStart = chooseRecentStart(this.conversation, preserve, ADAPTIVE_RECENT_FLOOR);
    const endIndex = Math.min(recentStart, this.conversation.length);
    const foldable = endIndex - startIndex;
    if (foldable < MIN_COMPRESS_MESSAGES) {
      return `Error: only ${foldable} earlier message${foldable === 1 ? '' : 's'} can be folded; at least ${MIN_COMPRESS_MESSAGES} are needed. Finish more of the earlier work first.`;
    }
    const provider = activeProvider ?? await this.buildProvider();
    if (!provider) {
      return 'Error: no provider is available for context compression.';
    }
    try {
      const summary = await summarizeMessages(
        provider,
        activeModel ?? getConfig().model,
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
    return selectPlannerConversation(
      projectCompressedMessages(this.conversation, this.compressionBlocks),
      relevanceBudget(this.buildContextProfile().tier),
      this.contextIndex,
      { archived: this.archivedConversation, archivedContextIndex: this.archivedContextIndex },
    );
  }

  private async codebaseEvidenceForRequest(request: string, limit = 4): Promise<string | undefined> {
    try {
      const fast = (await this.codebaseIndex.evidenceFast(request, limit)).trim();
      if (fast) return fast;
      if (await this.codebaseIndex.waitForReady(350)) {
        return (await this.codebaseIndex.evidenceFast(request, limit)).trim() || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async preparePlannerConversation(
    provider: LLMProvider,
    context: ModelContextInfo,
    model = getConfig().model,
    local = false,
  ): Promise<ChatMessage[]> {
    const pendingDecisionIds = this.sessionPending ? [this.sessionPending.id] : this.currentRun?.pending ? [this.currentRun.pending.id] : [];
    const root = workspaceRoot() ?? process.cwd();
    const taskEvidence = buildTaskEvidencePack(this.context.globalState, this.lastRequest ?? '', 3600, root);
    const [bootstrap, codebaseEvidence] = await Promise.all([
      projectBootstrap(root),
      this.codebaseEvidenceForRequest(
        this.lastRequest ?? '',
        context.profile.tier === 'compact' ? 4 : 6,
      ),
    ]);
    const evidence = [taskEvidence, codebaseEvidence]
      .filter((entry): entry is string => Boolean(entry))
      .join('\n\n') || undefined;
    const fingerprint = sha1Of(JSON.stringify({
      conversation: this.conversation,
      archivedConversation: this.archivedConversation,
      contextIndex: this.contextIndex,
      archivedContextIndex: this.archivedContextIndex,
      compressionBlocks: this.compressionBlocks,
      pendingDecisionIds,
      planVersion: this.planVersion,
      completedRunBoundary: this.completedRunBoundary,
      profile: context.profile.tier,
      contextLimit: context.limit,
      diagnosticsSummary: this.diagnosticsSummary,
      changedFiles: this.currentRun?.changedFiles,
      evidence,
      bootstrap,
    }));
    if (this.plannerConversationCache?.fingerprint === fingerprint) {
      this.completedRunBoundary = false;
      return this.plannerConversationCache.messages.map((message) => ({ ...message }));
    }
    const request = composePlannerRequest({
      conversation: projectCompressedMessages(this.conversation, this.compressionBlocks),
      contextIndex: this.contextIndex,
      archived: this.archivedConversation,
      archivedContextIndex: this.archivedContextIndex,
      pendingDecisionIds,
      budget: relevanceBudget(context.profile.tier),
      pinned: this.buildPinnedContext(),
      completedRunBoundary: this.completedRunBoundary,
      evidence,
      bootstrap,
    });
    this.completedRunBoundary = false;
    const messages = await this.maybeCompactPlanner(request.messages, provider, context, model, local);
    this.plannerConversationCache = { fingerprint, messages };
    return messages.map((message) => ({ ...message }));
  }

  private async maybeCompactPlanner(
    messages: ChatMessage[],
    provider: LLMProvider,
    context: ModelContextInfo,
    model = getConfig().model,
    local = false,
  ): Promise<ChatMessage[]> {
    if (!getConfig().autoCompact) {
      return messages;
    }
    const check = checkCompaction(messages, context.limit, {
      profile: context.profile,
      reasoning: context.supportsReasoning,
    });
    if (!check.needed || check.recentStart <= 2) {
      return messages;
    }
    const compactionFingerprint = sha1Of(JSON.stringify(messages.slice(2, check.recentStart)));
    if (this.backgroundCompaction?.fingerprint === compactionFingerprint) {
      const prepared = buildCompactedMessages(messages, this.backgroundCompaction.summary, check.recentStart);
      this.backgroundCompaction = null;
      return prepared;
    }
    // Trim-first: planning usually only needs the pinned head plus the recent
    // window, so drop the stale middle without paying for a summarize call.
    const trimmed = [...messages.slice(0, 2), ...messages.slice(check.recentStart)];
    const threshold = check.threshold ?? context.limit * 0.6;
    if (estimateTokens(trimmed) <= threshold) {
      return trimmed;
    }
    // On compact local models, a second summarizer request competes with the
    // planner on the same model and delays the first useful response. The
    // deterministic checkpoint keeps the important head and recent request
    // without another model round trip.
    if (local || context.profile.tier === 'compact') {
      return buildDeterministicCheckpoint(messages, check.recentStart);
    }
    try {
      const summary = await summarizeMessages(
        provider,
        model,
        messages.slice(2, check.recentStart),
        this.abortController?.signal ?? new AbortController().signal,
      );
      return summary
        ? buildCompactedMessages(messages, summary, check.recentStart)
        : buildDeterministicCheckpoint(messages, check.recentStart);
    } catch {
      return buildDeterministicCheckpoint(messages, check.recentStart);
    }
  }

  private buildPinnedContext(): PinnedPlannerContext {
    const latest = [...this.conversation].reverse().find((message) => message.role === 'user');
    const latestText = latest
      ? typeof latest.content === 'string'
        ? latest.content
        : JSON.stringify(latest.content)
      : this.lastRequest;
    const pending = this.sessionPending ?? this.currentRun?.pending;
    const changedFiles = (this.currentRun?.changedFiles ?? []).map((file) => file.path);
    const includeLedger = Boolean(this.currentRun || (this.plan && this.plan.status !== 'completed'));
    const ledger = includeLedger ? this.eventLedger.condensed(1800) : undefined;
    const card = this.currentMemoryCard();
    return {
      latestUserMessage: latestText,
      ...(this.plan
        ? {
            activePlan: {
              title: this.plan.title?.trim() || 'Plan',
              steps: this.plan.steps ?? [],
              version: this.plan.version,
              completedSteps: this.currentRun?.completedSteps ?? [],
              skippedSteps: this.plan.skippedSteps ?? [],
            },
          }
        : {}),
      ...(pending ? { pending } : {}),
      changedFiles,
      taskState: {
        state: this.taskState.state,
        completedSteps: this.taskState.completedSteps,
        nextSteps: this.taskState.nextSteps,
        blockers: this.taskState.blockers,
      },
      ...(this.memoryCardIsRelevant(latestText) ? { memoryCard: card } : {}),
      ...(ledger ? { ledger } : {}),
      ...(this.diagnosticsSummary ? { diagnosticsSummary: this.diagnosticsSummary } : {}),
    };
  }

  /** Keep direct answers focused: carry the durable card only when the new
   * question is connected to the active work. Unrelated questions get the
   * normal conversation/evidence projection without old task baggage. */
  private buildQuestionPinnedContext(question: string): PinnedPlannerContext | undefined {
    if (!this.memoryCardIsRelevant(question)) {
      return undefined;
    }
    return {
      latestUserMessage: question,
      changedFiles: [],
      memoryCard: this.currentMemoryCard(),
    };
  }

  /** Merge the persisted card with current state so a restored session keeps
   * files and answer context that cannot be reconstructed from live fields. */
  private currentMemoryCard(): SessionMemoryCard {
    const fresh = this.buildSessionMemoryCard();
    const stored = this.sessionMemoryCard;
    if (!stored) {
      return fresh;
    }
    // A completed task's files and answer tail are history, not memory for an
    // unrelated new request. Only fall back to them while work is unfinished.
    const canFallback = Boolean(this.continuation && this.continuation.status !== 'complete');
    return {
      goal: fresh.goal || stored.goal,
      decisions: fresh.decisions.length > 0 ? fresh.decisions : stored.decisions,
      touchedFiles: fresh.touchedFiles.length > 0
        ? fresh.touchedFiles
        : canFallback ? stored.touchedFiles : [],
      blockers: fresh.blockers.length > 0 ? fresh.blockers : stored.blockers,
      completedStep: fresh.completedStep ?? stored.completedStep,
      nextStep: fresh.nextStep ?? stored.nextStep,
      answerTail: fresh.answerTail ?? (canFallback ? stored.answerTail : undefined),
      updatedAt: Math.max(fresh.updatedAt, stored.updatedAt),
    };
  }

  private memoryCardIsRelevant(text?: string): boolean {
    if (isActivePhase(this.phase)) return true;
    if (this.currentRun && this.currentRun.status !== 'completed') return true;
    if (this.plan && this.plan.status !== 'completed') return true;
    if (['planning', 'awaiting_approval', 'executing', 'verifying', 'stalled'].includes(this.taskState.state)) {
      return true;
    }
    if (this.continuation && this.continuation.status !== 'complete') return true;
    if (!text) return false;
    const card = this.currentMemoryCard();
    const memoryText = [
      card.goal,
      ...card.decisions,
      ...card.touchedFiles,
      ...card.blockers,
      card.completedStep,
      card.nextStep,
      card.answerTail,
    ].filter(Boolean).join(' ').toLowerCase();
    if (!memoryText.trim()) return false;
    const terms = text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [];
    return terms.some((term) => memoryText.includes(term));
  }

  /** Prepare a summary while idle. It never runs for compact profiles and
   * never blocks a new request; deterministic compaction remains the fallback. */
  private scheduleBackgroundCompaction(): void {
    const config = getConfig();
    if (
      this.backgroundCompactionInFlight
      || this.phase !== 'idle'
      || this.buildContextProfile().tier === 'compact'
      || (findPreset(config.preset) ?? PRESETS[0]).local
    ) {
      return;
    }
    if (this.backgroundCompactionTimer) clearTimeout(this.backgroundCompactionTimer);
    this.backgroundCompactionTimer = setTimeout(() => {
      this.backgroundCompactionTimer = undefined;
      void this.prepareBackgroundCompaction();
    }, 250);
  }

  private async prepareBackgroundCompaction(): Promise<void> {
    if (this.backgroundCompactionInFlight || this.phase !== 'idle') return;
    if ((findPreset(getConfig().preset) ?? PRESETS[0]).local) return;
    const profile = this.buildContextProfile();
    const request = composePlannerRequest({
      conversation: projectCompressedMessages(this.conversation, this.compressionBlocks),
      contextIndex: this.contextIndex,
      archived: this.archivedConversation,
      archivedContextIndex: this.archivedContextIndex,
      budget: relevanceBudget(profile.tier),
      pinned: this.buildPinnedContext(),
    });
    const check = checkCompaction(request.messages, this.effectiveContextLimit(), {
      profile,
      reasoning: this.profileSupportsReasoning(),
    });
    if (!check.needed || check.recentStart <= 2) return;
    const fingerprint = sha1Of(JSON.stringify(request.messages.slice(2, check.recentStart)));
    this.backgroundCompactionInFlight = true;
    try {
      const mainProvider = await this.buildProvider();
      const plannerSelection = await this.resolveRoleSelection('planner', mainProvider);
      if (!plannerSelection || this.phase !== 'idle') return;
      const summary = await summarizeMessages(
        plannerSelection.provider,
        plannerSelection.model,
        request.messages.slice(2, check.recentStart),
        new AbortController().signal,
      );
      if (summary && this.phase === 'idle') this.backgroundCompaction = { fingerprint, summary };
    } catch {
      // The next request uses the existing deterministic checkpoint.
    } finally {
      this.backgroundCompactionInFlight = false;
    }
  }

  private async editMessage(id: string, text: string, restoreWorkspace: boolean): Promise<void> {
    if (isActivePhase(this.phase)) {
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
      .map((message) => ({ id: message.id, role: message.role as 'user' | 'assistant', content: message.text }));
    this.contextIndex = rebuildContextIndex(this.conversation);
    this.pendingContextMetadata = undefined;
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
        profile: this.contextProfileInfo(),
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
    this.embedWorker?.stop();
    this.stop();
    clearTimeout(this.persistTimer);
    void this.store.save(this.snapshotSession(), this.contextIndex).catch(() => undefined);
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
    if (isActivePhase(this.phase)) {
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
      let retried = false;
      const text = await this.collectTextWithContinuation(
        provider,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        {
          model: getConfig().model,
          temperature: 0.2,
          signal: new AbortController().signal,
          contextTokens: this.effectiveContextLimit(),
        },
        {
          retryOnEmpty: true,
          onRetry: (attempt) => {
            retried = true;
            this.setStatus('retry', `Retrying attempt ${attempt}…`);
          },
        },
      );
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
    if (isActivePhase(this.phase)) {
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
      let retried = false;
      const text = await this.collectTextWithContinuation(
        provider,
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        { model: getConfig().model, temperature: 0.2, signal: new AbortController().signal, contextTokens: this.effectiveContextLimit() },
        {
          retryOnEmpty: true,
          onRetry: (attempt) => {
            retried = true;
            this.setStatus('retry', `Retrying attempt ${attempt}…`);
          },
        },
      );
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
        'Dev-First: enable devFirst.semanticIndex first.',
      );
      return;
    }
    try {
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
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Dev-First: semantic index unavailable — ${errorMessage(error)}. Lexical search remains available.`,
      );
    }
  }

  async clearSemanticIndex(): Promise<void> {
    const index = this.getSemanticIndex();
    index?.clear();
    await fs
      .rm(
        workspaceStoragePath(
          this.context.globalStorageUri.fsPath,
          workspaceRoot() ?? process.cwd(),
          'semantic-index.json',
        ),
        { force: true },
      )
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
    this.toolRegistryCache = null;
    this.toolRegistryCacheKey = null;
    await this.mcp.ensureLoaded(workspaceRoot());
  }

  async setModel(model: string): Promise<void> {
    await this.handleSetModel(model);
  }

  async refreshConnectionState(): Promise<void> {
    await this.refreshConnection();
  }

  async plannerToolDefs(): Promise<ToolDef[]> {
    return this.buildPlannerToolRegistry();
  }

  readOnlyToolExecutor(): ((call: ToolCall) => Promise<string>) | undefined {
    return (call) => this.executePlannerToolOn(this.scannerReadOnlyToolbox(), call);
  }

  private scannerToolboxKey(): string {
    const config = getConfig();
    return [
      workspaceRoot() ?? process.cwd(),
      config.preset,
      config.model,
      config.baseUrl,
      config.semanticIndex ? 'semantic' : 'lexical',
      config.memory ? 'memory' : 'no-memory',
    ].join('|');
  }

  /** Reuse the read-only toolbox for one scanner run instead of rebuilding all
   * tool handlers and their caches for every file/search call. */
  private scannerReadOnlyToolbox(): ToolBox {
    const key = this.scannerToolboxKey();
    if (!this.scannerToolbox || this.scannerToolbox.key !== key) {
      this.scannerToolbox = { key, toolbox: this.buildToolbox(false, 'full') };
    }
    return this.scannerToolbox.toolbox;
  }

  private async handleSend(
    rawText: string,
    selection?: SelectionContext,
    quote?: string,
    images?: string[],
    pastes?: PastedContent[],
  ): Promise<void> {
    await this.sessionReady;
    const text = rawText.trim();
    if (!text && !images?.length) {
      return;
    }
    const cappedImages = (images ?? []).slice(0, 4);
    const root = workspaceRoot();
    const attachment: MessageAttachment | undefined = selection
      ? { path: selection.path, startLine: selection.startLine, endLine: selection.endLine }
      : undefined;
    // Render the submitted message before any paste materialization, provider
    // startup, or routing request. This keeps the transcript responsive even
    // when a local model is cold or the route probe is slow.
    const submittedMessage = this.addUserMessage(text, attachment, quote, cappedImages);
    this.eventLedger.append('message', { messageId: submittedMessage.id, text: text.slice(0, 600) });
    const ownsRouteStage = !this.streamingMessageId;
    if (ownsRouteStage) {
      this.setStage('Thinking…');
    }
    const materialized = await this.savePastesToFiles(text, pastes, root);
    const activePhase = isActivePhase(this.phase);
    const fastAcknowledgement = !this.plan
      && !activePhase
      && /^(?:ok|okay|thanks|thank you|got it|cool|nice|great|sounds good)[.!]?$/i.test(materialized.trim());
    let route = fastAcknowledgement
      ? 'acknowledgement'
      : classifyIncomingMessage(
        materialized,
        this.taskState,
        activePhase,
      );
    let routeResponse: string | undefined = fastAcknowledgement ? 'Got it.' : undefined;
    let provisionalMode: PlanningMode | undefined;
    let answerCoverage: string[] | undefined;
    const messageId = submittedMessage.id;
    const stateBefore = this.taskState.state;
    const continuationTarget = this.resolveContinuationTarget(materialized);
    if (continuationTarget && continuationTarget.kind !== 'answer') {
      // A resumable task/plan must beat the generic route probe. This prevents
      // an unfinished run from being mistaken for a brand-new task.
      route = 'continue-task';
    }
    // An answer already owns the provider and stream. Queue a new message
    // immediately instead of launching a second classifier/provider request
    // against the same session; it will be routed after the answer settles.
    if (this.phase === 'answering') {
      this.queuedMessages.push({
        id: submittedMessage.id,
        text: materialized,
        selection,
        quote,
        images: cappedImages,
        pastes,
        createdAt: Date.now(),
      });
      submittedMessage.queued = true;
      submittedMessage.pastes = pastes;
      this.post({ type: 'addMessage', message: submittedMessage });
      this.recordRoute(messageId, 'follow-up', stateBefore);
      this.persist();
      return;
    }
    // Preflight every non-trivial message before planner preparation. The
    // model decides the semantic route; the local result is only a failure
    // fallback. Exact idle acknowledgements skip the extra model call.
    const provider = fastAcknowledgement ? undefined : await this.buildProvider();
    const idleOrReview = this.phase === 'idle' || this.phase === 'review';
    if (provider && idleOrReview && continuationTarget?.kind === 'answer' && this.shouldResumeLastAnswer(materialized)) {
      const resumeState = this.answerStateForContinuation(continuationTarget);
      const outcome = await this.answerQuestionDirectly(
        provider,
        materialized,
        submittedMessage,
        cappedImages,
        selection,
        quote,
        resumeState,
      );
      this.recordRoute(messageId, 'continue-task', stateBefore);
      if (!outcome.answered) {
        this.addNotice(outcome.notice ?? 'The model returned no continuation. Try asking for the next section directly.');
      }
      return;
    }
    if (provider && !continuationTarget) {
      const config = getConfig();
      const decision = await classifyMessageRoute(
        provider,
        config.model,
        materialized,
        this.taskState,
        this.plan,
        undefined,
        this.effectiveContextLimit(),
        {
          ...(this.continuation ? { continuationKind: this.continuation.kind, continuationStatus: this.continuation.status } : {}),
          ...(this.lastAnswer ? { lastAnswerStatus: this.lastAnswer.status, lastAnswerQuestion: this.lastAnswer.question } : {}),
        },
      );
      if (decision) {
        route = decision.route;
        routeResponse = decision.response;
        answerCoverage = decision.route === 'question' || decision.route === 'answer'
          ? decision.answerCoverage
          : undefined;
        if (decision.mode && (decision.route === 'new-task' || decision.route === 'refine-plan')) {
          provisionalMode = decision.mode;
        }
      }
    } else if (!fastAcknowledgement && ownsRouteStage) {
      this.endStreaming();
    }
    if (route === 'smalltalk' || route === 'acknowledgement') {
      const response = routeResponse || (route === 'acknowledgement' ? 'Got it.' : 'How can I help?');
      if (ownsRouteStage) {
        this.appendStreamingText(response);
        this.endStreaming();
      } else {
        this.addAssistantMessage(response);
      }
      this.recordRoute(messageId, route, stateBefore);
      return;
    }
    if (route === 'needs-clarification') {
      const response = routeResponse
        || 'I need one clarification before I can plan this safely: what should change, and where should it happen?';
      if (ownsRouteStage) {
        this.appendStreamingText(response);
        this.endStreaming();
      } else {
        this.addAssistantMessage(response);
      }
      this.recordRoute(messageId, route, stateBefore);
      return;
    }
    if (route === 'cancel-plan' && this.plan?.status === 'draft') {
      this.discardPlan();
      if (ownsRouteStage) {
        this.appendStreamingText('Draft plan discarded — nothing was changed.');
        this.endStreaming();
      } else {
        this.addAssistantMessage('Draft plan discarded — nothing was changed.');
      }
      this.recordRoute(messageId, route, stateBefore);
      return;
    }
    if (route === 'cancel-plan') {
      route = 'continue-task';
    }
    if ((route === 'question' || route === 'answer') && provider && idleOrReview) {
      if (!root) {
        this.addNotice('Open a folder before asking a codebase question.');
        this.recordRoute(messageId, route, stateBefore);
        return;
      }
      const outcome = await this.answerQuestionDirectly(
        provider,
        materialized,
        submittedMessage,
        cappedImages,
        selection,
        quote,
        undefined,
        answerCoverage,
      );
      this.recordRoute(messageId, route, stateBefore);
      if (!outcome.answered) {
        this.addNotice(outcome.notice ?? 'The model returned no answer. Try naming a specific file, symbol, or topic.');
      }
      return;
    }
    if (route === 'answer' || route === 'refine-plan') {
      // These are handled by the normal planner conversation when idle. While
      // execution is active, preserve them as follow-ups for the next turn.
      route = isActivePhase(this.phase) ? 'follow-up' : route;
    }
    if (route === 'continue-task') {
      const resumablePlan = this.plan;
      if (isActivePhase(this.phase)) {
        route = 'follow-up';
      } else if (this.recoveryRun && resumablePlan && resumablePlan.status !== 'completed') {
        this.recordRoute(messageId, 'continue-task', stateBefore);
        await this.resumeRun(this.recoveryRun.id);
        return;
      } else if (resumablePlan?.status === 'approved') {
        const resumeProvider = provider ?? await this.buildProvider();
        if (!resumeProvider) {
          this.addNotice('Cannot continue the approved plan because no model provider is available. Reconnect the model, then send “continue” again.');
          this.recordRoute(messageId, 'continue-task', stateBefore);
          return;
        }
        this.lastRequest = this.taskState.taskSummary || resumablePlan.title || materialized;
        this.recordRoute(messageId, 'continue-task', stateBefore);
        await this.startExecution(resumablePlan, resumeProvider, true);
        return;
      } else if (resumablePlan?.status === 'draft') {
        route = 'refine-plan';
      } else {
        route = 'new-task';
      }
    }
    if (isActivePhase(this.phase)) {
      this.queuedMessages.push({
        id: submittedMessage.id,
        text: materialized,
        selection,
        quote,
        images: cappedImages,
        pastes,
        newTask: route === 'new-task',
        createdAt: Date.now(),
      });
      submittedMessage.queued = true;
      submittedMessage.pastes = pastes;
      this.post({ type: 'addMessage', message: submittedMessage });
      this.recordRoute(messageId, route, stateBefore);
      this.persist();
      return;
    }
    if (!root) {
      this.addNotice('Open a folder before sending a request.');
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
    const questionMode = route === 'question' || route === 'answer';
    const deferKnowledgeRefresh = Boolean((findPreset(config.preset) ?? PRESETS[0]).local);
    if (this.plan && this.plan.status !== 'draft') {
      this.plan = null;
      this.post({ type: 'plan', plan: null });
      this.persist();
    }

    // Post the user message and the assistant bubble before any slow setup so
    // the transcript responds instantly; the stage line explains the wait.
    this.lastRequest = effective;
    const userMessage = submittedMessage;
    this.taskState = {
      taskId: randomId('task'),
      state: 'planning',
      taskSummary: effective,
      completedSteps: [],
      nextSteps: [],
      blockers: [],
      lastHeartbeatAt: Date.now(),
    };
    this.setContinuation('task', this.taskState.taskId, 'active');
    this.setPhase('planning');
    this.recordRoute(userMessage.id, route, stateBefore);
    this.beginTaskWatchdog();
    this.ensureStreamingMessage();
    this.setStage('PLANNING — preparing local model…');
    // On local presets the refresh runs a background model call that competes
    // with the planner's own prompt evaluation on the same single GPU.
    if (!deferKnowledgeRefresh) {
      this.startKnowledgeRefresh();
    }

    try {
      // Provider setup, request-context expansion, rules, and the tool
      // registry are independent preparation work. Start them together so
      // model startup does not wait behind unrelated local reads.
      this.setStage('PLANNING — loading tools and context…');
      const providerPromise = this.buildProvider();
      const plannerSelectionPromise = providerPromise.then((main) => this.resolveRoleSelection('planner', main));
      const requestContextPromise = (async () => {
        const quotePrefix = quote?.trim() ? `[context] ${quote.trim()} [/context]\n\n` : '';
        let llmText = quotePrefix + (await this.expandSessionMentions(await this.expandFileMentions(effective, root)));
        if (selection) {
          llmText += formatSelectionAttachment(selection);
        }
        const editorContext = this.editorContext();
        if (editorContext) {
          llmText += editorContext;
        }
        return llmText;
      })();
      const preparationPromise = Promise.all([
        this.buildRules(root, text),
        this.registry.load(),
      ]);
      const [provider, llmText, [rules], plannerSelection] = await Promise.all([
        providerPromise,
        requestContextPromise,
        preparationPromise,
        plannerSelectionPromise,
      ]);
      if (!provider) {
        return;
      }
      if (!plannerSelection) {
        this.addError('The configured planner model is unavailable; no plan was started. Check its provider and model settings.');
        return;
      }
      this.preparedProvider = { key: this.providerCacheKey(config), provider };
      this.lastRequest = llmText;
      this.appendUserConversation(userMessage, llmText, cappedImages);
      const plannerProvider = plannerSelection.provider;
      const plannerModel = plannerSelection.model;
      const preset = plannerSelection.preset;
      const plannerContext = this.modelContextInfo(preset.id, plannerModel, preset.provider);
      const registryInfo = plannerContext.registry;
      const catalogInfo = plannerContext.catalog;
      const family = promptFamilyFor(preset.provider, plannerModel);

      const plannerReasoningSupported =
        plannerContext.supportsReasoning ||
        (this.selectedModelMetadata(preset.id, plannerModel, preset.provider).reasoningLevels?.length ?? 0) > 0;
      const plannerCatalog = await this.buildPlannerToolRegistry(plannerContext.profile.tier);
      const initialPlannerNames = new Set([
        'inspect_file_context', 'bounded_investigation', 'verify_change',
        'local_hybrid_search', 'find_and_read', 'find_symbol', 'document_symbols',
        'read_file', 'skim_file', 'read_output', 'search_text', 'list_files', 'run_terminal_command',
      ]);
      const initialPlannerTools = plannerCatalog.filter((tool) => initialPlannerNames.has(tool.name));
      const lazyPlannerTools = plannerCatalog.filter((tool) => !initialPlannerNames.has(tool.name));
      const plannerTools = [
        ...initialPlannerTools,
        ...(lazyPlannerTools.length > 0 ? [loadToolsTool(lazyPlannerTools.map((tool) => tool.name))] : []),
      ];
      const planningToolbox = this.buildToolbox(false, 'marker');
      this.activePlannerToolbox = planningToolbox;
      const planner = new PlannerService(plannerProvider, plannerModel, {
        maxSteps: this.plannerStepLimit(config, preset),
        tools: plannerTools,
        lazyTools: lazyPlannerTools,
        rules,
        family,
        reasoning: this.plannerReasoningOptions(plannerReasoningSupported, preset.id, {
          phase: 'planning',
          turn: 0,
          previousToolNames: [],
          previousToolFailed: false,
        }, plannerModel),
        resolveReasoning: (context) => this.plannerReasoningOptions(plannerReasoningSupported, preset.id, context, plannerModel),
        reasoningSwitch: this.reasoningSwitchEnabled(),
        contextLimitTokens: plannerContext.limit,
        workspaceRoot: root,
        questionMode,
        planningMode: this.plan?.status === 'draft' ? (this.plan.planningMode ?? provisionalMode) : provisionalMode,
        onToolResultsTrimmed: () => planningToolbox.resetReadCache(),
      });
      this.abortController = new AbortController();
      // Warmup is best-effort; never hold the first planner token behind it.
      void this.settleWarmup();
      const plannerConversationPromise = this.preparePlannerConversation(
        plannerProvider,
        plannerContext,
        plannerModel,
        preset.local,
      );
      await plannerConversationPromise;
      this.setStage('PLANNING — processing code context…');

      this.lastPlannerStats = undefined;
      const result = await planner.plan(
        await plannerConversationPromise,
        this.plan,
        this.planVersion + 1,
        {
          onTextDelta: (delta) => { this.touchTaskWatchdog(); this.appendStreamingText(delta); },
          onTextRewind: (characters) => this.rewindStreamingText(characters),
          onReasoningDelta: (delta) => { this.touchTaskWatchdog(); this.appendStreamingReasoning(delta); },
          onReasoningRewind: (characters) => this.rewindStreamingReasoning(characters),
          onStage: (stage) => { this.touchTaskWatchdog(); this.setStage(stage); },
          onToolActivity: (id, label, status, icon, meta) => { this.touchTaskWatchdog(); this.upsertActivity(id, label, status, icon, meta); },
          executeTool: (call) => this.executePlannerToolOn(planningToolbox, call, () => ({
            usedTokens: this.contextTokens,
            limitTokens: plannerContext.limit,
          })),
          setReasoning: (level) => this.setRunReasoning(level),
          compressContext: async (focus) => {
            planningToolbox.resetReadCache();
            return this.compressContext(focus, plannerContext, plannerProvider, plannerModel);
          },
          onNotice: (notice) => this.addNotice(notice),
          onStatus: (id, text, tone, done) => { this.touchTaskWatchdog(); this.setStatus(id, text, tone, done); },
          onUsage: (tokens) => { this.touchTaskWatchdog(); this.reportUsage(tokens); },
          onUsageExact: (usage) => { this.touchTaskWatchdog(); this.reportExactUsage(usage); },
        },
        this.abortController.signal,
      );
      this.lastPlannerStats = result.stats;

      if (result.plan && isExplanationPlan(result.plan)) {
        const markdown = explanationToMarkdown(result.plan);
        const content = markdown || result.text.trim();
        const message = markdown ? this.addAssistantMessage(markdown) : undefined;
        if (content) {
          this.appendConversation({ id: message?.id ?? this.streamingMessageId ?? undefined, role: 'assistant', content });
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
          this.setContinuation('plan', `plan:${this.plan.version}`, 'paused');
          this.recordContextMetadata(planContextMetadata(result.plan));
          await this.savePlanFile(this.plan, this.lastRequest);
          this.post({ type: 'plan', plan: this.plan });
          this.persist();
          this.needsInputListener?.('a plan is ready for your approval');
          if (getConfig().memory) {
            const convention = await this.matchStoredConvention(result.plan);
            if (convention) {
              result.plan.convention = convention.statement;
              await this.savePlanFile(this.plan, this.lastRequest);
              this.post({ type: 'plan', plan: this.plan });
              this.persist();
            }
          }
        }
      } else if (result.dismissed) {
        const hadDraft = this.plan !== null;
        if (hadDraft) {
          this.discardPlan();
        }
        this.addNotice(hadDraft ? 'Draft plan discarded — nothing was changed.' : 'There is no draft plan to discard.');
      } else {
        if (result.text.trim()) {
          this.appendConversation({ id: this.streamingMessageId ?? undefined, role: 'assistant', content: result.text });
        }
        if (result.stopped === 'same-plan') {
          this.addNotice('The planner could not fill in the plan details. Try rephrasing or splitting the request.');
        } else if (result.stopped === 'stream-loop') {
          this.addNotice('Planning stopped after repeated streamed output. The distinct partial response is preserved.');
        } else if (result.exhausted) {
          this.addNotice('The planner stopped before producing a ready plan. Try rephrasing or splitting the request.');
        } else if (!result.text.trim()) {
          this.addNotice('The model produced no output — its context may be full. Try Compact, or a smaller request.');
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        this.markStreamingInterrupted();
        if (!this.taskWatchdogTriggered) {
          this.addNotice('Stopped.');
        }
      } else {
        this.markStreamingInterrupted();
        this.addError(errorMessage(error));
      }
    } finally {
      if (deferKnowledgeRefresh) {
        this.startKnowledgeRefresh();
      }
      this.endTaskWatchdog();
      this.endStreaming();
      this.setPhase(this.diffManager.hasPendingChanges() ? 'review' : 'idle');
      this.abortController = null;
      this.reasoningOverride = undefined;
      this.reasoningChanges = 0;
      this.runningQueued = undefined;
      this.scheduleBackgroundCompaction();
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
    const config = getConfig();
    const key = this.providerCacheKey(config);
    const provider = this.preparedProvider?.key === key
      ? this.preparedProvider.provider
      : await this.buildProvider();
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
        this.effectiveContextLimit(),
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
    if (next.newTask && this.plan?.status === 'draft') {
      this.discardPlan();
    }
    this.runningQueued = {
      id: next.id,
      text: next.text,
      selection: next.selection,
      quote: next.quote,
      images: next.images,
      pastes: next.pastes,
      createdAt: next.createdAt,
    };
    const uiMessage = this.uiMessages.find((message) => message.id === next.id);
    if (uiMessage) {
      uiMessage.queued = false;
      this.post({ type: 'removeMessage', id: next.id });
      this.uiMessages = this.uiMessages.filter((message) => message.id !== next.id);
    }
    void this.handleSend(next.text, next.selection, next.quote, next.images, next.pastes);
  }

  private isDirectRun(plan: Plan): boolean {
    if (plan.intent === 'explanation' || plan.skippedSteps?.length) {
      return false;
    }
    if (plan.planningMode !== 'skip' && plan.trivial !== true) {
      return false;
    }
    const steps = plan.steps ?? [];
    const expected = plan.expectedFiles ?? [];
    if (steps.length > 1 || expected.length > 1) {
      return false;
    }
    if (expected.some((file) => file.action === 'delete' || matchesRiskPath(file.path))) {
      return false;
    }
    const text = steps.join(' ');
    if (/(?:^|\b)(?:install|uninstall|remove|delete|drop|migrate|migration|deploy|publish|reset|purge|format|sudo)\b/i.test(text)) {
      return false;
    }
    return true;
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
    const config = getConfig();
    const key = this.providerCacheKey(config);
    const provider = this.preparedProvider?.key === key
      ? this.preparedProvider.provider
      : await this.buildProvider();
    if (!provider) {
      return;
    }
    await this.startExecution(this.plan, provider, true);
  }

  private async checkRunFinish(summary: FinishCheckSummary): Promise<FinishGateResult> {
    this.setStage('VERIFYING — checking changed files…');
    const plan = this.plan;
    const steps = plan?.steps ?? [];
    const completed = new Set<number>(this.currentRun?.completedSteps ?? []);
    for (let index = 0; index < steps.length; index++) {
      const text = steps[index].trim();
      if (this.todos.some((todo) => todo.status === 'done' && todo.text.trim() === text)) {
        completed.add(index);
      }
    }
    const root = workspaceRoot() ?? process.cwd();
    const run = this.currentRun;
    let snapshots = new Map<string, FileSnapshotEntry>();
    if (run) {
      try {
        snapshots = new Map((await this.fileSnapshots.index(run.id)).map((entry) => [entry.path, entry]));
      } catch {}
    }
    const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '');
    const candidatePaths = new Set(summary.changedFiles.map((file) => normalizePath(file.path)));
    const diffRunId = this.diffManager.getCurrentRunId();
    if (diffRunId && typeof this.diffManager.runFiles === 'function') {
      // Backstop: the diff manager knows every file this run actually touched,
      // even if a compound tool's result shape missed one.
      for (const file of this.diffManager.runFiles(diffRunId)) {
        candidatePaths.add(normalizePath(file.path));
      }
    }
    const changedFiles: Array<{ path: string; delivered: boolean }> = [];
    let baselinesAvailable = false;
    for (const path of candidatePaths) {
      const entry = snapshots.get(path);
      if (!entry) {
        changedFiles.push({ path, delivered: true });
        continue;
      }
      baselinesAvailable = true;
      const current = await sha1File(absoluteWorkspacePath(root, path));
      const delivered = entry.absent ? current !== undefined : current !== entry.hash;
      changedFiles.push({ path, delivered });
    }
    const planRequiredCheck = planCheckRequirementFromPlan(plan?.steps, plan?.verification);
    if (run?.reliability) {
      const failed = summary.newDiagnosticErrors > 0
        || summary.recentToolFailures.length > 0
        || summary.verificationFailures.length > 0;
      const next = reliabilityVerification(run.reliability, summary.verificationRan, failed);
      if (next) {
        const files = new Set(next.scope.files);
        const evidence = [...next.evidence];
        for (const file of changedFiles) {
          files.add(file.path);
          if (!evidence.some((item) => item.kind === 'changed-file' && item.file === file.path)) {
            evidence.push({ kind: 'changed-file', summary: 'Changed during this run', file: file.path });
          }
        }
        run.reliability = {
          ...next,
          scope: { ...next.scope, files: [...files].sort() },
          evidence: evidence.slice(-32),
        };
        run.updatedAt = Date.now();
        this.persist();
      }
    }
    return checkFinish({
      planSteps: steps,
      completedSteps: [...completed],
      skippedSteps: plan?.skippedSteps ?? [],
      todos: this.todos.map((todo) => ({ text: todo.text, status: todo.status })),
      expectedFiles: (plan?.expectedFiles ?? []).map((file) => ({ path: file.path, action: file.action })),
      changedFiles,
      recentToolFailures: summary.recentToolFailures,
      newDiagnosticErrors: summary.newDiagnosticErrors,
      diagnosticsAvailable: summary.diagnosticsAvailable,
      verificationRan: summary.verificationRan,
      verificationFailures: summary.verificationFailures,
      ...(planRequiredCheck ? { planRequiredCheck } : {}),
      baselinesAvailable,
    });
  }

  private async startExecution(plan: Plan, provider: LLMProvider, approve: boolean): Promise<void> {
    const config = getConfig();
    const root = workspaceRoot() ?? process.cwd();
    // Knowledge mining is advisory. Never hold approved execution behind a
    // scanner/convention refresh; it can continue in the background while the
    // editor starts applying the approved plan.
    this.setStage('IMPLEMENTING — loading tools…');
    const rulesPromise = this.buildRules(root, this.lastRequest);
    const registryLoadPromise = this.registry.load();
    const editorSelection = await this.resolveRoleSelection('editor', provider);
    if (!editorSelection) {
      this.addError('The configured editor model is unavailable; execution stayed stopped and no files were changed.');
      return;
    }
    const executionProvider = editorSelection.provider;
    const executionModel = editorSelection.model;
    const preset = editorSelection.preset;
    const editorContext = this.modelContextInfo(preset.id, executionModel, preset.provider);
    const [rules, registry] = await Promise.all([
      rulesPromise,
      this.buildToolRegistry(editorContext),
    ]);
    await registryLoadPromise;
    this.activeReasoningModel = { presetId: preset.id, model: executionModel };
    const registryInfo = editorContext.registry;
    const catalogInfo = editorContext.catalog;
    const family = promptFamilyFor(preset.provider, executionModel);
    const executorReasoningSupported =
      Boolean(catalogInfo?.reasoning) || (registryInfo?.supportsReasoning ?? false) ||
      (this.selectedModelMetadata(preset.id, executionModel, preset.provider).reasoningLevels?.length ?? 0) > 0;
    const executorReasoning = this.reasoningOptions(executorReasoningSupported, preset.id, executionModel);
    const reasoningLabel = executorReasoning
      ? executorReasoning.effort ?? (executorReasoning.enabled ? 'on' : 'off')
      : undefined;
    const contextProfile = contextProfileFor({
      contextWindow: editorContext.limit,
      maxOutput: editorContext.reserved,
      supportsTools: registryInfo?.supportsTools ?? true,
      supportsReasoning: executorReasoningSupported,
      override: config.contextProfile,
    });
    const initialEvidence = (plan.expectedFiles?.length ?? 0) === 0
      ? await this.codebaseEvidenceForRequest(this.lastRequest ?? '', contextProfile.tier === 'compact' ? 4 : 6)
      : undefined;

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
        model: executionModel,
        status: 'approved',
        planVersion: this.planVersion,
        stepIndex: 0,
        completedSteps: [],
        operations: [],
        ...(reasoningLabel ? { reasoning: reasoningLabel } : {}),
        ...(this.lastCheckpointId ? { checkpointId: this.lastCheckpointId } : {}),
        workspaceHash: this.lastCheckpointId ?? (await this.hashWorkspaceFiles()),
        reliability: reliabilityStateForPlan(plan, this.lastCheckpointId),
        ...(this.lastPlannerStats ? { plannerStats: this.lastPlannerStats } : {}),
        createdAt: now,
        updatedAt: now,
      };
    } else {
      if (!this.currentRun.checkpointId && this.lastCheckpointId) {
        this.currentRun.checkpointId = this.lastCheckpointId;
      }
      if (!this.currentRun.reliability) {
        this.currentRun.reliability = reliabilityStateForPlan(plan, this.currentRun.checkpointId);
      }
      if (reasoningLabel && !this.currentRun.reasoning) {
        this.currentRun.reasoning = reasoningLabel;
      }
      if (this.lastPlannerStats) {
        this.currentRun.plannerStats = this.lastPlannerStats;
      }
      this.currentRun.updatedAt = now;
    }
    await this.saveRunNow();
    if (approve) {
      plan.status = 'approved';
      this.eventLedger.setTask(this.taskState.taskId);
      this.eventLedger.append('plan', { version: plan.version, title: plan.title ?? '', steps: plan.steps ?? [] });
      this.recordContextMetadata(planContextMetadata(plan));
      this.post({ type: 'plan', plan });
      this.persist();
    }
    this.setPhase('executing');
    this.markRun('executing');
    this.abortController = new AbortController();
    this.beginTaskWatchdog();

    // Seed the visible progress state from the approved plan before the
    // executor starts. Compound calls may batch work, so waiting for the
    // model's first todo_write can leave the plan card behind the work.
    // Resumed runs and model-authored checkpoints remain authoritative.
    if (this.todos.length === 0 && plan.steps?.length) {
      this.todos = plan.steps.map((text, index) => ({
        text,
        status: plan.skippedSteps?.includes(index)
          ? 'done'
          : index === 0
            ? 'in_progress'
            : 'pending',
      }));
      this.post({ type: 'todos', todos: this.todos });
      this.persist();
      this.recordRunProgress();
    }

    const executionToolbox = this.buildToolbox();
    this.activeExecutorToolbox = executionToolbox;
    const agent = new AgentService(executionProvider, executionModel, executionToolbox, {
      maxSteps: config.maxSteps,
      tools: registry.executor,
      lazyTools: registry.lazyExecutor,
      rules,
      family,
      autoCompact: config.autoCompact,
      contextLimitTokens: editorContext.limit,
      parallelTools: config.parallelTools,
      reasoning: executorReasoning,
      resolveReasoning: (context) => this.executionReasoningOptions(executorReasoningSupported, preset.id, context, executionModel),
      planFilePath: plan.filePath,
      contextProfile,
      profileReasoning: executorReasoningSupported,
      deterministicContext: preset.local,
      retrievalPasses: contextProfile.tier === 'compact' ? 1 : 2,
      requireFinish: true,
      ...(initialEvidence ? { initialEvidence } : {}),
      ...(this.eventLedger.condensed(1400) ? { ledger: this.eventLedger.condensed(1400) } : {}),
      finishCheck: (summary) => this.checkRunFinish(summary),
      taskState: {
        state: this.taskState.state,
        completedSteps: this.taskState.completedSteps,
        nextSteps: this.taskState.nextSteps,
        blockers: this.taskState.blockers,
      },
    });

    // Approved execution should start immediately; warmup is only a hint.
    void this.settleWarmup();
    this.setStage('IMPLEMENTING — applying approved changes…');
    let runStopped = false;
    try {
      const result = await agent.run(plan, this.lastRequest, this.abortController.signal, {
        onTextDelta: (delta) => { this.touchTaskWatchdog(); this.appendStreamingText(delta); },
        onTextRewind: (characters) => this.rewindStreamingText(characters),
        onReasoningDelta: (delta) => { this.touchTaskWatchdog(); this.appendStreamingReasoning(delta); },
        onReasoningRewind: (characters) => this.rewindStreamingReasoning(characters),
        onToolActivity: (id, label, status, icon, meta) => { this.touchTaskWatchdog(); this.upsertActivity(id, label, status, icon, meta); },
        requestTerminalApproval: (command, cwd) => this.requestApproval(command, cwd),
        requestExternalDirectoryApproval: (directory) => this.requestExternalAccess(directory),
        askUser: (request) => this.requestUserAnswer(request),
        setReasoning: (level) => this.setRunReasoning(level),
        compressContext: (focus) => this.compressContext(focus, editorContext, executionProvider, executionModel),
        onNotice: (notice) => this.addNotice(notice),
        onStatus: (id, text, tone, done) => { this.touchTaskWatchdog(); this.setStatus(id, text, tone, done); },
        onUsage: (tokens) => { this.touchTaskWatchdog(); this.reportUsage(tokens); },
        onUsageExact: (usage) => { this.touchTaskWatchdog(); this.reportExactUsage(usage); },
        onCompaction: (info) => this.addCompactionMessage(info),
        takePendingUserMessage: () => this.takePendingUserMessage(),
        planCheckRequirement: planCheckRequirementFromPlan(this.plan?.steps, this.plan?.verification),
        progressSnapshot: () => ({ completedStepCount: this.currentRun?.completedSteps.length ?? 0 }),
      });
      if (this.currentRun && result.stats) {
        this.currentRun.stats = result.stats;
        this.currentRun.updatedAt = Date.now();
      }
      if (result.files?.length) {
        this.diffManager.setFileSummaries(result.files);
      }
      runStopped = Boolean(result.incomplete || result.stoppedByLoop || result.stoppedByMistakes || result.reachedLimit);
      const planSnapshot = runStopped ? undefined : this.completePlan(plan);
      if (result.summary) {
        const summaryText = result.incomplete
          ? `${result.summary}\n\nRun ended incomplete — ${result.incomplete.issues[0] ?? 'finish check failed'}`
          : result.summary;
        const runId = this.diffManager.getCurrentRunId();
        this.addCompletionMessage(summaryText, planSnapshot, runId, runId ? this.diffManager.runFiles(runId) : [], !runStopped);
      }
      if (result.reachedLimit && config.maxSteps > 0) {
        this.addNotice(
          `Run ended incomplete — reached the step limit (${config.maxSteps}). Completed work is preserved. Review the changes, then send a message to continue.`,
        );
      }
      this.markRun(runStopped ? 'stopped' : 'completed');
    } catch (error) {
      if (isAbortError(error)) {
        this.markStreamingInterrupted();
        if (this.currentRun) {
          this.currentRun.pending = undefined;
        }
        if (this.currentRun && (this.currentRun.status === 'executing' || this.currentRun.status === 'waiting')) {
          this.markRun('interrupted');
        }
        if (!this.taskWatchdogTriggered) {
          this.addNotice('Stopped.');
        }
      } else {
        this.markStreamingInterrupted();
        if (this.currentRun) {
          this.currentRun.pending = undefined;
        }
        this.markRun('failed');
        this.addError(errorMessage(error));
      }
    } finally {
      this.endTaskWatchdog();
      if (!runStopped) {
        this.completePlan(plan);
      }
      this.endStreaming();
      this.setPhase(this.diffManager.hasPendingChanges() ? 'review' : 'idle');
      this.abortController = null;
      if (this.activePlannerToolbox) {
        this.activePlannerToolbox = undefined;
      }
      if (this.activeExecutorToolbox === executionToolbox) {
        this.activeExecutorToolbox = undefined;
      }
      this.activeReasoningModel = undefined;
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
    const loaded = await this.loadRulesBase(root);
    if (loaded.projectRules) {
      parts.push(loaded.projectRules);
    }
    if (getConfig().memory && loaded.memory) {
      parts.push(`# Project memory\n${loaded.memory}`);
      if (request.trim()) {
        const relevant = relevantProjectModelBullets(parseProjectModelSection(loaded.memory), request);
        const model = formatRelevantProjectModel(relevant);
        if (model) {
          parts.push(model);
        }
      }
    }
    return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
  }

  private async loadRulesBase(root: string): Promise<{ projectRules: string | undefined; memory: string }> {
    if (this.rulesBaseCache) {
      return this.rulesBaseCache;
    }
    const projectRules = await loadProjectRules(root);
    const memory = (await this.memory.read()).trim();
    this.rulesBaseCache = { projectRules, memory };
    return this.rulesBaseCache;
  }

  private invalidateDerivedCaches(): void {
    this.preparedProvider = undefined;
    void this.primeActiveProvider();
    // Model names and Ollama Modelfiles can keep the same identifier while
    // changing capabilities. Force the next capability lookup to refresh.
    resetOllamaCapabilityCache();
    this.rulesBaseCache = null;
    this.toolRegistryCache = null;
    this.toolRegistryCacheKey = null;
    this.plannerToolCache = null;
    this.plannerToolCacheTier = null;
    this.questionToolCache = null;
    this.scannerToolbox = undefined;
    this.plannerConversationCache = null;
  }

  private invalidateRulesBase(): void {
    this.rulesBaseCache = null;
  }

  private startKnowledgeRefresh(): void {
    if (!this.knowledgeSource) {
      this.knowledgeRefresh = null;
      return;
    }
    this.knowledgeRefresh = this.knowledgeSource
      .refreshKnowledge()
      .then(() => {
        this.invalidateRulesBase();
      })
      .catch(() => undefined);
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

  private reasoningOptions(supported: boolean, presetId: string, modelId = getConfig().model): ReasoningOptions | undefined {
    const config = getConfig();
    const providerId = findPreset(presetId)?.provider ?? config.provider;
    const levels = this.selectedModelMetadata(presetId, modelId, providerId).reasoningLevels ?? [];
    const selected = this.selectedReasoningEffort(presetId, modelId, levels);
    const effort = this.reasoningOverride
      ? clampReasoningLevel(this.reasoningOverride, selected, levels)
      : selected;
    if (!supported || levels.length === 0) {
      return undefined;
    }
    const kind = adaptiveKind(presetId, modelId, modelInfo(presetId, modelId));
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

  private executionReasoningOptions(
    supported: boolean,
    presetId: string,
    context: ReasoningRouteContext,
    modelId = getConfig().model,
  ): ReasoningOptions | undefined {
    const config = getConfig();
    const options = config.plannerThinking === 'auto'
      ? this.autoReasoningOptions(supported, presetId, modelId)
      : this.reasoningOptions(supported, presetId, modelId);
    // One reasoning mode governs planning and execution. A run-level override
    // remains authoritative when the model explicitly changes it mid-run.
    if (this.reasoningOverride || config.plannerThinking === 'on') return options;
    if (config.plannerThinking === 'off') return this.disableReasoning(options, presetId, modelId);
    const providerId = findPreset(presetId)?.provider ?? config.provider;
    const levels = this.selectedModelMetadata(presetId, modelId, providerId).reasoningLevels ?? [];
    return routeReasoning(options, levels, context);
  }

  private plannerReasoningOptions(
    supported: boolean,
    presetId: string,
    context?: ReasoningRouteContext,
    modelId = getConfig().model,
  ): ReasoningOptions | undefined {
    const config = getConfig();
    const options = config.plannerThinking === 'auto'
      ? this.autoReasoningOptions(supported, presetId, modelId)
      : this.reasoningOptions(supported, presetId, modelId);
    if (!options || !options.enabled || this.reasoningOverride) {
      return options;
    }
    const mode = config.plannerThinking;
    if (mode === 'on') {
      return options;
    }
    if (mode === 'off') {
      return this.disableReasoning(options, presetId, modelId);
    }
    // Auto uses the same bounded router for local and hosted models. The
    // initial planning request gets an explicit planning context so a binary
    // off/on model starts off and can turn on only after strong evidence.
    const providerId = findPreset(presetId)?.provider ?? config.provider;
    const levels = this.selectedModelMetadata(presetId, modelId, providerId).reasoningLevels ?? [];
    return routeReasoning(options, levels, context ?? {
      phase: 'planning',
      turn: 0,
      previousToolNames: [],
      previousToolFailed: false,
    });
  }

  private disableReasoning(options: ReasoningOptions | undefined, presetId: string, modelId = getConfig().model): ReasoningOptions | undefined {
    if (!options) return options;
    if (presetId === 'deepseek') return { enabled: false };
    const config = getConfig();
    const providerId = findPreset(presetId)?.provider ?? config.provider;
    const levels = this.selectedModelMetadata(presetId, modelId, providerId).reasoningLevels ?? [];
    if (options.effort === 'off' || (!levels.includes('off') && !levels.includes('none'))) return options;
    if (levels.includes('none')) return { ...options, effort: 'none' };
    return { ...options, effort: 'off' };
  }

  private autoReasoningOptions(supported: boolean, presetId: string, modelId = getConfig().model): ReasoningOptions | undefined {
    const options = this.reasoningOptions(supported, presetId, modelId);
    if (!options || !options.enabled || (options.effort !== 'off' && options.effort !== 'none')) return options;
    const config = getConfig();
    const providerId = findPreset(presetId)?.provider ?? config.provider;
    const levels = this.selectedModelMetadata(presetId, modelId, providerId).reasoningLevels ?? [];
    const ceiling = [...levels].reverse().find((level) => level !== 'off' && level !== 'none');
    if (!ceiling) return options;
    if (presetId === 'deepseek') return { ...options, enabled: true };
    return { ...options, enabled: true, effort: ceiling };
  }

  private setRunReasoning(level: string): string {
    const config = getConfig();
    const preset = this.activeReasoningModel
      ? findPreset(this.activeReasoningModel.presetId) ?? (findPreset(config.preset) ?? PRESETS[0])
      : (findPreset(config.preset) ?? PRESETS[0]);
    const modelId = this.activeReasoningModel?.model ?? config.model;
    const metadata = this.selectedModelMetadata(preset.id, modelId, preset.provider);
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
    const selected = this.selectedReasoningEffort(preset.id, modelId, levels, metadata.reasoningDefault);
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
    this.clearStage(message);
    message.reasoning = appendDelta(message.reasoning ?? '', delta);
    this.post({ type: 'reasoningDelta', id: message.id, text: delta });
  }

  private rewindStreamingText(characters: number): void {
    if (!this.streamingMessageId || characters <= 0) return;
    const message = this.uiMessages.find((item) => item.id === this.streamingMessageId);
    if (!message?.text) return;
    message.text = message.text.slice(0, Math.max(0, message.text.length - characters));
    this.post({ type: 'addMessage', message: { ...message } });
  }

  private rewindStreamingReasoning(characters: number): void {
    if (!this.streamingMessageId || characters <= 0) return;
    const message = this.uiMessages.find((item) => item.id === this.streamingMessageId);
    if (!message?.reasoning) return;
    message.reasoning = message.reasoning.slice(0, Math.max(0, message.reasoning.length - characters));
    this.post({ type: 'addMessage', message: { ...message } });
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

  private async buildToolRegistry(
    context: ModelContextInfo,
  ): Promise<{ planner: ToolDef[]; executor: ToolDef[]; lazyExecutor: ToolDef[] }> {
    const cacheKey = `${context.profile.tier}:${context.local ? 'local' : 'remote'}`;
    if (this.toolRegistryCache && this.toolRegistryCacheKey === cacheKey) {
      this.registerToolPreflights(this.toolRegistryCache.executor);
      this.registerToolPreflights(this.toolRegistryCache.lazyExecutor);
      return this.toolRegistryCache;
    }
    const planner = await this.buildPlannerToolRegistry(context.profile.tier);
    const root = workspaceRoot();
    const skills = await listSkills(root);
    const skillNames = skills.map((skill) => skill.name);
    const semanticSearch = Boolean(this.getSemanticIndex());
    const memory = getConfig().memory;
    await this.mcp.ensureLoaded(root);
    const mcpTools = this.mcp.tools();
    const reasoningSwitch = this.reasoningSwitchEnabled();
    const allExecutor = attachToolPreflights(
      executionTools({ skills: skillNames, semanticSearch, memory, mcpTools, reasoningSwitch, task: true }),
    );
    const compact = context.profile.tier === 'compact' || context.local;
    const coreNames = new Set([
      'inspect_file_context', 'investigate_issue', 'bounded_investigation',
      'local_hybrid_search', 'find_and_read', 'find_symbol', 'document_symbols',
      'find_references', 'read_file', 'skim_file', 'read_output', 'search_text',
      'fix_in_file', 'apply_change_set', 'fix_diagnostic',
      'run_terminal_command', 'todo_write', 'finish',
    ]);
    if (semanticSearch) coreNames.add('semantic_search');
    const executor = compact
      ? allExecutor.filter((tool) => coreNames.has(tool.name)).map(compactExecutorToolView)
      : allExecutor;
    const lazyExecutor = compact
      ? allExecutor.filter((tool) => !coreNames.has(tool.name))
      : [];
    if (lazyExecutor.length > 0) {
      executor.push(loadToolsTool(lazyExecutor.map((tool) => tool.name)));
    }
    this.toolRegistryCache = {
      planner,
      executor,
      lazyExecutor,
    };
    this.toolRegistryCacheKey = cacheKey;
    this.registerToolPreflights(allExecutor);
    return this.toolRegistryCache;
  }

  /**
   * Build only the tools needed while deciding whether a request is a
   * question or a change. Executor/MCP tools stay lazy until execution.
   */
  private async buildPlannerToolRegistry(
    _tier: ContextProfileTier = this.mainModelContext().profile.tier,
  ): Promise<ToolDef[]> {
    if (this.plannerToolCache && this.plannerToolCacheTier === _tier) {
      return this.plannerToolCache;
    }
    const root = workspaceRoot();
    const skills = await listSkills(root);
    const config = getConfig();
    const tools = plannerTools({
      skills: skills.map((skill) => skill.name),
      semanticSearch: config.semanticIndex,
      memory: config.memory,
    });
    // Keep the full safe catalog available for load_tools. The initial
    // per-request schema set is selected at the planner call site; compact
    // models therefore retain access to navigation, web, memory, and skills
    // without paying their schema cost on every planner turn.
    this.plannerToolCache = tools;
    this.plannerToolCacheTier = _tier;
    return tools;
  }

  private async buildQuestionToolRegistry(): Promise<ToolDef[]> {
    if (this.questionToolCache) return this.questionToolCache;
    const config = getConfig();
    // Keep the full read-only catalog available for progressive expansion, but
    // do not send it on the first answer turn. The small-model path starts with
    // index/search/navigation primitives and widens only when evidence needs it.
    this.questionToolCache = readOnlyTools({
      semanticSearch: config.semanticIndex,
      memory: config.memory,
    }).filter((tool) => !['list_processes', 'ask_user', 'use_skill'].includes(tool.name));
    return this.questionToolCache;
  }

  private questionToolsForTurn(all: ToolDef[], question: string, turn: number): ToolDef[] {
    const core = new Set(['local_hybrid_search', 'find_and_read', 'read_file', 'skim_file', 'read_output', 'find_symbol', 'document_symbols']);
    const navigation = new Set(['search_text', 'list_files', 'find_references', 'go_to_definition', 'go_to_implementation', 'incoming_calls', 'outgoing_calls', 'hover', 'inspect_file_context', 'memory_recall']);
    const semantic = new Set(['semantic_search']);
    const web = new Set(['web_fetch', 'web_search']);
    const external = /\b(?:web|internet|online|documentation|docs|official|latest|current|api reference|changelog)\b/i.test(question);
    const allowed = new Set<string>(core);
    if (turn >= 1) navigation.forEach((name) => allowed.add(name));
    if (turn >= 2 || external) semantic.forEach((name) => allowed.add(name));
    if (external) web.forEach((name) => allowed.add(name));
    return all.filter((tool) => allowed.has(tool.name));
  }

  private registerToolPreflights(executor: ToolDef[]): void {
    this.toolPreflights.clear();
    for (const definition of executor) {
      if (definition.preflight) {
        this.toolPreflights.set(definition.name, definition.preflight);
      }
    }
  }

  private getSemanticIndex(): SemanticIndex | undefined {
    const config = getConfig();
    if (!config.semanticIndex) {
      return undefined;
    }
    if (!this.semanticIndex) {
      const workerPath = path.join(this.context.extensionUri.fsPath, 'dist', 'embedWorker.js');
      const modelRoot = path.join(this.context.extensionUri.fsPath, 'resources', 'models');
      this.embedWorker = new EmbedWorkerClient(workerPath, modelRoot);
      const worker = this.embedWorker;
      this.semanticIndex = new SemanticIndex({
        root: workspaceRoot() ?? process.cwd(),
        storageFile: workspaceStoragePath(
          this.context.globalStorageUri.fsPath,
          workspaceRoot() ?? process.cwd(),
          'semantic-index.json',
        ),
        embed: (texts) => worker.embed(texts),
        maxFiles: config.semanticIndexMaxFiles,
        onProgress: (message) => {
          if (this.streamingMessageId && this.phase !== 'idle') this.setStage(message);
        },
      });
    }
    return this.semanticIndex;
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
    const key = this.providerCacheKey(getConfig());
    if (this.preparedProvider?.key === key) {
      return this.preparedProvider.provider;
    }
    const active = await activeProvider(this.context);
    if (active) {
      this.preparedProvider = { key, provider: active.provider };
      return active.provider;
    }
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    this.connectionError = `No API key for ${preset.label}.`;
    this.post({ type: 'connection', connection: this.buildConnectionState() });
    this.connectionNoticeId = this.addNotice(connectionNotice(preset), 'openSettings').id;
    return undefined;
  }

  /** Resolve the active chat provider once so switches can reuse it immediately. */
  private async primeActiveProvider(): Promise<void> {
    const active = await activeProvider(this.context).catch(() => undefined);
    if (active) {
      this.preparedProvider = { key: this.providerCacheKey(getConfig()), provider: active.provider };
    }
  }

  /** Resolve an optional role without changing the active connection. Empty
   * role settings deliberately fall back to the already-created main provider. */
  private async resolveRoleSelection(
    role: Exclude<ModelRole, 'main'>,
    main: LLMProvider | undefined,
  ): Promise<ActiveProvider | undefined> {
    const config = getConfig();
    const configured = role === 'planner'
      ? Boolean(config.plannerPreset.trim() || config.plannerModel.trim())
      : role === 'editor'
        ? Boolean(config.editorPreset.trim() || config.editorModel.trim())
        : Boolean(config.scanPreset.trim() || config.scanModel.trim() || config.scanAiModel.trim());
    if (!configured) {
      if (!main) return undefined;
      const preset = findPreset(config.preset) ?? PRESETS[0];
      return {
        preset,
        label: preset.label,
        provider: main,
        baseUrl: config.baseUrl,
        model: config.model,
      };
    }
    // An explicitly configured role must not silently fall back to the main
    // model: that would make a provider/key mistake invisible and could send
    // edits to the wrong model. The caller handles the unavailable role as a
    // safe stop.
    return await roleProvider(this.context, role);
  }

  private providerCacheKey(config: DevFirstConfig): string {
    return [config.provider, config.preset, config.model, config.baseUrl].join('|');
  }

  private static readonly WARMUP_MIN_INTERVAL_MS = 4 * 60 * 1000;

  private warmLocalModel(): Promise<void> {
    if (this.disposed || this.warmupInFlight) {
      return this.warmupPromise ?? Promise.resolve();
    }
    if (isActivePhase(this.phase)) {
      return Promise.resolve();
    }
    const config = getConfig();
    if (!config.warmOnFocus) {
      return Promise.resolve();
    }
    const preset = findPreset(config.preset);
    if (!preset || preset.id !== 'ollama') {
      return Promise.resolve();
    }
    const model = config.model.trim();
    if (!model) {
      return Promise.resolve();
    }
    if (Date.now() - this.lastWarmupAt < SessionController.WARMUP_MIN_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.warmupInFlight = true;
    this.warmupPromise = (async () => {
      try {
        const baseUrl = effectiveBaseUrl(preset, config.baseUrl).replace(/\/v1\/?$/i, '');
        await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: 'a',
            stream: false,
            keep_alive: '10m',
            options: { num_predict: 1, num_ctx: this.effectiveContextLimit() },
          }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        // Ollama missing or busy — warming is best-effort.
      } finally {
        this.lastWarmupAt = Date.now();
        this.warmupInFlight = false;
        this.warmupPromise = null;
      }
    })();
    return this.warmupPromise;
  }

  private async settleWarmup(): Promise<void> {
    await this.warmupPromise?.catch(() => undefined);
  }

  private invalidateActiveCaches(): void {
    this.activePlannerToolbox?.resetReadCache();
    this.activeExecutorToolbox?.resetReadCache();
    this.scannerToolbox?.toolbox.resetReadCache();
    clearRepoMapCache();
  }

  private buildToolbox(allowTask = true, dedupResponse: 'marker' | 'full' = 'full'): ToolBox {
    const config = getConfig();
    const tier = this.buildContextProfile().tier;
    const maxReadBytes = tier === 'compact' ? 16 * 1024 : tier === 'standard' ? 32 * 1024 : 50 * 1024;
    const spillPreviewChars = tier === 'compact' ? 8_000 : tier === 'standard' ? 16_000 : 20_000;
    const controller = this;
    class JournalToolBox extends ToolBox {
      async execute(name: string, argsJson: string, context: ToolExecutionContext): Promise<string> {
        controller.recordToolCallContext(name, argsJson);
        const operationId = await controller.beginRunOperation(name, argsJson);
        try {
          const result = await super.execute(name, argsJson, context);
          controller.finishRunOperation(operationId, !result.startsWith('Error:'));
          controller.recordDiagnosticsContext(this.adaptiveVerificationSnapshot());
          if (name === 'memory_save' && !result.startsWith('Error:')) {
            controller.invalidateRulesBase();
          }
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
      codebaseIndex: this.codebaseIndex,
      mcp: this.mcp,
      browser: this.getBrowser(),
      memory: config.memory ? this.memory : undefined,
      backgroundProcesses: this.background,
      ...(allowTask ? { runTask: (request, signal) => this.runTask(request, signal) } : {}),
      approvalMemory: this.approvalMemory,
      externalDirectories: this.externalDirectories,
      maxReadBytes,
      spillPreviewChars,
      recentRunOperations: (filePath) => this.recentRunOperations(filePath),
      contextShunt: {
        summarize: (input) => this.summarizeContextWithWorker(input),
      },
      dedupResponse,
    });
  }

  private async summarizeContextWithWorker(input: ContextShuntInput): Promise<string | undefined> {
    const config = getConfig();
    const scannerConfigured = Boolean(config.scanPreset.trim() || config.scanModel.trim() || config.scanAiModel.trim());
    if (!scannerConfigured) return undefined;
    const worker = await roleProvider(this.context, 'scanner');
    if (!worker || !worker.model || !worker.preset.local) return undefined;
    if (worker.preset.id === config.preset && worker.model === config.model && worker.baseUrl === config.baseUrl) {
      return undefined;
    }
    const key = `${worker.preset.id}|${worker.baseUrl}|${worker.model}|${input.path}|${input.hash}`;
    const cached = this.contextShuntCache.get(key);
    if (cached) return cached;
    const summary = await summarizeWithWorker(worker.provider, worker.model, input);
    if (summary) {
      this.contextShuntCache.set(key, summary);
      if (this.contextShuntCache.size > 64) {
        this.contextShuntCache.delete(this.contextShuntCache.keys().next().value as string);
      }
    }
    return summary;
  }

  private recentRunOperations(filePath: string): string[] {
    const run = this.currentRun;
    if (!run) {
      return [];
    }
    const lines: string[] = [];
    for (let index = run.operations.length - 1; index >= 0 && lines.length < 5; index--) {
      const operation = run.operations[index];
      const targets = new Set<string>();
      if (operation.target) {
        targets.add(operation.target);
      }
      for (const expectation of parseOperationExpectations(operation)) {
        targets.add(expectation.path);
      }
      if (targets.has(filePath)) {
        lines.push(`${operation.tool} — ${operation.status}${operation.finishedAt ? '' : ' (in progress)'}`);
      }
    }
    return lines;
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
    const editSelection = await this.resolveRoleSelection('editor', provider);
    const subagentProvider = editSelection?.provider ?? provider;
    const subagentModel = editSelection?.model ?? config.model;
    const family = promptFamilyFor(editSelection?.preset.provider ?? config.provider, subagentModel);
    const subagentContext = editSelection
      ? this.modelContextInfo(editSelection.preset.id, subagentModel, editSelection.preset.provider)
      : this.mainModelContext();
    this.subagentDepth += 1;
    try {
      return await runSubagent(request, {
        provider: subagentProvider,
        model: subagentModel,
        toolbox: this.buildToolbox(false),
        tools: subagentTools({
          semanticSearch: Boolean(this.getSemanticIndex()) && subagentContext.profile.tier !== 'compact',
        }),
        rules,
        family,
        signal: signal ?? this.abortController?.signal ?? new AbortController().signal,
        contextLimitTokens: subagentContext.limit,
        contextProfile: subagentContext.profile,
        deterministicContext: subagentContext.local,
      });
    } finally {
      this.subagentDepth -= 1;
    }
  }

  private async requestExternalAccess(directory: string): Promise<boolean> {
    const decision = await this.requestApproval(`Access files outside the workspace: ${directory}`, directory);
    return decision !== 'deny';
  }

  private executePlannerToolOn(
    toolbox: ToolBox,
    call: ToolCall,
    contextPressure?: () => { usedTokens: number; limitTokens: number },
  ): Promise<string> {
    return toolbox.execute(call.name, call.arguments, {
      requestTerminalApproval: () => Promise.resolve('deny' as TerminalApprovalDecision),
      requestExternalDirectoryApproval: () => Promise.resolve(false),
      askUser: (request) => this.requestUserAnswer(request),
      signal: this.abortController?.signal,
      planning: true,
      contextPressure: contextPressure ?? (() => ({
        usedTokens: this.contextTokens,
        limitTokens: this.effectiveContextLimit(),
      })),
    });
  }

  private executePlannerTool(
    call: ToolCall,
    contextPressure?: () => { usedTokens: number; limitTokens: number },
  ): Promise<string> {
    return this.executePlannerToolOn(this.buildToolbox(false), call, contextPressure);
  }

  private async answerQuestionDirectly(
    provider: LLMProvider,
    text: string,
    submittedMessage: UiMessage,
    images: string[],
    selection?: SelectionContext,
    quote?: string,
    resume?: LastAnswerState,
    answerCoverage?: string[],
  ): Promise<{ answered: boolean; notice?: string }> {
    const question = resume?.question ?? text;
    const coverageItems = [...new Set((resume?.coverageItems ?? answerCoverage ?? [])
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .filter(Boolean))].slice(0, 6).map((item) => item.slice(0, 160));
    const answerContext = this.mainModelContext();
    this.lastRequest = question;
    this.setPhase('answering');
    const controller = new AbortController();
    const previousController = this.abortController;
    this.abortController = controller;
    if (!resume) {
      let userText = text;
      if (selection) userText += formatSelectionAttachment(selection);
      const editor = this.editorContext();
      if (editor) userText += editor;
      this.appendUserConversation(submittedMessage, userText, images);
    }
    this.setStage(resume
      ? 'ANSWER — continuing…'
      : coverageItems.length
        ? `ANSWER — covering ${coverageItems.length} requested points…`
        : 'ANSWER — locating relevant files…');
    const root = workspaceRoot() ?? process.cwd();
    const taskEvidence = buildTaskEvidencePack(this.context.globalState, question, 3000, root);
    const evidenceLimit = answerContext.profile.tier === 'compact' ? 4 : answerContext.profile.tier === 'large' ? 8 : 6;
    const [codebaseEvidence, bootstrap] = await Promise.all([
      this.codebaseEvidenceForRequest(question, evidenceLimit),
      projectBootstrap(root),
    ]);
    const requestConversation: ChatMessage[] = resume
      ? [{ role: 'user', content: question }]
      : this.conversation;
    const request = composePlannerRequest({
      conversation: requestConversation,
      contextIndex: resume ? [] : this.contextIndex,
      archived: resume ? [] : this.archivedConversation,
      archivedContextIndex: resume ? [] : this.archivedContextIndex,
      budget: relevanceBudget(answerContext.profile.tier),
      evidence: taskEvidence,
      bootstrap,
      pinned: this.buildQuestionPinnedContext(question),
    });
    if (codebaseEvidence) {
      request.messages.push({ role: 'system', content: codebaseEvidence });
    }
    const allQuestionTools = await this.buildQuestionToolRegistry();
    const readOnlyNames = new Set(allQuestionTools.map((tool) => tool.name));
    const questionToolbox = this.buildToolbox(false, 'marker');
    this.activePlannerToolbox = questionToolbox;
    const placeholderId = this.streamingMessageId;
    let resumeText = resume?.text ?? '';
    if (resume) {
      const existing = this.uiMessages.find(
        (message) => message.id === resume!.messageId && message.role === 'assistant',
      );
      if (existing) {
        if (placeholderId && placeholderId !== existing.id) {
          const placeholder = this.uiMessages.find((message) => message.id === placeholderId);
          if (placeholder && !placeholder.text.trim()) {
            this.uiMessages = this.uiMessages.filter((message) => message.id !== placeholderId);
            this.post({ type: 'removeMessage', id: placeholderId });
          }
        }
        resumeText = existing.text || resume.text;
        this.streamingMessageId = existing.id;
        existing.streaming = true;
        existing.interrupted = false;
        existing.stage = 'ANSWER — continuing…';
        this.post({ type: 'addMessage', message: existing });
      } else {
        resume = undefined;
      }
    }
    if (!resume) {
      this.ensureStreamingMessage();
    }
    const streamingId = this.streamingMessageId ?? '';
    this.beginAnswerWatchdog(controller);
    this.setContinuation('answer', streamingId || `answer:${Date.now()}`, 'active');
    this.lastAnswer = {
      messageId: streamingId,
      question,
      text: resumeText,
      examinedFiles: [...(resume?.examinedFiles ?? [])],
      ...(coverageItems.length ? { coverageItems } : {}),
      status: 'truncated',
      updatedAt: Date.now(),
    };
    const examinedFiles = new Set(resume?.examinedFiles ?? []);
    const rememberFile = (call: ToolCall): void => {
      try {
        const args = JSON.parse(call.arguments) as Record<string, unknown>;
        const path = typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : undefined;
        if (path && path !== '.' && path !== './') examinedFiles.add(path);
      } catch {
        // Tool arguments may be partial while streaming; only the final calls matter.
      }
    };
    const finish = (result: string, truncated: boolean): { answered: boolean; notice?: string } => {
      const trimmed = result.trim();
      const files = [...examinedFiles];
      if (trimmed) {
        this.upsertAssistantConversation(streamingId || undefined, trimmed);
        this.lastAnswer = {
          messageId: streamingId,
          question,
          text: trimmed,
          examinedFiles: files,
          ...(coverageItems.length ? { coverageItems } : {}),
          status: truncated ? 'truncated' : 'complete',
          updatedAt: Date.now(),
        };
        this.setContinuation('answer', streamingId || `answer:${Date.now()}`, truncated ? 'truncated' : 'complete');
        this.endStreaming();
        this.endAnswerWatchdog();
        this.setPhase('idle');
        return { answered: true };
      }
      this.lastAnswer = {
        messageId: streamingId,
        question,
        text: '',
        examinedFiles: files,
        ...(coverageItems.length ? { coverageItems } : {}),
        status: 'truncated',
        updatedAt: Date.now(),
      };
      this.setContinuation('answer', streamingId || `answer:${Date.now()}`, 'truncated');
      this.endStreaming();
      this.endAnswerWatchdog();
      this.setPhase('idle');
      const preview = files.slice(0, 5);
      const evidence = preview.length > 0
        ? ` Files read: ${preview.join(', ')}${files.length > preview.length ? ` and ${files.length - preview.length} more` : ''}.`
        : '';
      return {
        answered: false,
        notice: `The model did not produce a final answer.${evidence} Try naming a specific file, symbol, or topic.`,
      };
    };
    try {
      const baseMessages: ChatMessage[] = [
        { role: 'system', content: answerSystemPrompt(coverageItems) },
        ...request.messages,
      ];
      const messages: ChatMessage[] = [...baseMessages];
      const seededResume = Boolean(resume && resumeText.trim());
      if (seededResume) {
        messages.push({
          role: 'assistant',
          content: this.compactAnswerForContinuation(resumeText, answerContext.limit, baseMessages),
        });
        messages.push({ role: 'user', content: CONTINUE_ANSWER_PROMPT });
      }
      const continuationBase = (): ChatMessage[] => seededResume
        ? [...baseMessages, ...messages.slice(baseMessages.length + 2)]
        : messages;
      let answer = resumeText;
      const seenEvidence = new Set<string>();
      let lastToolBatchSignature = '';
      let repeatedToolBatchCount = 0;
      let forceFinal = false;
      let roundsWithoutNewEvidence = 0;
      for (let turn = 0; ; turn++) {
        this.setStage(turn === 0 ? 'ANSWER — waiting for response…' : 'ANSWER — processing read results…');
        const turnTools = this.questionToolsForTurn(allQuestionTools, question, turn);
        const turnResult = await this.streamAnswerTurn(
          provider,
          messages,
          {
            tools: turnTools,
            signal: controller.signal,
            reasoning: this.answerReasoningOptions(turn),
            contextLimit: answerContext.limit,
          },
          (delta) => { this.touchAnswerWatchdog(); this.appendStreamingText(delta); },
          (delta) => { this.touchAnswerWatchdog(); this.appendStreamingReasoning(delta); },
        );
        answer += turnResult.text;
        if (turnResult.loopDetected) {
          return finish(answer, true);
        }
        const calls = turnResult.calls.filter((call) => readOnlyNames.has(call.name));
        if (calls.length === 0) {
          let truncated = turnResult.stopReason === 'length' || turnResult.stopReason === 'content-filter';
          if (turnResult.stopReason === 'length') {
            const continued = await this.continueAnswerText(
              provider,
              continuationBase(),
              answer,
              controller.signal,
              answerContext.limit,
              (delta) => { this.touchAnswerWatchdog(); this.appendStreamingText(delta); },
              this.answerReasoningOptions(turn),
              (delta) => { this.touchAnswerWatchdog(); this.appendStreamingReasoning(delta); },
            );
            answer = continued.text;
            truncated = continued.truncated;
          }
          return finish(answer, truncated);
        }
        calls.forEach(rememberFile);
        messages.push({
          role: 'assistant',
          content: turnResult.text,
          toolCalls: calls,
          ...(turnResult.reasoning ? { reasoning: turnResult.reasoning } : {}),
        });
        const readOne = async (call: ToolCall): Promise<string> => {
          this.touchAnswerWatchdog();
          this.setStage(`ANSWER — reading ${call.name}…`);
          const label = describeToolCall(call);
          const icon = toolIcon(call.name);
          const startedAt = Date.now();
          this.upsertActivity(call.id, label, 'running', icon);
          this.eventLedger.append('tool', { tool: call.name, status: 'started', callId: call.id, label });
          try {
            const result = await this.executePlannerToolOn(questionToolbox, call, () => ({
              usedTokens: estimateTokens(messages),
              limitTokens: answerContext.limit,
            }));
            this.touchAnswerWatchdog();
            const durationMs = Date.now() - startedAt;
            const failed = /^Error:/i.test(result.trim());
            this.upsertActivity(call.id, label, failed ? 'error' : 'done', icon, { ...activityMeta(call, result), durationMs });
            this.eventLedger.append('tool', {
              tool: call.name,
              status: failed ? 'failed' : 'succeeded',
              callId: call.id,
              label,
              durationMs,
            });
            return result;
          } catch (error) {
            const durationMs = Date.now() - startedAt;
            const result = `Error: ${errorMessage(error)}`;
            this.upsertActivity(call.id, label, 'error', icon, { ...activityMeta(call, result), durationMs });
            this.eventLedger.append('tool', { tool: call.name, status: 'failed', callId: call.id, label, durationMs, error: errorMessage(error) });
            return result;
          }
        };
        const questionResults = new Map<string, string>();
        const concurrentCalls = calls.filter((call) => PARALLEL_SAFE.has(call.name));
        const sequentialCalls = calls.filter((call) => !PARALLEL_SAFE.has(call.name));
        const concurrentResults = await Promise.all(concurrentCalls.map((call) => readOne(call)));
        concurrentCalls.forEach((call, index) => questionResults.set(call.id, concurrentResults[index]));
        for (const call of sequentialCalls) {
          questionResults.set(call.id, await readOne(call));
        }
        for (const call of calls) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: questionResults.get(call.id) ?? 'Error: tool did not return a result.',
          });
        }
        const signature = calls.map((call) => `${call.name}:${call.arguments}`).join('|');
        if (signature === lastToolBatchSignature) {
          repeatedToolBatchCount += 1;
        } else {
          lastToolBatchSignature = signature;
          repeatedToolBatchCount = 1;
        }
        let foundNovelEvidence = false;
        for (const call of calls) {
          const result = questionResults.get(call.id) ?? '';
          if (!result.trim()) continue;
          const fingerprint = `${call.name}:${answerEvidenceFingerprint(result)}`;
          if (!seenEvidence.has(fingerprint)) {
            seenEvidence.add(fingerprint);
            foundNovelEvidence = true;
          }
        }
        roundsWithoutNewEvidence = foundNovelEvidence ? 0 : roundsWithoutNewEvidence + 1;
        if (repeatedToolBatchCount >= 3 || roundsWithoutNewEvidence >= 3) {
          forceFinal = true;
          break;
        }
      }
      if (forceFinal) {
        this.setStage('ANSWER — preparing final answer…');
        messages.push({
          role: 'user',
          content: 'Tool use is complete. Answer the developer\'s original question now, directly and completely. Do not call any tools. Use only the evidence already gathered above. If a requested detail is absent, write NOT_FOUND instead of guessing. Preserve any required response format.',
        });
        const finalTurn = await this.streamAnswerTurn(
          provider,
          messages,
          {
            signal: controller.signal,
            reasoning: this.answerReasoningOptions(0),
            contextLimit: answerContext.limit,
          },
          (delta) => { this.touchAnswerWatchdog(); this.appendStreamingText(delta); },
          (delta) => { this.touchAnswerWatchdog(); this.appendStreamingReasoning(delta); },
        );
        answer += finalTurn.text;
        if (finalTurn.loopDetected) {
          return finish(answer, true);
        }
        let truncated = finalTurn.stopReason === 'length' || finalTurn.stopReason === 'content-filter';
        if (finalTurn.stopReason === 'length') {
          const continued = await this.continueAnswerText(
            provider,
            continuationBase(),
            answer,
            controller.signal,
            answerContext.limit,
            (delta) => { this.touchAnswerWatchdog(); this.appendStreamingText(delta); },
            this.answerReasoningOptions(0),
            (delta) => { this.touchAnswerWatchdog(); this.appendStreamingReasoning(delta); },
          );
          answer = continued.text;
          truncated = continued.truncated;
        }
        return finish(answer, truncated);
      }
      return finish(answer, false);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        this.addError(`Question failed: ${errorMessage(error)}`);
      }
      this.markStreamingInterrupted();
      this.endStreaming();
      return { answered: false };
    } finally {
      this.endAnswerWatchdog();
      if (this.phase === 'answering') {
        this.setPhase('idle');
      }
      this.abortController = previousController;
      if (this.activePlannerToolbox === questionToolbox) {
        this.activePlannerToolbox = undefined;
      }
      if (this.phase === 'idle') {
        this.processNextQueued();
      }
    }
  }

  private buildSessionMemoryCard(): SessionMemoryCard {
    const completed = this.currentRun?.completedSteps ?? this.taskState.completedSteps;
    const next = this.taskState.nextSteps;
    const steps = this.plan?.steps ?? [];
    const answerIsUnfinished = Boolean(
      this.continuation?.kind === 'answer' && this.continuation.status !== 'complete',
    );
    const touched = new Set<string>([
      ...(this.currentRun?.changedFiles ?? []).map((file) => file.path),
      ...(answerIsUnfinished ? this.lastAnswer?.examinedFiles ?? [] : []),
    ]);
    const decisions: string[] = [];
    if (this.plan?.status === 'approved') {
      decisions.push(`Approved plan: ${(this.plan.title ?? 'untitled plan').slice(0, 160)}`);
    }
    if (this.plan?.verification?.length) {
      decisions.push(`Verification: ${this.plan.verification.slice(0, 2).join('; ')}`);
    }
    return {
      goal: (this.taskState.taskSummary || this.lastRequest || this.lastAnswer?.question)?.slice(0, 500),
      decisions: decisions.slice(0, 4),
      touchedFiles: [...touched].filter(Boolean).slice(-16),
      blockers: [...this.taskState.blockers].slice(-4),
      completedStep: completed.length > 0 && steps[completed[completed.length - 1]]
        ? steps[completed[completed.length - 1]].slice(0, 300)
        : undefined,
      nextStep: next.length > 0 && steps[next[0]] ? steps[next[0]].slice(0, 300) : undefined,
      answerTail: answerIsUnfinished && this.lastAnswer?.text
        ? this.lastAnswer.text.slice(-1200)
        : undefined,
      updatedAt: Date.now(),
    };
  }

  private setContinuation(kind: ContinuationKind, targetId: string, status: ContinuationState['status']): void {
    this.continuation = { kind, targetId, status, updatedAt: Date.now() };
    this.sessionMemoryCard = this.buildSessionMemoryCard();
  }

  private resolveContinuationTarget(text: string): ContinuationState | undefined {
    if (!isContinuationMessage(text)) return undefined;
    const taskIsActive = this.phase === 'planning' || this.phase === 'executing'
      || this.taskState.state === 'planning' || this.taskState.state === 'executing';
    const taskIsRecoverable = Boolean(
      this.recoveryRun
      // An approved plan is resumable even when its next-step list is empty:
      // the executor may have been stopped before it could record progress.
      || (this.plan && this.plan.status === 'approved')
      || (this.continuation?.kind === 'task' && ['active', 'paused', 'interrupted'].includes(this.continuation.status)),
    );
    if (taskIsActive || taskIsRecoverable) {
      return {
        kind: 'task',
        targetId: this.taskState.taskId || this.recoveryRun?.id || 'current-task',
        status: taskIsActive ? 'active' : 'paused',
        updatedAt: Date.now(),
      };
    }
    // The current "continue" message is already in the transcript. The answer
    // being continued must be the assistant turn immediately before it, not a
    // stale answer from an earlier request.
    let latestUserIndex = -1;
    for (let index = this.uiMessages.length - 1; index >= 0; index--) {
      if (this.uiMessages[index].role === 'user') {
        latestUserIndex = index;
        break;
      }
    }
    const assistantPool = latestUserIndex >= 0
      ? this.uiMessages.slice(0, latestUserIndex)
      : this.uiMessages;
    const latestAssistant = [...assistantPool]
      .reverse()
      .find((message) => message.role === 'assistant' && message.id !== this.streamingMessageId);
    // Never resume a message that has been removed or replaced by an edit.
    const lastAnswerMessage = this.lastAnswer
      ? this.uiMessages.find((message) => message.id === this.lastAnswer!.messageId && message.role === 'assistant')
      : undefined;
    const continuationMessage = this.continuation?.kind === 'answer'
      ? this.uiMessages.find((message) => message.id === this.continuation!.targetId && message.role === 'assistant')
      : undefined;
    const continuationIsLatest = Boolean(continuationMessage && latestAssistant?.id === continuationMessage.id);
    const lastAnswerIsLatest = Boolean(lastAnswerMessage && latestAssistant?.id === lastAnswerMessage.id);
    const continuationIsNewer = Boolean(
      continuationMessage
      && (!this.lastAnswer || this.continuation!.updatedAt >= this.lastAnswer.updatedAt),
    );
    if (continuationIsLatest && continuationIsNewer) {
      return {
        kind: 'answer',
        targetId: continuationMessage!.id,
        status: this.continuation!.status,
        updatedAt: this.continuation!.updatedAt,
      };
    }
    if (lastAnswerIsLatest && this.lastAnswer) {
      return {
        kind: 'answer',
        targetId: lastAnswerMessage!.id,
        status: this.lastAnswer.status,
        updatedAt: this.lastAnswer.updatedAt,
      };
    }
    // The persisted continuation pointer can outlive the answer record after a
    // restart. Recover the unfinished answer from the message it points to.
    if (continuationIsLatest && this.continuation?.kind === 'answer') {
      return {
        kind: 'answer',
        targetId: continuationMessage!.id,
        status: this.continuation.status,
        updatedAt: this.continuation.updatedAt,
      };
    }
    if (this.plan?.status === 'draft') {
      return { kind: 'plan', targetId: `plan:${this.plan.version}`, status: 'paused', updatedAt: Date.now() };
    }
    return undefined;
  }

  private shouldResumeLastAnswer(text: string): boolean {
    const target = this.resolveContinuationTarget(text);
    return target?.kind === 'answer' && (this.phase === 'idle' || this.phase === 'review');
  }

  private answerStateForContinuation(target: ContinuationState): LastAnswerState | undefined {
    if (target.kind !== 'answer') {
      return undefined;
    }
    if (this.lastAnswer?.messageId === target.targetId) {
      return this.lastAnswer;
    }
    const message = this.uiMessages.find(
      (candidate) => candidate.id === target.targetId && candidate.role === 'assistant',
    );
    if (!message) {
      return undefined;
    }
    const lastUser = [...this.conversation].reverse().find((candidate) => candidate.role === 'user');
    return {
      messageId: message.id,
      question: this.lastAnswer?.question ?? this.lastRequest ?? lastUser?.content ?? '',
      text: message.text,
      examinedFiles: [],
      status: target.status === 'complete' ? 'complete' : 'truncated',
      updatedAt: target.updatedAt,
    };
  }

  private answerReasoningOptions(turn: number): ReasoningOptions | undefined {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    const modelId = config.model;
    const supported = this.profileSupportsReasoning();
    return this.executionReasoningOptions(supported, preset.id, {
      phase: 'execution',
      turn,
      previousToolNames: [],
      previousToolFailed: false,
    }, modelId);
  }

  private async streamAnswerTurn(
    provider: LLMProvider,
    messages: ChatMessage[],
    options: {
      tools?: ToolDef[];
      signal: AbortSignal;
      reasoning?: ReasoningOptions;
      contextLimit?: number;
    },
    onText: (delta: string) => void,
    onReasoning?: (delta: string) => void,
  ): Promise<{ text: string; reasoning: string; calls: ToolCall[]; stopReason?: StreamStopReason; loopDetected?: boolean }> {
    const toolSchemaTokens = options.tools?.length
      ? Math.ceil(JSON.stringify(options.tools).length / 4)
      : 0;
    const contextLimit = options.contextLimit ?? this.effectiveContextLimit();
    let retainedText = '';
    let retainedReasoning = '';
    let requestMessages = messages;
    // Start the header with a deterministic estimate so it is useful even
    // when a local provider does not return a usage event.
    this.lastExactUsage = undefined;
    this.reportUsage(estimateTokens(messages) + toolSchemaTokens);
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = '';
      let reasoning = '';
      const calls: ToolCall[] = [];
      let stopReason: StreamStopReason | undefined;
      let loopDetected = false;
      const loopGuard = new StreamLoopGuard();
      const turnAbort = createChildAbortController(options.signal);
      try {
        for await (const event of chatWithRetry(provider, requestMessages, {
          model: getConfig().model,
          ...(options.tools?.length ? { tools: options.tools } : {}),
          temperature: 0.2,
          ...(options.reasoning ? { reasoning: options.reasoning } : {}),
          // Respect the model/Modelfile-derived context window. No output cap is
          // sent: generation ends only at the model's natural stop or its context.
          contextTokens: contextLimit,
          signal: turnAbort.controller.signal,
        }, { attempts: 1, retryOnEmpty: false })) {
          if (event.type === 'text') {
            const detection = loopGuard.observe('text', event.text);
            text += event.text;
            onText(event.text);
            if (detection) {
              text = text.slice(0, Math.max(0, text.length - detection.repeatedChars));
              this.rewindStreamingText(detection.repeatedChars);
              loopDetected = true;
              turnAbort.controller.abort();
              break;
            }
          } else if (event.type === 'reasoning') {
            const detection = loopGuard.observe('reasoning', event.text);
            reasoning += event.text;
            onReasoning?.(event.text);
            if (detection) {
              reasoning = reasoning.slice(0, Math.max(0, reasoning.length - detection.repeatedChars));
              this.rewindStreamingReasoning(detection.repeatedChars);
              loopDetected = true;
              turnAbort.controller.abort();
              break;
            }
          } else if (event.type === 'toolCall') {
            calls.push(event.toolCall);
          } else if (event.type === 'usage') {
            this.reportExactUsage({
              input: event.inputTokens ?? 0,
              output: event.outputTokens ?? 0,
              reasoning: event.reasoningTokens ?? 0,
              cached: event.cachedTokens ?? 0,
            });
          } else if (event.type === 'done') {
            stopReason = event.reason;
          }
        }
      } catch (error) {
        if (!loopDetected) throw error;
      } finally {
        turnAbort.dispose();
      }

      retainedText += text;
      if (!loopDetected) {
        retainedReasoning += reasoning;
        return { text: retainedText, reasoning: retainedReasoning, calls, stopReason };
      }
      if (attempt === 1) {
        this.addNotice('Stopped after repeated streamed output returned following one recovery attempt. The distinct response text is preserved.');
        return { text: retainedText, reasoning: retainedReasoning, calls: [], stopReason: 'stop', loopDetected: true };
      }

      if (text.trim()) requestMessages = [...requestMessages, { role: 'assistant', content: text.trim() }];
      requestMessages = [...requestMessages, { role: 'user', content: streamLoopRecoveryPrompt() }];
      this.addNotice('Detected repeated streamed output and stopped that turn. Trying one recovery turn.');
    }
    return { text: retainedText, reasoning: retainedReasoning, calls: [], loopDetected: true };
  }


  private async collectTextWithContinuation(
    provider: LLMProvider,
    messages: ChatMessage[],
    options: ChatOptions,
    retry: RetryOptions = {},
    onText?: (delta: string) => void,
  ): Promise<string> {
    const base = messages;
    let text = '';
    let stopReason: StreamStopReason | undefined;
    let stagnant = 0;
    let loopRecoveryUsed = false;
    for (;;) {
      let turnText = '';
      let turnLoopDetected = false;
      const loopGuard = new StreamLoopGuard();
      const turnAbort = options.signal ? createChildAbortController(options.signal) : undefined;
      const turnOptions = turnAbort ? { ...options, signal: turnAbort.controller.signal } : options;
      // A missing done event in a later turn must not inherit the previous
      // turn's "length" status, which would loop forever.
      stopReason = undefined;
      try {
        for await (const event of chatWithRetry(provider, messages, turnOptions, retry)) {
          if (event.type === 'text') {
            const detection = loopGuard.observe('text', event.text);
            turnText += event.text;
            text += event.text;
            onText?.(event.text);
            if (detection) {
              turnText = turnText.slice(0, Math.max(0, turnText.length - detection.repeatedChars));
              text = text.slice(0, Math.max(0, text.length - detection.repeatedChars));
              turnLoopDetected = true;
              turnAbort?.controller.abort();
              break;
            }
          } else if (event.type === 'done') {
            stopReason = event.reason;
          }
        }
      } catch (error) {
        if (!turnLoopDetected) throw error;
      } finally {
        turnAbort?.dispose();
      }
      if (turnLoopDetected) {
        if (loopRecoveryUsed) {
          this.addNotice('Stopped after repeated output returned following one recovery attempt.');
          return `${text.trim()}\n\n[Stopped because repeated output continued after one recovery attempt. This response may be incomplete.]`.trim();
        }
        loopRecoveryUsed = true;
        messages = [
          ...messages,
          ...(turnText.trim() ? [{ role: 'assistant' as const, content: turnText.trim() }] : []),
          { role: 'user', content: streamLoopRecoveryPrompt() },
        ];
        this.addNotice('Detected repeated output and stopped that stream. Trying one recovery turn.');
        continue;
      }
      if (stopReason !== 'length') {
        return text;
      }
      if (!turnText.trim()) {
        stagnant += 1;
        if (stagnant >= 2) {
          return text;
        }
      } else {
        stagnant = 0;
      }
      messages = this.answerContinuationMessages(base, text, options.contextTokens ?? this.effectiveContextLimit());
    }
  }

  private async continueAnswerText(
    provider: LLMProvider,
    baseMessages: ChatMessage[],
    answerSoFar: string,
    signal: AbortSignal,
    contextLimit: number,
    onText: (delta: string) => void,
    reasoning?: ReasoningOptions,
    onReasoning?: (delta: string) => void,
  ): Promise<{ text: string; truncated: boolean }> {
    let text = answerSoFar;
    let stagnant = 0;
    for (;;) {
      const messages = this.answerContinuationMessages(baseMessages, text, contextLimit);
      const turn = await this.streamAnswerTurn(
        provider,
        messages,
        { signal, reasoning, contextLimit },
        onText,
        onReasoning,
      );
      text += turn.text;
      if (turn.loopDetected) {
        return { text, truncated: true };
      }
      if (turn.stopReason !== 'length') {
        return { text, truncated: turn.stopReason === 'content-filter' };
      }
      if (!turn.text.trim()) {
        stagnant += 1;
        if (stagnant >= 2) {
          return { text, truncated: true };
        }
      } else {
        stagnant = 0;
      }
    }
  }

  private answerContinuationMessages(
    base: ChatMessage[],
    answerSoFar: string,
    contextLimit: number,
  ): ChatMessage[] {
    return [
      ...base,
      {
        role: 'assistant',
        content: this.compactAnswerForContinuation(answerSoFar, contextLimit, base),
      },
      { role: 'user', content: CONTINUE_ANSWER_PROMPT },
    ];
  }

  private compactAnswerForContinuation(answer: string, limitTokens: number, base: ChatMessage[]): string {
    const effectiveLimit = limitTokens > 0 ? limitTokens : this.effectiveContextLimit();
    // Match the shared request guard: leave room for the model's next chunk.
    const budget = Math.max(256, Math.floor(effectiveLimit * 0.72));
    const continuationPromptTokens = estimateTokens([{ role: 'user', content: CONTINUE_ANSWER_PROMPT }]);
    const baseTokens = estimateTokens(base);
    const available = Math.max(
      96,
      budget - baseTokens - continuationPromptTokens - 64,
    );
    const seedTokens = (seed: string): number =>
      estimateTokens([{ role: 'assistant', content: seed }]);
    if (seedTokens(answer) <= available) {
      return answer;
    }

    const outline = this.answerOutline(answer);
    let tailChars = Math.max(256, Math.min(8000, available * 3));
    let headChars = Math.max(96, Math.min(1600, available));
    let seed = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      seed = [
        '[The answer is longer than the remaining context. Continue it without repeating anything.]',
        'Sections already written:',
        outline || '(no headings)',
        'Opening:',
        answer.slice(0, headChars),
        '...',
        'Most recent text (continue immediately after this):',
        answer.slice(-tailChars),
      ].join('\n');
      if (seedTokens(seed) <= available) {
        return seed;
      }
      tailChars = Math.max(128, Math.floor(tailChars * 0.6));
      headChars = Math.max(64, Math.floor(headChars * 0.6));
    }

    // Last resort: keep only the newest text, which is what the continuation
    // must follow, and stay strictly inside the available budget.
    const fallbackChars = Math.max(96, Math.min(1200, available * 2));
    return `[Continue the answer from the end of this text without repeating.]\n${answer.slice(-fallbackChars)}`;
  }

  private answerOutline(answer: string): string {
    const lines = answer.split('\n').filter((line) =>
      /^\s{0,3}#{1,6}\s+/.test(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line),
    );
    return [...new Set(lines)].slice(-80).join('\n');
  }

  private upsertAssistantConversation(id: string | undefined, content: string): void {
    const text = stripInternalContext(content);
    if (id) {
      const index = this.conversation.findIndex(
        (message) => message.id === id && message.role === 'assistant',
      );
      if (index >= 0) {
        const message: ChatMessage = { ...this.conversation[index], content: text };
        this.conversation[index] = message;
        this.contextIndex[index] = buildContextEntry(message, index);
        this.plannerConversationCache = null;
        return;
      }
    }
    this.appendConversation({ ...(id ? { id } : {}), role: 'assistant', content: text });
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
    if (isActivePhase(this.phase)) {
      this.addNotice('Wait for the current task to finish before asking for an explanation.');
      return;
    }
    await this.handleSend(`Explain the pending changes to ${filePath}: what changed and why.`);
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    const status = phase === 'planning'
      ? 'planning'
      : phase === 'executing'
        ? 'executing'
        : this.plan?.status === 'draft'
          ? 'ready'
          : 'idle';
    this.planningState = {
      status,
      ...(this.plan?.planningMode ? { mode: this.plan.planningMode } : {}),
      planVersion: this.plan?.version ?? this.planVersion,
      ...(this.lastUserMessageId ? { requestId: this.lastUserMessageId } : {}),
      updatedAt: Date.now(),
    };
    const state: TaskStateStatus = phase === 'planning'
      ? 'planning'
      : phase === 'executing'
        ? 'executing'
        : this.plan?.status === 'draft'
          ? 'awaiting_approval'
          : this.taskState.state === 'stalled'
            ? 'stalled'
            : this.taskState.state === 'completed'
              ? 'completed'
            : 'idle';
    this.taskState = {
      ...this.taskState,
      state,
      approvedPlan: this.plan
        ? { version: this.plan.version, title: this.plan.title ?? 'Plan', steps: this.plan.steps ?? [] }
        : this.taskState.approvedPlan,
      completedSteps: this.currentRun?.completedSteps ?? this.taskState.completedSteps,
      nextSteps: this.plan?.steps?.map((_, index) => index)
        .filter((index) => !(this.currentRun?.completedSteps ?? []).includes(index))
        ?? this.taskState.nextSteps,
      lastHeartbeatAt: Date.now(),
    };
    this.eventLedger.setTask(this.taskState.taskId);
    this.eventLedger.append('state', {
      state: this.taskState.state,
      completedSteps: this.taskState.completedSteps,
      nextSteps: this.taskState.nextSteps,
      blockers: this.taskState.blockers,
    });
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
    const requestId = ++this.enhanceRequestId;
    this.enhanceAbort?.abort();
    const controller = new AbortController();
    this.enhanceAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const provider = await this.buildProvider();
    try {
      if (requestId !== this.enhanceRequestId) {
        return;
      }
      if (!provider) {
        this.post({
          type: 'enhancedPrompt',
          text: trimmed,
          error: 'No chat provider is connected. Connect a model, then try again.',
        });
        return;
      }
      let enhanced = '';
      for await (const event of chatWithRetry(
        provider,
        [
          {
            role: 'system',
            content:
              'Rewrite the developer request as a clear, specific instruction for a coding agent. Keep the original meaning and intent. Output ONLY the rewritten request, no preamble, no quotes.',
          },
          { role: 'user', content: trimmed },
        ],
        {
          model: getConfig().model,
          maxTokens: 512,
          temperature: 0.3,
          signal: controller.signal,
          contextTokens: this.effectiveContextLimit(),
        },
        { attempts: 1, retryOnEmpty: false },
      )) {
        if (event.type === 'text') {
          enhanced += event.text;
        }
      }
      if (requestId !== this.enhanceRequestId) {
        return;
      }
      const result = enhanced.trim();
      if (result) {
        this.post({ type: 'enhancedPrompt', text: result });
      } else {
        this.post({
          type: 'enhancedPrompt',
          text: trimmed,
          error: 'The model returned no rewritten prompt. Your original prompt is unchanged.',
        });
      }
    } catch (error) {
      if (requestId !== this.enhanceRequestId) {
        return;
      }
      this.post({
        type: 'enhancedPrompt',
        text: trimmed,
        error: controller.signal.aborted
          ? 'Prompt enhancement timed out. Your original prompt is unchanged.'
          : `Prompt enhancement failed: ${errorMessage(error)}`,
      });
    } finally {
      clearTimeout(timeout);
      if (this.enhanceAbort === controller) {
        this.enhanceAbort = undefined;
      }
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
    const contextWindow = live?.contextWindow ?? catalog?.contextWindow ?? registry?.contextWindow;
    return {
      id: modelId,
      ...(live?.name ? { name: live.name } : {}),
      ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
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
    if (value === 'auto') {
      await this.applySetting('plannerThinking', 'auto');
      return;
    }
    if (!levels.includes(value)) return;
    const key = `devFirst.reasoning.${encodeURIComponent(presetId)}.${encodeURIComponent(modelId)}`;
    await this.context.globalState.update(key, value);
    await this.applySetting('plannerThinking', value === 'off' ? 'off' : 'on');
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
    const completed = new Set(this.currentRun?.completedSteps ?? []);
    const guarded = todos.map((todo) => {
      const planIndex = this.plan?.steps?.findIndex((step) => step.trim() === todo.text.trim()) ?? -1;
      if (planIndex >= 0 && completed.has(planIndex) && todo.status !== 'cancelled') {
        return { ...todo, status: 'done' as const };
      }
      return todo;
    });
    this.todos = mergeTodoCheckpoints(previous, guarded);
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
      this.completedRunBoundary = true;
      plan.status = 'completed';
      this.taskState = {
        ...this.taskState,
        state: 'completed',
        completedSteps: this.currentRun?.completedSteps ?? this.taskState.completedSteps,
        nextSteps: [],
        blockers: [],
        lastHeartbeatAt: Date.now(),
      };
      this.setContinuation('task', this.taskState.taskId, 'complete');
      this.eventLedger.setTask(this.taskState.taskId);
      this.eventLedger.append('state', {
        state: this.taskState.state,
        completedSteps: this.taskState.completedSteps,
        nextSteps: this.taskState.nextSteps,
        blockers: this.taskState.blockers,
      });
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
    this.setContinuation('plan', `plan:${this.plan.version}`, 'paused');
    this.recordContextMetadata(planContextMetadata(parsed));
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
    this.recordContextMetadata({ planStepIds: [String(index)] });
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
    if (isActivePhase(this.phase)) {
      this.addNotice('Wait for the current task to finish before asking for an explanation.');
      return;
    }
    await this.handleSend(`Explain the ${key.toUpperCase()} section of the current plan in more depth.`);
  }

  private addUserMessage(
    text: string,
    attachment?: MessageAttachment,
    quote?: string,
    images?: string[],
  ): UiMessage {
    const message: UiMessage = { id: randomId('msg'), role: 'user', text, attachment, quote, images };
    this.lastUserMessageId = message.id;
    if (this.sessionTitle === 'New session' || this.sessionTitle === 'Imported session') {
      this.sessionTitle = text.replace(/\s+/g, ' ').slice(0, 50) || 'New session';
      this.postSessions();
    }
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    this.persist();
    return message;
  }

  private appendUserConversation(message: UiMessage, llmText: string, images?: string[]): void {
    this.appendConversation({ id: message.id, role: 'user', content: llmText, images });
  }

  private addAssistantMessage(text: string): UiMessage {
    const message: UiMessage = { id: randomId('msg'), role: 'assistant', text: stripInternalContext(text) };
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    this.persist();
    return message;
  }

  private appendConversation(message: ChatMessage): SessionContextEntry {
    if (!message.id) {
      message.id = randomId('msg');
    }
    if (message.role === 'assistant') {
      message = { ...message, content: stripInternalContext(message.content) };
    }
    const index = this.conversation.length;
    this.conversation.push(message);
    this.plannerConversationCache = null;
    const entry = buildContextEntry(message, index, this.pendingContextMetadata);
    this.pendingContextMetadata = undefined;
    this.contextIndex.push(entry);
    return entry;
  }

  private recordContextMetadata(update: ContextMetadataUpdate): void {
    const entry = this.contextIndex[this.contextIndex.length - 1];
    if (!entry || entry.index !== this.conversation.length - 1) {
      this.pendingContextMetadata = mergeMetadataUpdates(this.pendingContextMetadata, update);
      return;
    }
    mergeContextMetadata(entry, update);
    this.plannerConversationCache = null;
  }

  private recordToolCallContext(name: string, argsJson: string): void {
    this.recordContextMetadata(toolContextMetadata(name, argsJson));
  }

  private recordDiagnosticsContext(snapshot: { diagnosticsAvailable: boolean; newDiagnosticErrors: number }): void {
    const update = diagnosticsContextMetadata(snapshot);
    if (snapshot.diagnosticsAvailable) {
      this.diagnosticsSummary = snapshot.newDiagnosticErrors === 1 ? '1 error' : `${snapshot.newDiagnosticErrors} errors`;
    }
    if (update.files || update.summary) {
      this.recordContextMetadata(update);
    }
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
    retainTakeaways = false,
  ): void {
    const { text: withoutFailure, failureConcept } = extractFailureConcept(text);
    const { text: body, takeaways } = extractTakeaways(stripInternalContext(withoutFailure));
    if (retainTakeaways && takeaways?.length && getConfig().memory) {
      void (async () => {
        let saved = 0;
        for (const takeaway of takeaways) {
          const result = await this.memory.save(takeaway, 'Run takeaways').catch(() => 'Error:');
          if (result.startsWith('Saved')) saved++;
        }
        if (saved > 0) {
          this.addNotice(`Saved ${saved} takeaway${saved === 1 ? '' : 's'} to project memory.`);
        }
      })();
    }
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
      startedAt: Date.now(),
      activities: [],
    };
    this.streamingMessageId = message.id;
    this.uiMessages.push(message);
    this.post({ type: 'addMessage', message });
    return message;
  }

  private setStage(text: string): void {
    const message = this.ensureStreamingMessage();
    if (message.stage === text) {
      return;
    }
    message.stage = text;
    this.post({ type: 'stage', id: message.id, text });
    this.eventLedger.append('stage', { stage: text });
  }

  private clearStage(message: UiMessage): void {
    if (message.stage === undefined) {
      return;
    }
    message.stage = undefined;
    this.post({ type: 'stage', id: message.id, text: '' });
  }

  private appendStreamingText(delta: string): void {
    const message = this.ensureStreamingMessage();
    this.clearStage(message);
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
      existing.durationMs = meta?.durationMs ?? existing.durationMs;
    } else {
      activities.push({ id, label, status, icon, ...meta });
    }
    this.post({
      type: 'activity',
      messageId: message.id,
      activity: { id, label, status, icon, ...meta },
    });
  }

  private modelContextInfo(presetId: string, modelId: string, providerId: string): ModelContextInfo {
    const config = getConfig();
    const preset = findPreset(presetId) ?? PRESETS[0];
    const metadata = this.selectedModelMetadata(preset.id, modelId, providerId);
    const modelLimit = metadata.contextWindow || config.contextLimitTokens;
    const localCap = safeLocalContextCap(config.localContextCapTokens);
    const limit = preset.local && localCap > 0 ? Math.min(modelLimit, localCap) : modelLimit;
    const catalog = modelInfo(preset.id, modelId);
    const registry = this.registry.lookup(providerId, modelId);
    const catalogMax = catalog?.maxOutput;
    const registryMax = registry?.maxOutput;
    const reserved = catalogMax && catalogMax > 0
      ? catalogMax
      : registryMax && registryMax > 0
        ? registryMax
        : 8192;
    const supportsReasoning = Boolean(catalog?.reasoning) || (registry?.supportsReasoning ?? false);
    const profile = contextProfileFor({
      contextWindow: limit,
      maxOutput: reserved,
      supportsTools: registry?.supportsTools ?? true,
      supportsReasoning,
      override: config.contextProfile,
    });
    return { catalog, registry, limit, reserved, profile, supportsReasoning, local: Boolean(preset.local) };
  }

  private mainModelContext(): ModelContextInfo {
    const config = getConfig();
    const preset = findPreset(config.preset) ?? PRESETS[0];
    return this.modelContextInfo(preset.id, config.model, preset.provider);
  }

  private effectiveContextLimit(): number {
    return this.mainModelContext().limit;
  }

  private plannerStepLimit(_config: DevFirstConfig, _preset: ProviderPreset): number {
    // Planning normally ends when the model submits a ready plan or answers.
    // 0 means unlimited: the planner keeps working until it has a ready plan,
    // answers, or an explicit safety guard (repetition/readiness) stops it.
    return 0;
  }

  private reservedOutputTokens(): number {
    return this.mainModelContext().reserved;
  }

  private profileSupportsReasoning(): boolean {
    return this.mainModelContext().supportsReasoning;
  }

  private buildContextProfile(): ContextProfile {
    return this.mainModelContext().profile;
  }

  private contextProfileInfo(): ContextProfileInfo {
    const profile = this.buildContextProfile();
    return {
      tier: profile.tier,
      triggerRatio: profile.triggerRatio,
      pruneRatio: profile.pruneRatio,
      preserveTokens: profile.preserveTokens,
      reserveRatio: reserveRatioTotal(profile, this.effectiveContextLimit(), this.profileSupportsReasoning()),
    };
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
      profile: this.contextProfileInfo(),
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
      profile: this.contextProfileInfo(),
    });
  }

  private endStreaming(): void {
    if (!this.streamingMessageId) {
      return;
    }
    const message = this.uiMessages.find((candidate) => candidate.id === this.streamingMessageId);
    if (message) {
      this.clearStage(message);
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
        selection: this.runningQueued.selection,
        quote: this.runningQueued.quote,
        images: this.runningQueued.images,
        pastes: this.runningQueued.pastes,
        createdAt: this.runningQueued.createdAt,
      });
    }
    for (const message of this.queuedMessages) {
      records.push({
        id: message.id,
        text: message.text,
        status: 'queued',
        newTask: message.newTask,
        selection: message.selection,
        quote: message.quote,
        images: message.images,
        pastes: message.pastes,
        createdAt: message.createdAt,
      });
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

  private recordRoute(messageId: string, route: TaskRouteEvent['route'], stateBefore: TaskStateStatus): void {
    this.sessionMemoryCard = this.buildSessionMemoryCard();
    this.routeLog = [
      ...this.routeLog,
      {
        messageId,
        route,
        stateBefore,
        stateAfter: this.taskState.state,
        completedStepsCount: this.taskState.completedSteps.length,
        createdAt: Date.now(),
      },
    ].slice(-100);
    this.eventLedger.setTask(this.taskState.taskId);
    this.eventLedger.append('route', {
      messageId,
      route,
      stateBefore,
      stateAfter: this.taskState.state,
      completedStepsCount: this.taskState.completedSteps.length,
    });
    this.eventLedger.append('state', {
      state: this.taskState.state,
      completedSteps: this.taskState.completedSteps,
      nextSteps: this.taskState.nextSteps,
      blockers: this.taskState.blockers,
    });
    void this.persistNow();
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
    if (status === 'completed') {
      this.setContinuation('task', run.id, 'complete');
    } else if (status === 'interrupted' || status === 'stopped' || status === 'failed') {
      this.setContinuation('task', run.id, 'paused');
    }
    if (status === 'interrupted') {
      this.recoveryRun = run;
    } else if (this.recoveryRun?.id === run.id) {
      this.recoveryRun = undefined;
      this.recoveryDrift = false;
    }
    if (status === 'completed' || status === 'stopped' || status === 'failed' || status === 'interrupted') {
      if (status !== 'interrupted') {
        this.recoveredAnswers.delete(run.id);
      }
      this.currentRun = undefined;
    }
  }

  private async beginRunOperation(tool: string, argsJson: string): Promise<string | undefined> {
    const run = this.currentRun;
    if (!run || (run.status !== 'executing' && run.status !== 'waiting')) {
      return undefined;
    }
    const root = workspaceRoot() ?? process.cwd();
    const operation = await buildRunOperation(tool, argsJson, root);
    if (!operation) {
      return undefined;
    }
    run.operations = [...run.operations, operation].slice(-500);
    run.activeTool = tool;
    run.updatedAt = Date.now();
    await this.captureRunTargets(run, tool, argsJson, root);
    this.eventLedger.setTask(this.taskState.taskId);
    this.eventLedger.append('tool', { tool, status: 'started', target: operation.target ?? '' });
    void this.saveRunNow();
    return operation.id;
  }

  private async captureRunTargets(run: RunRecord, tool: string, argsJson: string, root: string): Promise<void> {
    const targets = mutationTargets(tool, argsJson);
    const preflight = this.toolPreflights.get(tool);
    if (preflight) {
      try {
        const parsed = JSON.parse(argsJson) as Record<string, any>;
        if (parsed && typeof parsed === 'object') {
          targets.push(...(await preflight(parsed)));
        }
      } catch {}
    }
    if (targets.length === 0) {
      return;
    }
    let result: SnapshotCaptureResult;
    try {
      result = await this.fileSnapshots.capture(run.id, root, targets);
    } catch {
      return;
    }
    const entries = new Map<string, FileSnapshotEntry>(
      (await this.fileSnapshots.index(run.id)).map((entry) => [entry.path, entry]),
    );
    for (const capturedPath of result.captured) {
      const entry = entries.get(capturedPath);
      run.changedFiles = upsertRunChangedFile(run.changedFiles, {
        path: capturedPath,
        status: entry?.absent ? 'added' : 'modified',
        ...(entry ? { originalHash: entry.hash, captured: true, absent: entry.absent === true } : {}),
      });
    }
    if (result.captured.length > 0) {
      this.recordContextMetadata(mutationContextMetadata(result.captured));
    }
    if (result.skipped.length > 0) {
      const listed = result.skipped.slice(0, 5).join(', ');
      const extra = result.skipped.length > 5 ? ` and ${result.skipped.length - 5} more` : '';
      const reason = result.limited ? 'too large/binary/limit' : 'too large/binary';
      this.addNotice(`Snapshot skipped for ${listed}${extra} (${reason}) — revert may be incomplete.`);
    }
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
    this.eventLedger.append('tool', { tool: operation?.tool ?? 'unknown', status: ok ? 'succeeded' : 'failed', changedFiles: run.changedFiles?.map((file) => file.path) ?? [] });
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
    if (run.reliability) {
      run.reliability = {
        ...run.reliability,
        recovery: { ...run.reliability.recovery, pendingDecisionId: pending.id, resumable: true },
        updatedAt: Date.now(),
      };
    }
    this.recordContextMetadata(decisionContextMetadata(pending));
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
    if (run.reliability) {
      run.reliability = {
        ...run.reliability,
        recovery: { ...run.reliability.recovery, pendingDecisionId: undefined },
        updatedAt: Date.now(),
      };
    }
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
    this.taskState = {
      ...this.taskState,
      taskId: this.taskState.taskId || run.id,
      state: this.taskState.state,
      completedSteps: run.completedSteps,
      nextSteps: (this.plan?.steps ?? []).map((_, index) => index).filter((index) => !run.completedSteps.includes(index)),
      lastHeartbeatAt: Date.now(),
    };
    this.eventLedger.setTask(this.taskState.taskId);
    this.eventLedger.append('state', {
      state: this.taskState.state,
      completedSteps: this.taskState.completedSteps,
      nextSteps: this.taskState.nextSteps,
      blockers: this.taskState.blockers,
    });
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
    await this.fileSnapshots.prune(runs.map((run) => run.id));
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
    await this.fileSnapshots.prune(runs.map((run) => run.id));
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
      await this.restoreSessionContext();
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
    await this.fileSnapshots.remove(id);
    this.recoveredAnswers.delete(id);
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
    if (!run) {
      await this.discardRun(id);
      return;
    }
    this.recoveredAnswers.delete(id);
    run.pending = undefined;
    if (run.checkpointId) {
      await this.revertToCheckpoint(run.checkpointId);
      await this.discardRun(id);
      return;
    }
    const conflicts: RunChangedFile[] = [];
    for (const entry of run.changedFiles ?? []) {
      const outcome = await this.restoreRunFile(run, entry.path, entry, false);
      if (outcome === 'conflict') {
        conflicts.push(entry);
      }
    }
    if (conflicts.length > 0) {
      run.changedFiles = conflicts;
      run.updatedAt = Date.now();
      await this.saveRun(run);
      this.post({
        type: 'runReview',
        runId: run.id,
        files: conflicts.map((file) => ({ path: file.path, status: file.status })),
      });
      this.addNotice(
        `Rolled back the other files — ${conflicts.map((file) => file.path).join(', ')} changed since the run and were skipped.`,
      );
      this.pushState();
      return;
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
    const outcome = await this.restoreRunFile(run, filePath, entry, false);
    if (outcome === 'conflict') {
      this.post({ type: 'runReviewConflict', runId: run.id, path: filePath });
      return;
    }
    if (outcome === 'unavailable') {
      this.addNotice(`Could not restore ${filePath} from the run checkpoint.`);
      return;
    }
    await this.completeRunFileRevert(run, filePath);
  }

  private async revertRunFileForce(filePath: string, runId?: string): Promise<void> {
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
    const outcome = await this.restoreRunFile(run, filePath, entry, true);
    if (outcome === 'unavailable') {
      this.addNotice(`Could not restore ${filePath} from the run checkpoint.`);
      return;
    }
    await this.completeRunFileRevert(run, filePath);
  }

  private async completeRunFileRevert(run: RunRecord, filePath: string): Promise<void> {
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

  private async restoreRunFile(
    run: RunRecord,
    filePath: string,
    entry: RunChangedFile,
    force: boolean,
  ): Promise<'ok' | 'conflict' | 'unavailable'> {
    const root = workspaceRoot() ?? process.cwd();
    const absolute = absoluteWorkspacePath(root, filePath);
    let snapshot: FileSnapshotEntry | undefined;
    try {
      snapshot = await this.fileSnapshots.entry(run.id, filePath);
    } catch {}
    const originalHash = entry.originalHash ?? snapshot?.hash;
    const afterHash = operationAfterHash(run, filePath);
    const currentHash = await sha1File(absolute);
    const originAbsent = entry.absent === true || snapshot?.absent === true;

    if (!force) {
      if (originAbsent) {
        if (currentHash === undefined) {
          return 'ok';
        }
        if (afterHash && currentHash !== afterHash) {
          return 'conflict';
        }
      } else if (originalHash) {
        if (currentHash === originalHash) {
          return 'ok';
        }
        if (afterHash && currentHash !== afterHash) {
          return 'conflict';
        }
      } else if (afterHash && currentHash !== afterHash) {
        return 'conflict';
      }
    }

    if (snapshot && !snapshot.absent) {
      const original = await this.fileSnapshots.readOriginal(run.id, filePath);
      if (original !== undefined) {
        await writeFileAtomic(absolute, original, snapshot.mode);
        return 'ok';
      }
    }

    if (originAbsent || entry.status === 'added') {
      await fs.rm(absolute, { force: true }).catch(() => undefined);
      return 'ok';
    }

    if (run.checkpointId) {
      const restored = await this.checkpoints.restoreFile(run.checkpointId, filePath);
      return restored ? 'ok' : 'unavailable';
    }

    await this.diffManager.revertWholeFile(filePath);
    return 'ok';
  }

  private async answerRecoveredQuestion(
    runId: string | undefined,
    answers: Array<{ questionId?: string; value: string }>,
  ): Promise<void> {
    const run = runId ? await this.loadAnyRun(runId) : undefined;
    const pending = runId ? run?.pending : this.sessionPending;
    if (!pending || pending.kind !== 'question') {
      this.addNotice('That question is no longer pending.');
      return;
    }
    if (!validateRecoveredAnswers(pending, answers)) {
      this.addNotice('That answer is not valid for this question.');
      return;
    }
    const values = new Map<string, string>();
    if (pending.questions && pending.questions.length > 0) {
      pending.questions.forEach((item, index) => {
        const id = item.id ?? questionAnswerId(pending, index);
        const answer = answers.find((candidate) => (candidate.questionId ?? '') === id);
        values.set(id, (answer?.value ?? '').trim());
      });
    } else {
      values.set(pending.requestId ?? pending.id, (answers[0]?.value ?? '').trim());
    }
    const key = runId ?? 'session';
    this.recoveredAnswers.set(key, {
      prompt: pending.prompt,
      ...(pending.questions && pending.questions.length > 0
        ? {
            questions: pending.questions.map((item, index) => ({
              id: item.id ?? questionAnswerId(pending, index),
              question: item.question,
            })),
          }
        : {}),
      values,
    });
    if (run) {
      for (const operation of run.operations) {
        if (operation.status === 'started' && operation.startedAt <= pending.createdAt) {
          operation.status = 'failed';
          operation.finishedAt = Date.now();
        }
      }
      run.activeTool = undefined;
      run.updatedAt = Date.now();
      await this.saveRun(run);
      if (this.recoveryRun?.id === run.id) {
        this.recoveryRun = run;
      }
    } else {
      this.sessionPending = undefined;
      await this.persistNow();
    }
    this.pushState();
  }

  private async skipRecoveredQuestion(runId?: string): Promise<void> {
    if (runId) {
      const run = await this.loadAnyRun(runId);
      if (!run || !run.pending) {
        this.addNotice('That question is no longer pending.');
        return;
      }
      run.pending = undefined;
      run.status = 'stopped';
      run.updatedAt = Date.now();
      await this.saveRun(run);
      this.recoveredAnswers.delete(runId);
      if (this.currentRun?.id === runId) {
        this.currentRun = undefined;
      }
      if (this.recoveryRun?.id === runId) {
        this.recoveryRun = undefined;
        this.recoveryDrift = false;
      }
      this.pushState();
      return;
    }
    if (!this.sessionPending) {
      this.addNotice('That question is no longer pending.');
      return;
    }
    this.sessionPending = undefined;
    this.recoveredAnswers.delete('session');
    await this.persistNow();
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
    if (this.lastAnswer?.messageId === message.id) {
      this.lastAnswer = {
        ...this.lastAnswer,
        text: message.text,
        status: 'interrupted',
        updatedAt: Date.now(),
      };
      this.setContinuation('answer', message.id, 'interrupted');
    }
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
      await this.store.save(this.snapshotSession(), this.contextIndex);
    } catch {
      // storage failure is non-fatal
    }
  }
}

