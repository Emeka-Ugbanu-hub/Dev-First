import type { ChatMessage, LLMProvider, ToolCall, ToolDef } from '../llm/types';
import { chatWithRetry } from '../llm/retry';
import { parseJsonLoose } from '../util/json';
import type { ContinuationKind, DurableTaskState, LastAnswerState, Plan, PlanningMode, TaskRouteEvent } from '../shared/protocol';

export type IncomingRoute = TaskRouteEvent['route'];

export function classifyIncomingMessage(
  text: string,
  state: DurableTaskState,
  active: boolean,
): IncomingRoute {
  // The provider route probe is authoritative when available. If it cannot
  // run (cold model, connection failure, or a provider without tool calls),
  // preserve the legacy safe fallback: let the planner handle the request
  // rather than silently treating an implementation request as an answer.
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

const ROUTER_PROMPT = `Classify the latest developer message for the current Dev-First task. Call classify_route exactly once. Do not answer the developer and do not emit prose. Use the message meaning and current task state, not keyword matching. Return both route and intent. intent is question for information/explanation/inspection, change for implementation or plan work, and conversation for greetings/acknowledgements/casual talk. Routes: smalltalk (greeting/casual conversation), acknowledgement (brief confirmation/thanks), question (codebase or general explanation), answer (explanation while an existing task is active), refine-plan (changes the current draft plan), cancel-plan (discards the current draft), continue-task (steers the current task), needs-clarification (the request is genuinely ambiguous and needs one decision), new-task (unrelated change request). For intent=change, also set mode to the smallest safe planningMode: skip for one explicit low-risk operation, lite for a small known change, spec for a normal change, full for architecture or high-risk work. For question/answer routes, optionally return answerCoverage only when the developer asks for a detailed, long, or multi-part explanation. Make it a concise list of the requested topics to cover, not an implementation plan; do not invent topics. Omit it for a simple question. A pure request for explanation or information remains question/answer and must not create a plan. Do not infer change intent merely because an explanatory sentence contains words such as fix, add, or update.`;

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
      mode: {
        type: 'string',
        enum: ['skip', 'lite', 'spec', 'full'],
        description: 'Smallest safe planning mode for a change request; omit for questions, answers, smalltalk, or acknowledgements.',
      },
      response: { type: 'string', description: 'Short reply only for smalltalk or acknowledgement; otherwise empty.' },
      intent: { type: 'string', enum: ['question', 'change', 'conversation'], description: 'Semantic intent independent of the route label.' },
      answerCoverage: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string' },
        description: 'Optional concise coverage checklist for a detailed question or explanation. Omit for simple questions and non-question routes.',
      },
    },
    required: ['route', 'intent'],
  },
};

export interface ModelRouteDecision {
  route: ModelMessageRoute;
  mode?: PlanningMode;
  response?: string;
  intent?: 'question' | 'change' | 'conversation';
  answerCoverage?: string[];
}

export interface RouteContext {
  continuationKind?: ContinuationKind;
  continuationStatus?: string;
  lastAnswerStatus?: LastAnswerState['status'];
  lastAnswerQuestion?: string;
}

export async function classifyMessageRoute(
  provider: LLMProvider,
  model: string,
  text: string,
  state: DurableTaskState,
  plan: Plan | null | undefined,
  signal?: AbortSignal,
  contextTokens?: number,
  routeContext?: RouteContext,
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
    continuation: routeContext?.continuationKind ? {
      kind: routeContext.continuationKind,
      status: routeContext.continuationStatus,
    } : undefined,
    lastAnswer: routeContext?.lastAnswerStatus ? {
      status: routeContext.lastAnswerStatus,
      question: routeContext.lastAnswerQuestion?.slice(0, 300),
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
        maxTokens: 96,
        reasoning: { enabled: false },
        signal,
        ...(contextTokens ? { contextTokens } : {}),
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
      const parsed = parseJsonLoose(raw) as { route?: unknown; mode?: unknown; response?: unknown; intent?: unknown; answerCoverage?: unknown } | undefined;
      if (typeof parsed?.route === 'string' && ROUTES.has(parsed.route as ModelMessageRoute)) {
        decision = {
          route: parsed.route as ModelMessageRoute,
          ...(isPlanningMode(parsed.mode) ? { mode: parsed.mode } : {}),
          response: typeof parsed.response === 'string' ? parsed.response.trim() : undefined,
          intent: isIntent(parsed.intent) ? parsed.intent : intentForRoute(parsed.route as ModelMessageRoute),
          answerCoverage: parseAnswerCoverage(parsed.answerCoverage),
        };
      }
    }
    if (decision) return normalizeRoute(decision);
  }
  return undefined;
}

function normalizeRoute(decision: ModelRouteDecision): ModelRouteDecision {
  if (decision.intent === 'question' && (decision.route === 'new-task' || decision.route === 'refine-plan')) {
    return { ...decision, route: 'question', mode: undefined };
  }
  if (decision.intent === 'change' && (decision.route === 'question' || decision.route === 'answer')) {
    return { ...decision, route: 'new-task', mode: decision.mode ?? 'spec' };
  }
  if (decision.intent === 'conversation' && decision.route === 'new-task') {
    return { ...decision, route: 'smalltalk', mode: undefined };
  }
  return decision;
}

function isPlanningMode(value: unknown): value is PlanningMode {
  return value === 'skip' || value === 'lite' || value === 'spec' || value === 'full';
}

function parseRouteArguments(call: ToolCall): ModelRouteDecision | undefined {
  const parsed = parseJsonLoose(call.arguments) as { route?: unknown; mode?: unknown; response?: unknown; intent?: unknown; answerCoverage?: unknown } | undefined;
  if (typeof parsed?.route !== 'string' || !ROUTES.has(parsed.route as ModelMessageRoute)) {
    return undefined;
  }
  return {
    route: parsed.route as ModelMessageRoute,
    ...(isPlanningMode(parsed.mode) ? { mode: parsed.mode } : {}),
    response: typeof parsed.response === 'string' ? parsed.response.trim() : undefined,
    answerCoverage: parseAnswerCoverage(parsed.answerCoverage),
    // Small local models frequently omit intent even when the route is
    // correct. Infer it from the route instead of discarding the whole route.
    intent: isIntent(parsed.intent) ? parsed.intent : intentForRoute(parsed.route as ModelMessageRoute),
  };
}

function parseAnswerCoverage(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((item) => item.slice(0, 160));
  return items.length > 0 ? items : undefined;
}

function intentForRoute(route: ModelMessageRoute): NonNullable<ModelRouteDecision['intent']> {
  switch (route) {
    case 'smalltalk':
    case 'acknowledgement':
      return 'conversation';
    case 'question':
    case 'answer':
    case 'needs-clarification':
      return 'question';
    default:
      return 'change';
  }
}

function isIntent(value: unknown): value is ModelRouteDecision['intent'] {
  return value === 'question' || value === 'change' || value === 'conversation';
}

