import { ChatMessage, LLMProvider, ReasoningOptions, ReasoningRouteContext, ToolCall, ToolDef, UsageTotals } from '../llm/types';
import * as fs from 'fs';
import * as path from 'path';
import { Plan } from '../shared/protocol';
import {
  ActivityMeta,
  activityMeta,
  describeToolCall,
  plannerToolSet,
  submitPlanTool,
  toolCallArgs,
  toolIcon,
} from '../agent/tools';
import { PARALLEL_SAFE } from '../agent/parallelTools';
import { estimateTokens } from '../agent/compaction';
import { planFromToolCall, parsePlanFromText } from './planParser';
import { PromptFamily, buildPlannerContext, buildPlannerSystemPrompt } from './prompts';
import { normalizeToolArguments } from '../util/toolArgs';
import { errorMessage } from '../util/errors';
import { chatWithRetry } from '../llm/retry';
import { mergeUsage } from '../llm/usage';
import { checkPlanReadiness } from './planReadiness';

const SPECIAL_TOOLS = new Set(['submit_plan', 'dismiss_plan', 'set_reasoning', 'compress_context', 'ask_user']);
const KEEP_FULL_TOOL_RESULTS = 8;
const STALE_TOOL_RESULT_CHARS = 400;

export interface PlannerCallbacks {
  onTextDelta(text: string): void;
  onReasoningDelta?(text: string): void;
  onStage?(text: string): void;
  onToolActivity(
    id: string,
    label: string,
    status: 'running' | 'done' | 'error',
    icon?: string,
    meta?: ActivityMeta,
  ): void;
  executeTool(call: ToolCall): Promise<string>;
  setReasoning?(level: string): string;
  compressContext?(focus?: string): Promise<string> | string;
  onNotice?(text: string): void;
  onStatus?(id: string, text: string, tone?: 'progress' | 'error', done?: boolean): void;
  onUsage?(tokens: number): void;
  onUsageExact?(usage: UsageTotals): void;
}

export interface PlannerResult {
  plan?: Plan;
  dismissed?: boolean;
  text: string;
  exhausted: boolean;
  stopped?: 'same-plan';
}

export interface PlannerOptions {
  maxSteps: number;
  tools: ToolDef[];
  rules?: string;
  family?: PromptFamily;
  reasoning?: ReasoningOptions;
  resolveReasoning?: (context: ReasoningRouteContext) => ReasoningOptions | undefined;
  reasoningSwitch?: boolean;
  contextLimitTokens?: number;
  workspaceRoot?: string;
}

export class PlannerService {
  constructor(
    private readonly provider: LLMProvider,
    private readonly model: string,
    private readonly options: PlannerOptions,
  ) {}

  async plan(
    conversation: ChatMessage[],
    currentPlan: Plan | null,
    version: number,
    callbacks: PlannerCallbacks,
    signal: AbortSignal,
  ): Promise<PlannerResult> {
    const context = buildPlannerContext(currentPlan);
    const turnTools = plannerToolSet(this.options.tools, { reasoningSwitch: this.options.reasoningSwitch });
    const systemPrompt = [buildPlannerSystemPrompt(this.options.rules, this.options.family), context]
      .filter(Boolean)
      .join('\n\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversation,
    ];

    let lastText = '';
    let submitted: Plan | undefined;
    let dismissed = false;
    let clarificationAsked = false;
    let emptyRecoverySent = false;
    let readinessRejections = 0;
    let readinessNudged = false;
    let previousToolNames: string[] = [];
    let previousToolFailed = false;

    for (let step = 0; step < this.options.maxSteps; step++) {
      if (signal.aborted) {
        const abort = new Error('Aborted');
        abort.name = 'AbortError';
        throw abort;
      }
      trimStaleToolResults(messages);
      callbacks.onStage?.(step === 0
        ? 'PLANNING — waiting for first response…'
        : 'PLANNING — processing tool results…');
      const { text, toolCalls, reasoning } = await this.runTurn(messages, callbacks, signal, turnTools, true, {
        phase: 'planning',
        turn: step,
        previousToolNames,
        previousToolFailed,
      });
      lastText = text;

      if (toolCalls.length === 0) {
        const parsed = parsePlanFromText(text, version);
        if (parsed) {
          return { plan: parsed, text, exhausted: false };
        }
        if (text.trim()) {
          return { text, exhausted: false };
        }
        if (emptyRecoverySent) {
          return { text, exhausted: false };
        }
        // A thinking-only or empty turn is not an answer. Nudge once with a
        // changed prompt instead of ending planning silently.
        emptyRecoverySent = true;
        messages.push({
          role: 'user',
          content: reasoning.trim()
            ? 'You stopped after thinking without answering or calling a tool. Continue now: call the next tool, answer in text, or call submit_plan with what you already have.'
            : 'You returned an empty response. Do not repeat it: answer in text, call one tool, or call submit_plan with what you already have.',
        });
        continue;
      }

      const available = turnTools;
      const normalizedCalls = toolCalls.map((call) => {
        const definition = available.find((tool) => tool.name === call.name) ?? submitPlanTool;
        return { ...call, arguments: normalizeToolArguments(call.arguments, definition.parameters) };
      });
      messages.push({
        role: 'assistant',
        content: text,
        toolCalls: normalizedCalls,
        ...(reasoning ? { reasoning } : {}),
      });

      const genericCalls = normalizedCalls.filter(
        (call) => !SPECIAL_TOOLS.has(call.name) && available.some((tool) => tool.name === call.name),
      );
      let genericResults: Map<string, string> | undefined;
      let turnProgress = false;
      previousToolNames = normalizedCalls.map((call) => call.name);
      previousToolFailed = false;

      for (const call of normalizedCalls) {
        if (call.name === 'submit_plan') {
          const submitArgs = toolCallArgs(call);
          if (submitArgs.needsClarification === true) {
            if (clarificationAsked) {
              messages.push({
                role: 'tool',
                toolCallId: call.id,
                toolName: call.name,
                content: 'Error: one clarification is already pending or was answered. Continue using the answer or make a labeled assumption.',
              });
              continue;
            }
            const clarification = submitArgs.clarification && typeof submitArgs.clarification === 'object'
              ? submitArgs.clarification
              : undefined;
            const question = clarification && typeof clarification.question === 'string'
              ? clarification.question.trim()
              : '';
            if (!question && !(clarification && Array.isArray(clarification.questions) && clarification.questions.length > 0)) {
              messages.push({
                role: 'tool',
                toolCallId: call.id,
                toolName: call.name,
                content: 'Error: needsClarification requires clarification.question or clarification.questions. Do not submit a plan until it is present.',
              });
              continue;
            }
            clarificationAsked = true;
            const askCall: ToolCall = {
              id: `${call.id}:clarification`,
              name: 'ask_user',
              arguments: JSON.stringify(clarification),
            };
            callbacks.onToolActivity(askCall.id, describeToolCall(askCall), 'running', toolIcon(askCall.name));
            let answer: string;
            try {
              answer = await callbacks.executeTool(askCall);
            } catch (error) {
              answer = `Error: ${errorMessage(error)}`;
            }
            callbacks.onToolActivity(
              askCall.id,
              describeToolCall(askCall),
              answer.startsWith('Error:') ? 'error' : 'done',
              toolIcon(askCall.name),
              activityMeta(askCall, answer),
            );
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: `Clarification answer received: ${answer}`,
            });
            continue;
          }
          const rawPlan = planFromToolCall(call.arguments, version);
          const plan = rawPlan ? this.validateExpectedFiles(rawPlan) : undefined;
          const readiness = plan ? checkPlanReadiness(plan) : { ready: false, missing: ['valid plan payload'] };
          if (plan && readiness.ready) {
            submitted = plan;
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: 'Plan recorded.',
            });
            break;
          }
          readinessRejections += 1;
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: `Error: plan is not ready. Provide only the missing fields: ${readiness.missing.join(', ')}.`,
          });
          if (readinessRejections >= 2 && !readinessNudged) {
            readinessNudged = true;
            messages.push({
              role: 'user',
              content:
                'LOOP RECOVERY: submit_plan was rejected twice. Do not gather more context. Call submit_plan now with the missing fields filled in.',
            });
          } else if (readinessNudged) {
            return { text: lastText, exhausted: true, stopped: 'same-plan' };
          }
          continue;
        }
        if (call.name === 'dismiss_plan') {
          dismissed = true;
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: 'Draft plan discarded.',
          });
          break;
        }
        if (call.name === 'set_reasoning') {
          callbacks.onToolActivity(call.id, describeToolCall(call), 'running', toolIcon(call.name));
          const args = toolCallArgs(call);
          const level = String(args.level ?? '').trim();
          const result = callbacks.setReasoning
            ? callbacks.setReasoning(level)
            : 'Error: changing the reasoning effort is not available while planning.';
          callbacks.onToolActivity(
            call.id,
            describeToolCall(call),
            result.startsWith('Error:') ? 'error' : 'done',
            toolIcon(call.name),
            activityMeta(call, result),
          );
          messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result });
          continue;
        }
        if (call.name === 'compress_context') {
          callbacks.onToolActivity(call.id, describeToolCall(call), 'running', toolIcon(call.name));
          const args = toolCallArgs(call);
          const focus = typeof args.focus === 'string' ? args.focus : undefined;
          let result: string;
          if (callbacks.compressContext) {
            try {
              result = await callbacks.compressContext(focus);
            } catch (error) {
              result = `Error: ${errorMessage(error)}`;
            }
          } else {
            result = 'Error: context compression is not available while planning.';
          }
          callbacks.onToolActivity(
            call.id,
            describeToolCall(call),
            result.startsWith('Error:') ? 'error' : 'done',
            toolIcon(call.name),
            activityMeta(call, result),
          );
          messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result });
          continue;
        }
        if (!available.some((tool) => tool.name === call.name)) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: `Error: tool "${call.name}" is not available while planning.`,
          });
          continue;
        }
        if (call.name === 'ask_user') {
          if (clarificationAsked) {
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: 'Error: one focused clarification is already pending or was asked. Continue with an explicit assumption or submit the plan.',
            });
            continue;
          }
          clarificationAsked = true;
          turnProgress = true;
          callbacks.onToolActivity(call.id, describeToolCall(call), 'running', toolIcon(call.name));
          let result: string;
          try {
            result = await callbacks.executeTool(call);
          } catch (error) {
            result = `Error: ${errorMessage(error)}`;
          }
          callbacks.onToolActivity(
            call.id,
            describeToolCall(call),
            result.startsWith('Error:') ? 'error' : 'done',
            toolIcon(call.name),
            activityMeta(call, result),
          );
          messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: result });
          continue;
        }

        // Read-only tools run concurrently: the model usually requests several
        // files in one turn and each round-trip costs a full prompt re-eval.
        if (!genericResults) {
          genericResults = new Map();
          for (const pending of genericCalls) {
            callbacks.onToolActivity(pending.id, describeToolCall(pending), 'running', toolIcon(pending.name));
          }
          const run = async (target: ToolCall): Promise<string> => {
            try {
              return await callbacks.executeTool(target);
            } catch (error) {
              return `Error: ${errorMessage(error)}`;
            }
          };
          const concurrent = genericCalls.filter((pending) => PARALLEL_SAFE.has(pending.name));
          const sequential = genericCalls.filter((pending) => !PARALLEL_SAFE.has(pending.name));
          const settled = await Promise.all(concurrent.map((pending) => run(pending)));
          concurrent.forEach((pending, index) => genericResults!.set(pending.id, settled[index]));
          for (const pending of sequential) {
            genericResults.set(pending.id, await run(pending));
          }
          for (const pending of genericCalls) {
            const result = genericResults.get(pending.id) ?? 'Error: tool did not return a result.';
            if (result.startsWith('Error:')) previousToolFailed = true;
            callbacks.onToolActivity(
              pending.id,
              describeToolCall(pending),
              result.startsWith('Error:') ? 'error' : 'done',
              toolIcon(pending.name),
              activityMeta(pending, result),
            );
          }
          turnProgress = true;
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: genericResults.get(call.id) ?? 'Error: tool did not return a result.',
        });
      }

      if (turnProgress) {
        readinessRejections = 0;
      }
      if (submitted) {
        return { plan: submitted, text, exhausted: false };
      }
      if (dismissed) {
        return { dismissed: true, text: '', exhausted: false };
      }
    }

    return { text: lastText, exhausted: true };
  }

  private validateExpectedFiles(plan: Plan): Plan {
    const root = this.options.workspaceRoot;
    if (!root || !plan.expectedFiles?.length) return plan;
    const expectedFiles = plan.expectedFiles.filter((entry) => {
      if (entry.action === 'add') return true;
      try {
        return fs.existsSync(path.join(root, entry.path));
      } catch {
        return false;
      }
    });
    return { ...plan, expectedFiles: expectedFiles.length > 0 ? expectedFiles : undefined };
  }

  private async runTurn(
    messages: ChatMessage[],
    callbacks: PlannerCallbacks,
    signal: AbortSignal,
    tools: ToolDef[],
    streamOutput = true,
    routeContext?: ReasoningRouteContext,
  ): Promise<{ text: string; toolCalls: ToolCall[]; reasoning: string }> {
    let text = '';
    let reasoning = '';
    let usage: UsageTotals | undefined;
    const toolCalls: ToolCall[] = [];
    let retried = false;
    callbacks.onUsage?.(estimateTokens(messages));
    try {
      for await (const event of chatWithRetry(
        this.provider,
        messages,
        {
          model: this.model,
          tools: tools.length > 0 ? tools : undefined,
          signal,
          reasoning: this.options.resolveReasoning
            ? this.options.resolveReasoning(routeContext ?? { phase: 'planning', turn: 0 })
            : this.options.reasoning,
          contextTokens: this.options.contextLimitTokens,
        },
        {
          retryOnEmpty: true,
          onRetry: (attempt) => {
            retried = true;
            callbacks.onStatus?.('retry', `Retrying attempt ${attempt}…`);
          },
        },
      )) {
        if (event.type === 'text') {
          text += event.text;
          if (streamOutput) callbacks.onTextDelta(event.text);
        } else if (event.type === 'reasoning') {
          reasoning += event.text;
          if (streamOutput) callbacks.onReasoningDelta?.(event.text);
        } else if (event.type === 'toolCall') {
          toolCalls.push(event.toolCall);
        } else if (event.type === 'usage') {
          usage = mergeUsage(usage, event);
        }
      }
      if (usage) {
        callbacks.onUsageExact?.(usage);
      }
    } finally {
      if (retried) {
        callbacks.onStatus?.('retry', '', undefined, true);
      }
    }
    return { text, toolCalls, reasoning };
  }

}

/** Keep the newest tool results intact; older ones only inflate prompt eval. */
function trimStaleToolResults(messages: ChatMessage[]): void {
  const toolIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'tool') {
      toolIndexes.push(index);
    }
  }
  if (toolIndexes.length <= KEEP_FULL_TOOL_RESULTS) {
    return;
  }
  for (const index of toolIndexes.slice(0, toolIndexes.length - KEEP_FULL_TOOL_RESULTS)) {
    const message = messages[index];
    if (message.content.length > STALE_TOOL_RESULT_CHARS) {
      messages[index] = {
        ...message,
        content: `${message.content.slice(0, STALE_TOOL_RESULT_CHARS)}\n… [earlier result trimmed to keep planning fast]`,
      };
    }
  }
}
