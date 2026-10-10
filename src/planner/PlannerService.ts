import { ChatMessage, LLMProvider, ReasoningOptions, ToolCall, ToolDef, UsageTotals } from '../llm/types';
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
import { estimateTokens } from '../agent/compaction';
import { planFromToolCall, parsePlanFromText } from './planParser';
import { PromptFamily, buildPlannerContext, buildPlannerSystemPrompt } from './prompts';
import { normalizeToolArguments } from '../util/toolArgs';
import { errorMessage } from '../util/errors';
import { chatWithRetry } from '../llm/retry';
import { mergeUsage } from '../llm/usage';

export interface PlannerCallbacks {
  onTextDelta(text: string): void;
  onReasoningDelta?(text: string): void;
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
}

export interface PlannerOptions {
  maxSteps: number;
  tools: ToolDef[];
  rules?: string;
  family?: PromptFamily;
  reasoning?: ReasoningOptions;
  resolveReasoning?: () => ReasoningOptions | undefined;
  reasoningSwitch?: boolean;
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

    for (let step = 0; step < this.options.maxSteps; step++) {
      const { text, toolCalls, reasoning } = await this.runTurn(messages, callbacks, signal, turnTools);
      lastText = text;

      if (toolCalls.length === 0) {
        const parsed = parsePlanFromText(text, version);
        if (parsed) {
          return { plan: parsed, text, exhausted: false };
        }
        if (text.trim()) {
          return { text, exhausted: false };
        }
        return { text, exhausted: false };
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

      for (const call of normalizedCalls) {
        if (call.name === 'submit_plan') {
          const rawPlan = planFromToolCall(call.arguments, version);
          const plan = rawPlan ? this.validateExpectedFiles(rawPlan) : undefined;
          if (plan) {
            submitted = plan;
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: plan ? 'Plan recorded.' : 'Error: invalid plan payload. Provide at least a steps array.',
          });
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
          continue;
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
          reasoning: this.options.resolveReasoning ? this.options.resolveReasoning() : this.options.reasoning,
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
