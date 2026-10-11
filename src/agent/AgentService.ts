import { ChatMessage, LLMProvider, ReasoningOptions, ToolCall, ToolDef, UsageTotals } from '../llm/types';
import { Plan, QuestionRequest, TerminalApprovalDecision } from '../shared/protocol';
import {
  ActivityMeta,
  activityMeta,
  describeToolCall,
  parseFinishFiles,
  toolCallArgs,
  toolIcon,
} from './tools';
import { ToolBox } from './ToolBox';
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
import { isContextOverflowError } from '../llm/errors';
import { normalizeToolArguments } from '../util/toolArgs';
import {
  ADAPTIVE_RECENT_FLOOR,
  PRESERVE_RECENT_TOKENS,
  buildCompactedMessages,
  checkCompaction,
  chooseRecentStart,
  DEFAULT_CONTEXT_LIMIT,
  estimateTokens,
  summarizeMessages,
} from './compaction';
import { pruneMessages, shouldPrune } from './prune';
import { ContextProfile, preserveBudgetTokens } from './modelProfile';
import { mergeUsage, usageTotal } from '../llm/usage';

const CONTEXT_NUDGE_RATIO = 0.5;
const CONTEXT_NUDGE_FIRM_RATIO = 0.85;
const CONTEXT_NUDGE_TURN_GAP = 5;

const PARALLEL_SAFE = new Set([
  'read_file',
  'list_files',
  'search_text',
  'find_symbol',
  'document_symbols',
  'find_references',
  'go_to_definition',
  'hover',
  'go_to_implementation',
  'incoming_calls',
  'outgoing_calls',
  'semantic_search',
  'web_fetch',
  'web_search',
  'list_processes',
]);

const STALE_READ_MARKER = '[outdated — this file changed after it was read; re-read it if needed]';

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
  incomplete?: { issues: string[]; compact: string };
}

export interface FinishCheckSummary {
  changedFiles: Array<{ path: string; delivered: boolean }>;
  recentToolFailures: string[];
  newDiagnosticErrors: number;
  diagnosticsAvailable: boolean;
  verificationRan: string[];
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
  resolveReasoning?: () => ReasoningOptions | undefined;
  planFilePath?: string;
  contextProfile?: ContextProfile;
  profileReasoning?: boolean;
  finishCheck?: (summary: FinishCheckSummary) => FinishGateResult | Promise<FinishGateResult>;
}

export class AgentService {
  private readonly doomLoop = new DoomLoopDetector();
  private readonly mistakes = new MistakeTracker();

  constructor(
    private readonly provider: LLMProvider,
    private readonly model: string,
    private readonly toolbox: ToolBox,
    private readonly options: AgentOptions,
  ) {}

  async run(
    plan: Plan,
    request: string,
    signal: AbortSignal,
    callbacks: AgentCallbacks,
  ): Promise<AgentResult> {
    let messages: ChatMessage[] = [
      { role: 'system', content: buildExecutorSystemPrompt(this.options.rules, this.options.family) },
      { role: 'user', content: buildExecutorSpec(request, plan, this.options.planFilePath) },
    ];
    const readCallPaths = new Map<string, string>();
    const readMessageIndex = new Map<string, number>();
    const toolsByName = new Map(this.options.tools.map((tool) => [tool.name, tool]));
    const contextLimit = this.options.contextLimitTokens || DEFAULT_CONTEXT_LIMIT;
    const profile = this.options.contextProfile;
    let latestUsage: UsageTotals | undefined;
    let lastNudgeTurn = -CONTEXT_NUDGE_TURN_GAP;
    let compressedRecently = false;
    const runChangedPaths = new Set<string>();
    const recentToolFailures: string[] = [];
    let finishContinuations = 0;
    let finishRejected = false;
    let lastProgressAt = Date.now();
    let toolCallIndex = 0;
    let completedTodoSteps = 0;
    const callIndexById = new Map<string, number>();
    const deferredLoopWarnings = new Map<string, string>();
    const progressLog: Array<{ callIndex: number; description: string; fingerprint: string }> = [];
    const observedChecks = new Set(this.toolbox.adaptiveVerificationSnapshot?.().verificationRan ?? []);

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
      if (shouldPrune(estimateTokens(messages), contextLimit, profile)) {
        messages = pruneMessages(messages);
      }
      messages = await this.maybeCompact(messages, signal, callbacks);
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

      callbacks.onUsage?.(estimateTokens(messages));

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
            messages,
            {
              model: this.model,
              tools: this.options.tools,
              signal,
              reasoning: this.options.resolveReasoning ? this.options.resolveReasoning() : this.options.reasoning,
            },
            {
              retryOnEmpty: true,
              onRetry: (retryAttempt) => {
                retried = true;
                callbacks.onStatus?.('retry', `Retrying attempt ${retryAttempt}…`);
              },
            },
          )) {
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
            messages = await this.forceCompact(messages, signal, callbacks);
            continue;
          }
          throw error;
        }
      }

      if (toolCalls.length === 0) {
        if (text.trim()) {
          return { reachedLimit: false };
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
          const gate = this.options.finishCheck
            ? await this.options.finishCheck(this.finishCheckSummary(runChangedPaths, recentToolFailures))
            : undefined;
          if (gate && !gate.ok) {
            const firstIssue = gate.issues[0] ?? 'finish check failed';
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
          return { reachedLimit: false, stoppedByLoop: true };
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
      const executeOne = async (call: ToolCall): Promise<void> => {
        callbacks.onToolActivity(call.id, describeToolCall(call), 'running', toolIcon(call.name), activityMeta(call, ''));
        let result: string;
        if (call.name === 'set_reasoning') {
          const args = toolCallArgs(call);
          const level = String(args.level ?? '').trim();
          result = callbacks.setReasoning
            ? callbacks.setReasoning(level)
            : 'Error: changing the reasoning effort is not available in this run.';
        } else if (call.name === 'compress_context') {
          const args = toolCallArgs(call);
          const focus = typeof args.focus === 'string' ? args.focus : undefined;
          if (callbacks.compressContext) {
            try {
              result = await callbacks.compressContext(focus);
            } catch (error) {
              result = `Error: ${error instanceof Error ? error.message : String(error)}`;
            }
          } else {
            result = 'Error: context compression is not available in this run.';
          }
          if (!result.startsWith('Error:')) {
            compressedRecently = true;
          }
        } else {
          try {
            result = await this.toolbox.execute(call.name, call.arguments, {
              requestTerminalApproval: callbacks.requestTerminalApproval,
              requestExternalDirectoryApproval: callbacks.requestExternalDirectoryApproval,
              askUser: callbacks.askUser,
              signal,
              planCheckRequirement: callbacks.planCheckRequirement,
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
      const concurrent = normalizedCalls.filter((call) => PARALLEL_SAFE.has(call.name));
      const sequential = normalizedCalls.filter((call) => !PARALLEL_SAFE.has(call.name));

      if (parallelSafe && concurrent.length > 1) {
        await Promise.all(concurrent.map((call) => executeOne(call)));
      } else {
        for (const call of concurrent) {
          await executeOne(call);
        }
      }
      for (const call of sequential) {
        await executeOne(call);
      }

      for (const call of normalizedCalls) {
        const result = results.get(call.id) ?? 'Error: tool did not run.';
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
          return { reachedLimit: false, stoppedByMistakes: true };
        }

        const loopCheck = this.doomLoop.record(call, progressFor(call));
        if (loopCheck.action === 'stop') {
          callbacks.onNotice?.(loopCheck.message ?? `Stopped: the same tool call (${call.name}) was repeated ${loopCheck.count} times. Possible loop.`);
          return { reachedLimit: false, stoppedByLoop: true };
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
    }

    return { reachedLimit: true };
  }

  private async maybeCompact(
    messages: ChatMessage[],
    signal: AbortSignal,
    callbacks: AgentCallbacks,
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
    try {
      const summary = await summarizeMessages(this.provider, this.model, messages.slice(2, check.recentStart), signal);
      if (!summary) {
        return messages;
      }
      const compacted = buildCompactedMessages(messages, summary, check.recentStart);
      callbacks.onCompaction?.({
        tokensBefore: estimateTokens(messages),
        tokensAfter: estimateTokens(compacted),
        messagesBefore: messages.length,
        messagesAfter: compacted.length,
      });
      return compacted;
    } catch {
      return messages;
    }
  }

  private async forceCompact(
    messages: ChatMessage[],
    signal: AbortSignal,
    callbacks: AgentCallbacks,
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
    try {
      const summary = await summarizeMessages(this.provider, this.model, messages.slice(2, recentStart), signal);
      if (summary) {
        return buildCompactedMessages(messages, summary, recentStart);
      }
    } catch {
      // fall through
    }
    return messages;
  }

  private finishCheckSummary(
    runChangedPaths: Set<string>,
    recentToolFailures: string[],
  ): FinishCheckSummary {
    const snapshot = this.toolbox.adaptiveVerificationSnapshot?.();
    return {
      changedFiles: [...runChangedPaths].map((path) => ({ path, delivered: true })),
      recentToolFailures: [...recentToolFailures],
      newDiagnosticErrors: snapshot?.newDiagnosticErrors ?? 0,
      diagnosticsAvailable: snapshot?.diagnosticsAvailable ?? false,
      verificationRan: snapshot?.verificationRan ?? [],
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

function mutationPaths(call: ToolCall, result: string): string[] {
  if (result.startsWith('Error:') || result.startsWith('Error in')) {
    return [];
  }
  const compound = parseCompoundResult(result);
  if (compound) {
    const applied = compound.status === 'verified' || (compound.status === 'needs_input' && compound.rollbackAvailable);
    if (!applied) {
      return [];
    }
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
  if (call.name === 'apply_change_set') {
    const changes = toolCallArgs(call).changes;
    if (!Array.isArray(changes)) {
      return [];
    }
    const paths: string[] = [];
    for (const entry of changes) {
      if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
        paths.push(String((entry as { path: string }).path));
      }
    }
    return paths;
  }
  if (
    call.name === 'fix_in_file' ||
    call.name === 'fix_diagnostic' ||
    call.name === 'add_import_and_use' ||
    call.name === 'rename_symbol'
  ) {
    const path = String(toolCallArgs(call).path ?? '');
    return path ? [path] : [];
  }
  if (call.name === 'refactor_symbol') {
    const args = toolCallArgs(call);
    const paths: string[] = [];
    for (const key of ['path', 'targetPath'] as const) {
      if (typeof args[key] === 'string' && args[key]) {
        paths.push(String(args[key]));
      }
    }
    return paths;
  }
  return [];
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
