import type { ChatMessage, LLMProvider, ToolCall, ToolDef } from '../llm/types';
import { chatWithRetry } from '../llm/retry';
import { parseJsonLoose } from '../util/json';
import type { DurableTaskState, Plan, TaskRouteEvent } from '../shared/protocol';

export type IncomingRoute = TaskRouteEvent['route'];

export function classifyIncomingMessage(
  _text: string,
  state: DurableTaskState,
  active: boolean,
): IncomingRoute {
  if (!active) return 'new-task';
  // This is only a safe fallback. The model route below is authoritative when
  // a task is active; preserving the message as a follow-up is safer than
  // guessing from words and dropping a legitimate refinement.
  void state;
  return 'follow-up';
}

export type ModelMessageRoute = 'smalltalk' | 'acknowledgement' | 'question' | 'answer' | 'refine-plan' | 'cancel-plan' | 'continue-task' | 'needs-clarification' | 'new-task';

const ROUTES = new Set<ModelMessageRoute>([
  'smalltalk', 'acknowledgement', 'question', 'answer', 'refine-plan', 'cancel-plan', 'continue-task', 'needs-clarification', 'new-task',
]);

const ROUTER_PROMPT = `Classify the latest developer message for the current Dev-First task. Call classify_route exactly once. Do not answer the developer and do not emit prose. Use the message meaning and current task state, not single keyword matches. Routes: smalltalk (greeting/casual conversation), acknowledgement (brief confirmation/thanks), question (codebase or general explanation), answer (explanation while an existing task is active), refine-plan (changes the current draft plan), cancel-plan (discards the current draft), continue-task (steers the current task), needs-clarification (the request is genuinely ambiguous and needs one decision), new-task (unrelated change request).`;

const ROUTE_TOOL: ToolDef = {
  name: 'classify_route',
  description: 'Return the single route for the latest developer message.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      route: {
        type: 'string',
        enum: ['smalltalk', 'acknowledgement', 'question', 'answer', 'refine-plan', 'cancel-plan', 'continue-task', 'needs-clarification', 'new-task'],
      },
      response: { type: 'string', description: 'Short reply only for smalltalk or acknowledgement; otherwise empty.' },
    },
    required: ['route'],
  },
};

export interface ModelRouteDecision {
  route: ModelMessageRoute;
  response?: string;
}

export async function classifyMessageRoute(
  provider: LLMProvider,
  model: string,
  text: string,
  state: DurableTaskState,
  plan: Plan | null | undefined,
  signal?: AbortSignal,
): Promise<ModelRouteDecision | undefined> {
  const request = JSON.stringify({
    message: text.slice(0, 2000),
    taskState: {
      state: state.state,
      taskSummary: state.taskSummary?.slice(0, 500),
      completedSteps: state.completedSteps.slice(-8),
      nextSteps: state.nextSteps.slice(0, 8),
      blockers: state.blockers.slice(-4),
    },
    draftPlan: plan?.status === 'draft' ? {
      title: plan.title,
      steps: plan.steps?.slice(0, 8),
      expectedFiles: plan.expectedFiles?.slice(0, 12).map((file) => file.path),
    } : undefined,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: ChatMessage[] = [
      { role: 'system', content: ROUTER_PROMPT },
      { role: 'user', content: request },
      ...(attempt > 0 ? [{ role: 'user' as const, content: 'The previous route result was invalid. Call classify_route with one allowed route now.' }] : []),
    ];
    let raw = '';
    let decision: ModelRouteDecision | undefined;
    try {
      for await (const event of chatWithRetry(provider, messages, {
        model,
        tools: [ROUTE_TOOL],
        temperature: 0,
        maxTokens: 48,
        reasoning: { enabled: false },
        signal,
      }, { attempts: 1, retryOnEmpty: false })) {
        if (event.type === 'text') raw += event.text;
        if (event.type === 'toolCall' && event.toolCall.name === ROUTE_TOOL.name) {
          decision = parseRouteArguments(event.toolCall);
        }
      }
    } catch {
      continue;
    }
    if (!decision) {
      const parsed = parseJsonLoose(raw) as { route?: unknown; response?: unknown } | undefined;
      if (typeof parsed?.route === 'string' && ROUTES.has(parsed.route as ModelMessageRoute)) {
        decision = { route: parsed.route as ModelMessageRoute, response: typeof parsed.response === 'string' ? parsed.response.trim() : undefined };
      }
    }
    if (decision) return decision;
  }
  return undefined;
}

function parseRouteArguments(call: ToolCall): ModelRouteDecision | undefined {
  const parsed = parseJsonLoose(call.arguments) as { route?: unknown; response?: unknown } | undefined;
  return typeof parsed?.route === 'string' && ROUTES.has(parsed.route as ModelMessageRoute)
    ? { route: parsed.route as ModelMessageRoute, response: typeof parsed.response === 'string' ? parsed.response.trim() : undefined }
    : undefined;
}

