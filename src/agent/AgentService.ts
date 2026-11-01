import { ChatMessage, LLMProvider, ReasoningOptions, ReasoningRouteContext, ToolCall, ToolDef, UsageTotals } from '../llm/types';
import { Plan, QuestionRequest, RunStats, TerminalApprovalDecision } from '../shared/protocol';
import {
  ActivityMeta,
  activityMeta,
  describeToolCall,
  parseFinishFiles,
  toolCallArgs,
  toolIcon,
} from './tools';
import { ToolBox, type ToolExecutionContext } from './ToolBox';
import type { VerifyCheckKind } from './verificationPolicy';
import type { FinishGateResult } from './finishGate';
import { parseCompoundResult } from './compoundResult';
import { PromptFamily, buildExecutorSpec, buildExecutorSystemPrompt } from '../planner/prompts';
import { chatWithRetry } from '../llm/retry';
import {
  DoomLoopDetector,
  LoopProgress,
  referencedFilePaths,
  touchedFileHash,
} from './doomloop';
import { MistakeTracker } from './mistakes';
import { ConvergenceGuard, ConvergenceState } from './convergence';
import { isContextOverflowError } from '../llm/errors';
import { normalizeToolArguments } from '../util/toolArgs';
import {
  ADAPTIVE_RECENT_FLOOR,
  PRESERVE_RECENT_TOKENS,
  buildCompactedMessages,
  buildDeterministicCheckpoint,
  compactDeterministically,
  foldMessagesForCompression,
  checkCompaction,
  chooseRecentStart,
  DEFAULT_CONTEXT_LIMIT,
  estimateTokens,
  projectExecutionMessages,
  summarizeMessages,
} from './compaction';
import { pruneMessages, shouldPrune } from './prune';
import { ContextProfile, preserveBudgetTokens } from './modelProfile';
import { mergeUsage, usageTotal } from '../llm/usage';
import { sha1Of } from '../util/atomicWrite';

const CONTEXT_NUDGE_RATIO = 0.5;
const CONTEXT_NUDGE_FIRM_RATIO = 0.85;
const CONTEXT_NUDGE_TURN_GAP = 5;

import { PARALLEL_SAFE } from './parallelTools';

const RETRIEVAL_SAFE = new Set([
  ...PARALLEL_SAFE,
  'inspect_file_context',
  'investigate_issue',
  'bounded_investigation',
  'verify_change',
]);

const STALE_READ_MARKER = '[outdated — this file changed after it was read; re-read it if needed]';

function normalizeLoopText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

export interface AgentCallbacks {
  onTextDelta(text: string): void;
  onReasoningDelta?(text: string): void;
  onToolActivity(
    id: string,
    label: string,
    status: 'running' | 'done' | 'error',
    icon?: string,
    meta?: ActivityMeta,
  ): void;
  requestTerminalApproval(command: string, cwd: string): Promise<TerminalApprovalDecision>;
  requestExternalDirectoryApproval?(directory: string): Promise<boolean>;
  askUser?(request: QuestionRequest): Promise<string>;
  setReasoning?(level: string): string;
  compressContext?(focus?: string): Promise<string> | string;
  onNotice?(text: string): void;
  onStatus?(id: string, text: string, tone?: 'progress' | 'error', done?: boolean): void;
  onUsage?(tokens: number): void;
  onUsageExact?(usage: UsageTotals): void;
  onCompaction?(info: {
    tokensBefore: number;
    tokensAfter: number;
    messagesBefore: number;
    messagesAfter: number;
  }): void;
  takePendingUserMessage?(): string | undefined;
  planCheckRequirement?: VerifyCheckKind;
  progressSnapshot?(): { completedStepCount?: number };
}

export interface AgentResult {
  summary?: string;
  files?: Array<{ path: string; summary: string }>;
  reachedLimit: boolean;
  stoppedByLoop?: boolean;
  stoppedByMistakes?: boolean;
  verificationWaived?: boolean;
  planWaived?: boolean;
  stats?: RunStats;
  incomplete?: { issues: string[]; compact: string };
}

export interface FinishCheckSummary {
  changedFiles: Array<{ path: string; delivered: boolean }>;
  recentToolFailures: string[];
  newDiagnosticErrors: number;
  diagnosticsAvailable: boolean;
  verificationRan: string[];
  verificationFailures: string[];
}

export interface AgentOptions {
  maxSteps: number;
  tools: ToolDef[];
  rules?: string;
  family?: PromptFamily;
  autoCompact: boolean;
  contextLimitTokens: number;
  parallelTools?: boolean;
  reasoning?: ReasoningOptions;
  resolveReasoning?: (context: ReasoningRouteContext) => ReasoningOptions | undefined;
  planFilePath?: string;
  contextProfile?: ContextProfile;
  profileReasoning?: boolean;
  /** Local models fold context deterministically instead of paying for a summary call. */
  deterministicContext?: boolean;
  finishCheck?: (summary: FinishCheckSummary) => FinishGateResult | Promise<FinishGateResult>;
  taskState?: { state: string; completedSteps: number[]; nextSteps: number[]; blockers: string[] };
  ledger?: string;
  /** Maximum bounded read-only evidence refinement rounds before editing. */
  retrievalPasses?: number;
  /** Execution runs must end through the finish tool, not a prose-only turn. */
  requireFinish?: boolean;
  /** Optional tools hidden from the initial prompt and enabled by load_tools. */
  lazyTools?: ToolDef[];
  /** Small deterministic codebase locator evidence for the initial turn. */
  initialEvidence?: string;
}

export class AgentService {
  private readonly doomLoop = new DoomLoopDetector();
  private readonly mistakes = new MistakeTracker();
  private readonly convergence = new ConvergenceGuard();
  private firstResponseAt = 0;
  private runStats: RunStats = {
    turns: 0,
    toolCalls: 0,
    promptTokens: 0,
    verificationRuns: 0,
    stopReason: 'finish',
  };

  constructor(
    private readonly provider: LLMProvider,
    private readonly model: string,
    private readonly toolbox: ToolBox,
    private readonly options: AgentOptions,
  ) {}

  private closedConvergenceResult(state: ConvergenceState, reason: string): AgentResult {
    return {
      reachedLimit: false,
      stoppedByLoop: true,
      summary: `Run ended incomplete — ${state}: ${reason}.`,
      incomplete: {
        issues: [reason],
        compact: `No verified deliverable was produced because convergence state ${state} was reached.`,
      },
    };
  }

  async run(
    plan: Plan,
    request: string,
    signal: AbortSignal,
    callbacks: AgentCallbacks,
  ): Promise<AgentResult> {
    const startedAt = Date.now();
    this.firstResponseAt = 0;
    this.runStats = {
      turns: 0,
      toolCalls: 0,
      promptTokens: 0,
      verificationRuns: 0,
      stopReason: 'finish',
    };
    const result = await this.runLoop(plan, request, signal, callbacks);
    this.runStats.durationMs = Date.now() - startedAt;
    if (this.firstResponseAt > 0) {
      this.runStats.timeToFirstTokenMs = this.firstResponseAt - startedAt;
    }
    const stopReason: RunStats['stopReason'] = result.stoppedByLoop
      ? 'loop'
      : result.stoppedByMistakes
        ? 'mistakes'
        : result.reachedLimit
          ? 'step-limit'
          : result.incomplete
            ? 'incomplete'
            : 'finish';
    const snapshot = this.toolbox.adaptiveVerificationSnapshot?.();
    return {
      ...result,
      stats: {
        ...this.runStats,
        verificationRuns: snapshot?.verificationRan.length ?? 0,
        stopReason,
      },
    };
  }

  private async runLoop(
    plan: Plan,
    request: string,
    signal: AbortSignal,
    callbacks: AgentCallbacks,
  ): Promise<AgentResult> {
    let messages: ChatMessage[] = [
      { role: 'system', content: buildExecutorSystemPrompt(this.options.rules, this.options.family) },
      { role: 'user', content: buildExecutorSpec(request, plan, this.options.planFilePath, this.options.taskState) },
    ];
    const readCallPaths = new Map<string, string>();
    const readMessageIndex = new Map<string, number>();
    const availableTools = [...this.options.tools];
    const toolsByName = new Map(availableTools.map((tool) => [tool.name, tool]));
    const lazyToolsByName = new Map((this.options.lazyTools ?? []).map((tool) => [tool.name, tool]));
    const contextLimit = this.options.contextLimitTokens || DEFAULT_CONTEXT_LIMIT;
    const profile = this.options.contextProfile;
    let latestUsage: UsageTotals | undefined;
    let lastNudgeTurn = -CONTEXT_NUDGE_TURN_GAP;
    let compressedRecently = false;
    const runChangedPaths = new Set<string>();
    const recentToolFailures: string[] = [];
    let finishContinuations = 0;
    let finishOverrideAsked = false;
    let lastAssistantText = '';
    let repeatedAssistantText = 0;
    let previousToolNames: string[] = [];
    let previousToolFailed = false;
    let finishRejected = false;
    let finishNudged = false;
    let lastProgressAt = Date.now();
    let toolCallIndex = 0;
    let completedTodoSteps = 0;
    let retrievalPasses = 0;
    const callIndexById = new Map<string, number>();
    const deferredLoopWarnings = new Map<string, string>();
    const seenToolEvidence = new Set<string>();
    const progressLog: Array<{ callIndex: number; description: string; fingerprint: string }> = [];
    const observedChecks = new Set(this.toolbox.adaptiveVerificationSnapshot?.().verificationRan ?? []);

    const localization = await this.localizePlanTargets(plan, signal, callbacks);
    if (localization) {
      messages.push({ role: 'system', content: localization });
    }
    if (this.options.ledger) {
      messages.push({ role: 'system', content: this.options.ledger });
    }
    if (this.options.initialEvidence) {
      messages.push({ role: 'system', content: this.options.initialEvidence });
    }
    if ((this.options.lazyTools?.length ?? 0) > 0) {
      messages.push({
        role: 'system',
        content: 'Optional tools are hidden to save context. If this step needs web access, a browser, MCP, semantic search, background processes, or a subagent, call load_tools with the needed names first.',
      });
    }

    const progressDescription = (): string =>
      progressLog.length > 0 ? progressLog[progressLog.length - 1].description : 'run start';

    const fingerprintFor = (call?: ToolCall): string => {
      const snapshot = this.toolbox.adaptiveVerificationSnapshot?.();
      const completedStepCount = callbacks.progressSnapshot?.().completedStepCount ?? 0;
      const touched = call
        ? touchedFileHash(call, this.toolbox.cachedFileHashes?.(referencedFilePaths(call)) ?? new Map())
        : '';
      return `${runChangedPaths.size}|${snapshot?.newDiagnosticErrors ?? 0}|${completedStepCount}|${touched}|${Math.floor(lastProgressAt / 1000)}`;
    };

    const progressFor = (call: ToolCall): LoopProgress => ({
      fingerprint: fingerprintFor(call),
      description: progressDescription(),
    });

    const noteProgress = (callIndex: number, description: string, call?: ToolCall): void => {
      lastProgressAt = Date.now();
      const fingerprint = fingerprintFor(call);
      progressLog.push({ callIndex, description, fingerprint });
      if (progressLog.length > 5) {
        progressLog.shift();
      }
      this.doomLoop.noteProgress({ fingerprint, description });
    };

    for (let step = 0; step < this.options.maxSteps; step++) {
      this.runStats.turns += 1;
      if (shouldPrune(estimateTokens(messages), contextLimit, profile)) {
        messages = pruneMessages(messages);
      }
      const compactionNote = this.compactionStateNote(plan, completedTodoSteps, runChangedPaths, recentToolFailures);
      messages = await this.maybeCompact(messages, signal, callbacks, compactionNote);
      if (compressedRecently) {
        compressedRecently = false;
        lastNudgeTurn = assistantTurns(messages);
      } else {
        const nudge = contextNudge(latestUsage, estimateTokens(messages), contextLimit, assistantTurns(messages), lastNudgeTurn);
        if (nudge) {
          messages = [...messages, { role: 'system', content: nudge.text }];
          lastNudgeTurn = nudge.turn;
        }
      }

      const steering = callbacks.takePendingUserMessage?.();
      if (steering) {
        messages.push({ role: 'user', content: steering });
        callbacks.onNotice?.('Added your message to the running task.');
        noteProgress(toolCallIndex, 'developer steering');
      }

      let projectedMessages = projectExecutionMessages(
        messages,
        plan,
        callbacks.progressSnapshot?.().completedStepCount ?? completedTodoSteps,
        contextLimit,
      );
      this.runStats.promptTokens += estimateTokens(projectedMessages);
      callbacks.onUsage?.(estimateTokens(projectedMessages));

      let text = '';
      let reasoning = '';
      const toolCalls: ToolCall[] = [];
      let streamed = false;
      let turnUsage: UsageTotals | undefined;

      for (let attempt = 0; attempt < 2 && !streamed; attempt++) {
        let retried = false;
        try {
          for await (const event of chatWithRetry(
            this.provider,
            projectedMessages,
            {
              model: this.model,
              tools: [...availableTools],
              signal,
              reasoning: this.options.resolveReasoning
                ? this.options.resolveReasoning({
                    phase: 'execution',
                    turn: step,
                    previousToolNames,
                    previousToolFailed,
                  })
                : this.options.reasoning,
              contextTokens: this.options.contextLimitTokens,
            },
            {
              retryOnEmpty: true,
              onRetry: (retryAttempt) => {
                retried = true;
                callbacks.onStatus?.('retry', `Retrying attempt ${retryAttempt}…`);
              },
            },
          )) {
            if (!this.firstResponseAt && (event.type === 'text' || event.type === 'reasoning' || event.type === 'toolCall')) {
              this.firstResponseAt = Date.now();
            }
            if (event.type === 'text') {
              text += event.text;
              callbacks.onTextDelta(event.text);
            } else if (event.type === 'reasoning') {
              reasoning += event.text;
              callbacks.onReasoningDelta?.(event.text);
            } else if (event.type === 'toolCall') {
              toolCalls.push(event.toolCall);
            } else if (event.type === 'usage') {
              turnUsage = mergeUsage(turnUsage, event);
            }
          }
          if (retried) {
            callbacks.onStatus?.('retry', '', undefined, true);
          }
          streamed = true;
          if (turnUsage) {
            latestUsage = turnUsage;
            callbacks.onUsageExact?.(turnUsage);
          }
        } catch (error) {
          if (retried) {
            callbacks.onStatus?.('retry', '', undefined, true);
          }
          if (attempt === 0 && isContextOverflowError(error)) {
            callbacks.onNotice?.('Context limit reached — compacting and retrying…');
            messages = await this.forceCompact(
              messages,
              signal,
              callbacks,
              this.compactionStateNote(plan, completedTodoSteps, runChangedPaths, recentToolFailures),
            );
            projectedMessages = projectExecutionMessages(
              messages,
              plan,
              callbacks.progressSnapshot?.().completedStepCount ?? completedTodoSteps,
              contextLimit,
            );
            continue;
          }
          if (attempt > 0 && (text.trim() || reasoning.trim())) {
            callbacks.onNotice?.('Stopped: the model stream ended before a complete deliverable.');
            return this.closedConvergenceResult('TRUNCATED', 'the model stream ended after partial output');
          }
          throw error;
        }
      }

      if (toolCalls.length === 0) {
        if (text.trim()) {
          const normalizedText = normalizeLoopText(text);
          if (normalizedText && normalizedText === lastAssistantText) {
            repeatedAssistantText += 1;
            if (repeatedAssistantText >= 2) {
              callbacks.onNotice?.(
                'Stopped: the model repeated the same response without progress. Completed work was preserved; reconsider the next step.',
              );
              return this.closedConvergenceResult('FIXED_POINT', 'the same assistant response repeated without progress');
            }
            messages.push({
              role: 'user',
              content:
                'LOOP RECOVERY: your last response repeated without progress. Do not repeat it. Re-read the relevant evidence, take one different bounded action, or explain the blocker.',
            });
            continue;
          }
          lastAssistantText = normalizedText;
          repeatedAssistantText = 0;
          if (this.options.requireFinish && (plan.steps?.length ?? 0) > 0) {
            if (!finishNudged) {
              finishNudged = true;
              messages.push({
                role: 'user',
                content:
                  'Do not end with prose. The approved plan is not complete until you call finish with the summary and files. Call finish now, or continue with the required tool work first.',
              });
              continue;
            }
            callbacks.onNotice?.('Run ended incomplete — the finish tool was not called.');
            return {
              reachedLimit: false,
              summary: text.trim(),
              files: [],
              incomplete: {
                issues: ['finish tool was not called'],
                compact: 'The model stopped with prose before calling finish; verification and the finish gate did not complete.',
              },
            };
          }
          const convergence = this.convergence.observe({
            signature: `text:${normalizedText}`,
            producedOutput: true,
            madeProgress: true,
          });
          if (convergence) return this.closedConvergenceResult(convergence.state, convergence.reason);
          return { reachedLimit: false };
        }
        const convergence = this.convergence.observe({ signature: 'empty', producedOutput: false, madeProgress: false });
        if (convergence) {
          callbacks.onNotice?.(`Stopped: ${convergence.reason}.`);
          return this.closedConvergenceResult(convergence.state, convergence.reason);
        }
        messages.push({ role: 'user', content: 'Continue executing the plan. Use tools.' });
        continue;
      }

      const normalizedCalls = toolCalls.map((call) => {
        const definition = toolsByName.get(call.name);
        if (!definition) {
          return call;
        }
        return { ...call, arguments: normalizeToolArguments(call.arguments, definition.parameters) };
      });
      this.runStats.toolCalls += normalizedCalls.length;

      const normalizedResponse = normalizeLoopText(text);
      if (normalizedResponse && normalizedResponse === lastAssistantText) {
        repeatedAssistantText += 1;
        if (repeatedAssistantText >= 2) {
          callbacks.onNotice?.(
            'Stopped: the model repeated the same response without progress. Completed work was preserved; reconsider the next step.',
          );
          return this.closedConvergenceResult('FIXED_POINT', 'the assistant repeated the same response with tool calls');
        }
        messages.push({
          role: 'user',
          content:
            'LOOP RECOVERY: your last response repeated without progress. Do not repeat it. Re-read the relevant evidence, take one different bounded action, or explain the blocker.',
        });
        continue;
      }
      if (normalizedResponse) {
        lastAssistantText = normalizedResponse;
        repeatedAssistantText = 0;
      }

      messages.push({
        role: 'assistant',
        content: text,
        toolCalls: normalizedCalls,
        ...(reasoning ? { reasoning } : {}),
      });

      for (const call of normalizedCalls) {
        if (call.name === 'finish') {
          const args = toolCallArgs(call);
          const summary = String(args.summary ?? '').trim() || 'Done.';
          let verification: { ran: string[]; failures: string[] } = { ran: [], failures: [] };
          if (callbacks.planCheckRequirement) {
            const context: ToolExecutionContext = {
              requestTerminalApproval: callbacks.requestTerminalApproval,
              requestExternalDirectoryApproval: callbacks.requestExternalDirectoryApproval,
              askUser: callbacks.askUser,
              signal,
              planCheckRequirement: callbacks.planCheckRequirement,
            };
            callbacks.onStatus?.('verify', `Running ${callbacks.planCheckRequirement} check…`, 'progress');
            try {
              verification = (await this.toolbox.finishVerification?.(
                callbacks.planCheckRequirement,
                [...runChangedPaths],
                context,
              )) ?? verification;
            } finally {
              callbacks.onStatus?.('verify', '', undefined, true);
            }
            for (const entry of verification.ran) {
              callbacks.onNotice?.(`Final verification passed: ${entry}`);
            }
          }
          const gate = this.options.finishCheck
            ? await this.options.finishCheck(
              this.finishCheckSummary(runChangedPaths, recentToolFailures, verification.failures),
            )
            : undefined;
          if (gate && !gate.ok) {
            const firstIssue = gate.issues[0] ?? 'finish check failed';
            // Verification and diagnostics failures are the developer's call;
            // never auto-loop when they can explicitly accept the result.
            if (gate.overridable && callbacks.askUser && !finishOverrideAsked) {
              finishOverrideAsked = true;
              const answer = await callbacks
                .askUser({
                  id: `finish-${call.id}`,
                  question: `Verification did not pass.\n\n${gate.compact}\n\nFinish anyway?`,
                  header: 'Finish anyway?',
                  options: [
                    { label: 'Finish anyway', description: 'Complete the run without passing verification.' },
                    { label: 'Keep working', description: 'Let the agent try to fix the failure.' },
                  ],
                  multiple: false,
                })
                .catch(() => 'Keep working');
              if (/^finish anyway$/i.test(answer.trim())) {
                const expectedOnly = gate.issues.length > 0
                  && gate.issues.every((issue) => issue.startsWith('expected file not changed'));
                const note = expectedOnly
                  ? 'Finished with verification incomplete — expected files were not changed.'
                  : "Finished without passing verification at the developer's request.";
                callbacks.onNotice?.(note);
                return {
                  summary: `${summary}\n\n${note}`,
                  files: parseFinishFiles(args),
                  reachedLimit: false,
                  ...(expectedOnly ? { planWaived: true } : { verificationWaived: true }),
                };
              }
            }
            if (finishContinuations >= 1) {
              callbacks.onNotice?.(`Run ended incomplete — ${firstIssue}`);
              return {
                summary,
                files: parseFinishFiles(args),
                reachedLimit: false,
                incomplete: { issues: gate.issues, compact: gate.compact },
              };
            }
            finishContinuations += 1;
            for (const pending of normalizedCalls) {
              messages.push({
                role: 'tool',
                toolCallId: pending.id,
                toolName: pending.name,
                content: pending.id === call.id ? gate.compact : 'Error: tool did not run.',
              });
            }
            finishRejected = true;
            break;
          }
          return { summary, files: parseFinishFiles(args), reachedLimit: false };
        }
        toolCallIndex += 1;
        callIndexById.set(call.id, toolCallIndex);
        const loopCheck = this.doomLoop.record(call, progressFor(call));
        if (loopCheck.action === 'stop') {
          callbacks.onNotice?.(loopCheck.message ?? `Stopped: the same tool call (${call.name}) was repeated ${loopCheck.count} times. Possible loop.`);
          return this.closedConvergenceResult('SHELL_LOOP', loopCheck.message ?? `the same tool call (${call.name}) repeated without progress`);
        }
        if (loopCheck.action === 'warn' && loopCheck.message) {
          deferredLoopWarnings.set(call.id, loopCheck.message);
        }
      }
      if (finishRejected) {
        finishRejected = false;
        deferredLoopWarnings.clear();
        continue;
      }

      const results = new Map<string, string>();
      previousToolNames = normalizedCalls.map((call) => call.name);
      previousToolFailed = false;
      let turnMadeProgress = false;
      const executeOne = async (call: ToolCall): Promise<void> => {
        callbacks.onToolActivity(call.id, describeToolCall(call), 'running', toolIcon(call.name), activityMeta(call, ''));
        let result: string;
        if (call.name === 'load_tools') {
          const requested = Array.isArray(toolCallArgs(call).names)
            ? (toolCallArgs(call).names as unknown[]).filter((name): name is string => typeof name === 'string')
            : [];
          const loaded: string[] = [];
          for (const name of requested) {
            if (toolsByName.has(name)) continue;
            const definition = lazyToolsByName.get(name);
            if (!definition) continue;
            toolsByName.set(name, definition);
            availableTools.push(definition);
            loaded.push(name);
          }
          result = loaded.length > 0
            ? `Loaded tools: ${loaded.join(', ')}. They are available from the next model turn.`
            : `No optional tools were loaded. Available: ${[...lazyToolsByName.keys()].join(', ') || 'none'}.`;
        } else if (call.name === 'set_reasoning') {
          const args = toolCallArgs(call);
          const level = String(args.level ?? '').trim();
          result = callbacks.setReasoning
            ? callbacks.setReasoning(level)
            : 'Error: changing the reasoning effort is not available in this run.';
        } else if (call.name === 'compress_context') {
          const args = toolCallArgs(call);
          const focus = typeof args.focus === 'string' ? args.focus : undefined;
          let controllerResult = '';
          if (callbacks.compressContext) {
            try {
              controllerResult = await callbacks.compressContext(focus);
            } catch (error) {
              controllerResult = `Error: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          const profile = this.options.contextProfile;
          const preserve = profile
            ? preserveBudgetTokens(profile, contextLimit, this.options.profileReasoning ?? false)
            : PRESERVE_RECENT_TOKENS;
          let assistantIndex = messages.length;
          for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message.role === 'assistant' && message.toolCalls?.some((entry) => entry.id === call.id)) {
              assistantIndex = index;
              break;
            }
          }
          const progress = callbacks.progressSnapshot?.();
          const completedCount = progress?.completedStepCount ?? completedTodoSteps;
          const stateNote = this.compactionStateNote(
            plan,
            completedCount,
            runChangedPaths,
            recentToolFailures,
            focus,
          );
          const fold = foldMessagesForCompression(messages, preserve, {
            minRecentStart: assistantIndex,
            stateNote,
            pinned: this.pinnedLedger(messages),
          });
          if (fold.folded) {
            messages = fold.messages;
            readCallPaths.clear();
            readMessageIndex.clear();
            callbacks.onCompaction?.({
              tokensBefore: fold.beforeTokens,
              tokensAfter: fold.afterTokens,
              messagesBefore: fold.beforeMessages,
              messagesAfter: messages.length,
            });
          }
          const controllerOk = controllerResult.length > 0 && !controllerResult.startsWith('Error:');
          const percent = fold.folded
            ? Math.round((1 - fold.afterTokens / Math.max(1, fold.beforeTokens)) * 100)
            : 0;
          const foldNote = fold.folded
            ? `Executor context folded from ~${fold.beforeTokens} to ~${fold.afterTokens} estimated tokens (${percent}% smaller).`
            : 'No older executor context could be folded; transcript unchanged.';
          if (fold.folded) {
            result = [controllerOk ? controllerResult : '', foldNote].filter(Boolean).join('\n');
          } else if (controllerOk) {
            result = `${controllerResult}\n${foldNote}`;
          } else {
            result = controllerResult || foldNote;
          }
          compressedRecently = fold.folded;
        } else {
          try {
            result = await this.toolbox.execute(call.name, call.arguments, {
              requestTerminalApproval: callbacks.requestTerminalApproval,
              requestExternalDirectoryApproval: callbacks.requestExternalDirectoryApproval,
              askUser: callbacks.askUser,
              signal,
              planCheckRequirement: callbacks.planCheckRequirement,
              contextPressure: () => ({
                usedTokens: estimateTokens(messages),
                limitTokens: this.options.contextLimitTokens,
              }),
            });
          } catch (error) {
            result = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        results.set(call.id, result);
        callbacks.onToolActivity(
          call.id,
          describeToolCall(call),
          result.startsWith('Error:') ? 'error' : 'done',
          toolIcon(call.name),
          activityMeta(call, result),
        );
      };

      const parallelSafe = this.options.parallelTools !== false;
      // Preserve model order: batch only consecutive read-only calls. Reads
      // must never be hoisted ahead of an earlier edit in the same turn.
      for (let index = 0; index < normalizedCalls.length;) {
        const call = normalizedCalls[index];
        if (call && parallelSafe && PARALLEL_SAFE.has(call.name)) {
          const batch: ToolCall[] = [];
          while (index < normalizedCalls.length && PARALLEL_SAFE.has(normalizedCalls[index].name)) {
            batch.push(normalizedCalls[index]);
            index += 1;
          }
          if (batch.length > 1) {
            await Promise.all(batch.map((pending) => executeOne(pending)));
          } else if (batch[0]) {
            await executeOne(batch[0]);
          }
        } else if (call) {
          await executeOne(call);
          index += 1;
        } else {
          index += 1;
        }
      }

      for (const call of normalizedCalls) {
        const result = results.get(call.id) ?? 'Error: tool did not run.';
        if (result.startsWith('Error:') || result.startsWith('Error in')) previousToolFailed = true;
        messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result });

        if (result.startsWith('Error:') || result.startsWith('Error in')) {
          recentToolFailures.push(`${call.name}: ${toolFailureSummary(result)}`);
          if (recentToolFailures.length > 4) {
            recentToolFailures.shift();
          }
        }

        if (call.name === 'read_file') {
          const path = String(toolCallArgs(call).path ?? '');
          if (path) {
            readCallPaths.set(call.id, path);
            readMessageIndex.set(call.id, messages.length - 1);
          }
        }

        const callIndex = callIndexById.get(call.id) ?? toolCallIndex;
        let callMadeProgress = false;
        const evidenceKey = `${call.name}:${call.arguments}:${sha1Of(result)}`;
        if (!result.startsWith('Error:') && !result.startsWith('Error in') && !seenToolEvidence.has(evidenceKey)) {
          seenToolEvidence.add(evidenceKey);
          noteProgress(callIndex, `new ${call.name} result`, call);
          callMadeProgress = true;
          turnMadeProgress = true;
        }
        const changedPaths = mutationPaths(call, result);
        for (const changedPath of changedPaths) {
          runChangedPaths.add(changedPath);
        }
        if (changedPaths.length > 0) {
          const description =
            call.name === 'apply_change_set'
              ? `applied change set (${changedPaths.length} files)`
              : changedPaths.length === 1
                ? `edited ${changedPaths[0]}`
                : `edited ${changedPaths.length} files`;
          noteProgress(callIndex, description, call);
          callMadeProgress = true;
          turnMadeProgress = true;
          const rewritten = rewriteStaleReads(messages, changedPaths, readCallPaths, readMessageIndex);
          if (rewritten > 0) {
            callbacks.onNotice?.(`Marked ${rewritten} earlier file read(s) as outdated.`);
          }
        }

        if (!result.startsWith('Error:') && !result.startsWith('Error in')) {
          const freshChecks = (this.toolbox.adaptiveVerificationSnapshot?.().verificationRan ?? []).filter(
            (check) => !observedChecks.has(check),
          );
          if (freshChecks.length > 0) {
            for (const check of freshChecks) {
              observedChecks.add(check);
            }
            const compound = parseCompoundResult(result);
            const passed =
              call.name === 'run_terminal_command'
                ? /^Exit code: 0\b/m.test(result)
                : compound === undefined || compound.status === 'verified';
            if (passed) {
              noteProgress(
                callIndex,
                call.name === 'verify_change' ? 'verify_change passed' : `${freshChecks[freshChecks.length - 1]} passed`,
                call,
              );
              callMadeProgress = true;
              turnMadeProgress = true;
            }
          }
        }

        if (call.name === 'todo_write' && !result.startsWith('Error:')) {
          const rawTodos = toolCallArgs(call).todos;
          if (Array.isArray(rawTodos)) {
            const done = rawTodos.filter(
              (todo) => todo && typeof todo === 'object' && (todo as { status?: unknown }).status === 'done',
            ).length;
            if (done > completedTodoSteps) {
              completedTodoSteps = done;
              noteProgress(callIndex, `step ${done} completed`, call);
              callMadeProgress = true;
              turnMadeProgress = true;
            }
          }
        }

        const mistake = this.mistakes.record(result);
        if (mistake.action === 'correct') {
          messages.push({
            role: 'user',
            content: `You have had ${mistake.count} consecutive tool failures. Stop and reconsider: re-read the relevant files and adjust your approach before trying again.`,
          });
        } else if (mistake.action === 'stop') {
          callbacks.onNotice?.(
            `Stopped after ${mistake.count} consecutive tool failures. Review the errors, then tell me how you would like to proceed.`,
          );
          return {
            reachedLimit: false,
            stoppedByMistakes: true,
            summary: `Run ended incomplete — ${mistake.count} consecutive tool failures.`,
            incomplete: {
              issues: [`${mistake.count} consecutive tool failures`],
              compact: 'No verified deliverable was produced after repeated tool failures.',
            },
          };
        }

        const loopCheck = this.doomLoop.record(call, progressFor(call));
        if (loopCheck.action === 'stop') {
          callbacks.onNotice?.(loopCheck.message ?? `Stopped: the same tool call (${call.name}) was repeated ${loopCheck.count} times. Possible loop.`);
          return this.closedConvergenceResult('SHELL_LOOP', loopCheck.message ?? `the same tool call (${call.name}) repeated without progress`);
        }
        const deferredWarning = deferredLoopWarnings.get(call.id);
        deferredLoopWarnings.delete(call.id);
        if (loopCheck.action === 'warn') {
          messages.push({
            role: 'user',
            content:
              loopCheck.message ??
              `Warning: you have called ${call.name} with identical arguments ${loopCheck.count} times. Stop and reconsider — try a different approach or explain what is blocking you.`,
          });
        } else if (deferredWarning && !callMadeProgress) {
          messages.push({ role: 'user', content: deferredWarning });
        }
      }
      const readOnlyTurn = normalizedCalls.length > 0 && normalizedCalls.every((call) => RETRIEVAL_SAFE.has(call.name));
      const retrievalLimit = Math.max(0, this.options.retrievalPasses ?? 2);
      if (readOnlyTurn && turnMadeProgress && retrievalPasses < retrievalLimit) {
        retrievalPasses += 1;
        messages.push({
          role: 'system',
          content: `Retrieval pass ${retrievalPasses}/${retrievalLimit} completed. Use the new evidence to localize the exact symbol or range before editing; do not repeat an identical read.`,
        });
      }
      const convergence = this.convergence.observe({
        signature: normalizedCalls.map((call) => `${call.name}:${call.arguments}`).join('|'),
        producedOutput: true,
        madeProgress: turnMadeProgress,
        toolNames: normalizedCalls.map((call) => call.name),
      });
      if (convergence) {
        callbacks.onNotice?.(`Stopped: ${convergence.reason}.`);
        return this.closedConvergenceResult(convergence.state, convergence.reason);
      }
    }

    return {
      reachedLimit: true,
      incomplete: {
        issues: [`reached the ${this.options.maxSteps}-step limit`],
        compact: `Run ended incomplete — the step limit (${this.options.maxSteps}) was reached. Completed work is preserved. Review the changes, then send a message to continue.`,
      },
    };
  }

  private async maybeCompact(
    messages: ChatMessage[],
    signal: AbortSignal,
    callbacks: AgentCallbacks,
    stateNote?: string,
  ): Promise<ChatMessage[]> {
    if (!this.options.autoCompact) {
      return messages;
    }
    const profile = this.options.contextProfile;
    const check = checkCompaction(
      messages,
      this.options.contextLimitTokens || DEFAULT_CONTEXT_LIMIT,
      profile ? { profile, reasoning: this.options.profileReasoning ?? false } : undefined,
    );
    if (!check.needed || check.recentStart <= 2) {
      return messages;
    }
    const pinned = this.pinnedLedger(messages);
    if (this.options.deterministicContext) {
      const threshold = check.threshold
        ?? (this.options.contextLimitTokens || DEFAULT_CONTEXT_LIMIT) * 0.6;
      const compacted = compactDeterministically(messages, check.recentStart, threshold, { stateNote, pinned });
      callbacks.onCompaction?.({
        tokensBefore: estimateTokens(messages),
        tokensAfter: estimateTokens(compacted),
        messagesBefore: messages.length,
        messagesAfter: compacted.length,
      });
      return compacted;
    }
    try {
      const summary = await summarizeMessages(this.provider, this.model, messages.slice(2, check.recentStart), signal);
      const compacted = summary
        ? buildCompactedMessages(messages, summary, check.recentStart)
        : buildDeterministicCheckpoint(messages, check.recentStart, 12_000, stateNote, pinned);
      callbacks.onCompaction?.({
        tokensBefore: estimateTokens(messages),
        tokensAfter: estimateTokens(compacted),
        messagesBefore: messages.length,
        messagesAfter: compacted.length,
      });
      return compacted;
    } catch {
      const compacted = buildDeterministicCheckpoint(messages, check.recentStart, 12_000, stateNote, pinned);
      callbacks.onCompaction?.({
        tokensBefore: estimateTokens(messages),
        tokensAfter: estimateTokens(compacted),
        messagesBefore: messages.length,
        messagesAfter: compacted.length,
      });
      return compacted;
    }
  }

  private compactionStateNote(
    plan: Plan,
    completed: number,
    changed: Set<string>,
    failures: string[],
    focus?: string,
  ): string {
    const stepCount = plan.steps?.length ?? 0;
    const current = stepCount > 0 ? plan.steps?.[Math.min(completed, stepCount - 1)] : undefined;
    const changedFiles = [...changed].slice(0, 20);
    const blockers = [...(this.options.taskState?.blockers ?? []), ...failures.slice(-2)];
    return [
      focus ? `Compression focus: ${focus}` : '',
      current ? `Current step: ${current}` : '',
      `Completed steps: ${completed} of ${stepCount}`,
      changedFiles.length > 0 ? `Changed files: ${changedFiles.join(', ')}` : '',
      blockers.length > 0 ? `Recent blockers: ${blockers.join(' | ')}` : '',
    ].filter(Boolean).join('\n');
  }

  private pinnedLedger(messages: ChatMessage[]): ChatMessage[] {
    const ledger = this.options.ledger;
    if (!ledger) return [];
    const index = messages.findIndex((message) => message.role === 'system' && message.content === ledger);
    return index >= 2 ? [messages[index]] : [];
  }

  private async localizePlanTargets(
    plan: Plan,
    signal: AbortSignal,
    callbacks: AgentCallbacks,
  ): Promise<string | undefined> {
    const compact = this.options.contextProfile?.tier === 'compact';
    const targets = [...new Set((plan.expectedFiles ?? [])
      .map((file) => file.path.trim())
      .filter(Boolean))].slice(0, compact ? 3 : 8);
    if (targets.length === 0) return undefined;
    const context = {
      requestTerminalApproval: async (): Promise<TerminalApprovalDecision> => 'deny',
      requestExternalDirectoryApproval: async (): Promise<boolean> => false,
      signal,
    };
    const results = await Promise.all(targets.map(async (file) => {
      try {
        const text = await this.toolbox.execute('document_symbols', JSON.stringify({ path: file }), context);
        if (text.startsWith('Error:')) return undefined;
        return `File ${file}:\n${text.slice(0, 1200)}`;
      } catch {
        return undefined;
      }
    }));
    const useful = results.filter((value): value is string => Boolean(value));
    if (useful.length === 0) return undefined;
    callbacks.onNotice?.(`Localized ${useful.length} planned file${useful.length === 1 ? '' : 's'} to their symbols before editing.`);
    return [
      '[Deterministic edit localization]',
      'The following symbol trees came from the language service. Use them to target exact functions; verify contents before changing them.',
      ...useful,
    ].join('\n\n').slice(0, compact ? 3000 : 7000);
  }

  private async forceCompact(
    messages: ChatMessage[],
    signal: AbortSignal,
    callbacks: AgentCallbacks,
    stateNote?: string,
  ): Promise<ChatMessage[]> {
    const profile = this.options.contextProfile;
    const preserve = profile
      ? preserveBudgetTokens(
          profile,
          this.options.contextLimitTokens || DEFAULT_CONTEXT_LIMIT,
          this.options.profileReasoning ?? false,
        )
      : PRESERVE_RECENT_TOKENS;
    const recentStart = chooseRecentStart(messages, preserve, profile ? ADAPTIVE_RECENT_FLOOR : undefined);
    if (recentStart <= 2) {
      return messages;
    }
    const pinned = this.pinnedLedger(messages);
    const report = (compacted: ChatMessage[]): void => {
      callbacks.onCompaction?.({
        tokensBefore: estimateTokens(messages),
        tokensAfter: estimateTokens(compacted),
        messagesBefore: messages.length,
        messagesAfter: compacted.length,
      });
    };
    if (this.options.deterministicContext) {
      const threshold = (this.options.contextLimitTokens || DEFAULT_CONTEXT_LIMIT) * 0.6;
      const compacted = compactDeterministically(messages, recentStart, threshold, { stateNote, pinned });
      report(compacted);
      return compacted;
    }
    try {
      const summary = await summarizeMessages(this.provider, this.model, messages.slice(2, recentStart), signal);
      if (summary) {
        const compacted = buildCompactedMessages(messages, summary, recentStart);
        report(compacted);
        return compacted;
      }
    } catch {
      // fall through to a model-free checkpoint below
    }
    const compacted = buildDeterministicCheckpoint(messages, recentStart, 12_000, stateNote, pinned);
    report(compacted);
    return compacted;
  }

  private finishCheckSummary(
    runChangedPaths: Set<string>,
    recentToolFailures: string[],
    verificationFailures: string[] = [],
  ): FinishCheckSummary {
    const snapshot = this.toolbox.adaptiveVerificationSnapshot?.();
    return {
      changedFiles: [...runChangedPaths].map((path) => ({ path, delivered: true })),
      recentToolFailures: [...recentToolFailures],
      newDiagnosticErrors: snapshot?.newDiagnosticErrors ?? 0,
      diagnosticsAvailable: snapshot?.diagnosticsAvailable ?? false,
      verificationRan: snapshot?.verificationRan ?? [],
      verificationFailures: [...new Set([...(snapshot?.verificationFailures ?? []), ...verificationFailures])],
    };
  }
}

function assistantTurns(messages: ChatMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === 'assistant') {
      count++;
    }
  }
  return count;
}

function toolFailureSummary(result: string): string {
  const line = result.split('\n').find((entry) => entry.trim()) ?? result;
  const text = line.replace(/^Error:?\s*/i, '').trim();
  return text.slice(0, 120) || 'failed';
}

function contextNudge(
  usage: UsageTotals | undefined,
  estimated: number,
  contextLimit: number,
  assistantTurnCount: number,
  lastNudgeTurn: number,
): { text: string; turn: number } | undefined {
  const tokens = usage ? usageTotal(usage) : estimated;
  if (contextLimit <= 0) {
    return undefined;
  }
  const ratio = tokens / contextLimit;
  if (ratio < CONTEXT_NUDGE_RATIO) {
    return undefined;
  }
  if (assistantTurnCount - lastNudgeTurn < CONTEXT_NUDGE_TURN_GAP) {
    return undefined;
  }
  const percent = Math.round(ratio * 100);
  const text =
    ratio >= CONTEXT_NUDGE_FIRM_RATIO
      ? `Context is ~${percent}%. If an earlier chunk of work is resolved, call compress_context now.`
      : `Context is ~${percent}%. If an earlier chunk of work is resolved, call compress_context to fold it.`;
  return { text, turn: assistantTurnCount };
}

const MUTATION_TOOL_NAMES = new Set([
  'apply_change_set',
  'fix_in_file',
  'fix_diagnostic',
  'add_import_and_use',
  'rename_symbol',
  'refactor_symbol',
  'update_related_files',
]);

function mutationPaths(call: ToolCall, result: string): string[] {
  if (result.startsWith('Error:') || result.startsWith('Error in')) {
    return [];
  }
  const compound = parseCompoundResult(result);
  if (MUTATION_TOOL_NAMES.has(call.name)) {
    // Compound results carry the authoritative changed set, including files
    // changed by language-server tools that the arguments do not mention.
    return compound ? normalizeChangedPaths(compound.changedFiles ?? []) : [];
  }
  if (compound) {
    return [];
  }
  if (call.name === 'write_file' || call.name === 'edit_file') {
    const path = String(toolCallArgs(call).path ?? '');
    return path ? [path] : [];
  }
  if (call.name === 'apply_patch') {
    const patch = String(toolCallArgs(call).patch ?? '');
    const matches = patch.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm) ?? [];
    return matches.map((line) => line.replace(/^\*\*\* (?:Add|Update|Delete) File:\s*/, '').trim());
  }
  return [];
}

function normalizeChangedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = String(path).replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (normalized) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

function rewriteStaleReads(
  messages: ChatMessage[],
  changedPaths: string[],
  readCallPaths: Map<string, string>,
  readMessageIndex: Map<string, number>,
): number {
  const changed = new Set(changedPaths);
  let rewritten = 0;
  for (const [callId, path] of readCallPaths) {
    if (!changed.has(path)) {
      continue;
    }
    const index = readMessageIndex.get(callId);
    if (index === undefined || index >= messages.length) {
      continue;
    }
    const message = messages[index];
    if (message.role === 'tool' && message.content !== STALE_READ_MARKER) {
      message.content = STALE_READ_MARKER;
      rewritten++;
    }
    readCallPaths.delete(callId);
    readMessageIndex.delete(callId);
  }
  return rewritten;
}
