import type { ChatMessage, LLMProvider } from '../llm/types';
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

export type ModelMessageRoute = 'smalltalk' | 'acknowledgement' | 'question' | 'answer' | 'refine-plan' | 'cancel-plan' | 'continue-task' | 'new-task';

const ROUTES = new Set<ModelMessageRoute>([
  'smalltalk', 'acknowledgement', 'question', 'answer', 'refine-plan', 'cancel-plan', 'continue-task', 'new-task',
]);

const ROUTER_PROMPT = `Classify the latest developer message for the current Dev-First task. Return JSON only: {"route":"...","response":"..."}. Allowed routes: smalltalk (greeting or casual conversation), acknowledgement (brief confirmation or thanks), question (asks about the codebase or a general explanation), answer (asks for an explanation while an existing task is active), refine-plan (changes the current draft plan), cancel-plan (discards the current draft), continue-task (steers or supplies information for the current task), new-task (unrelated request or a new change). Use the latest message and current plan/state; do not infer from single words alone. For smalltalk or acknowledgement, include a short natural response. For other routes, response may be empty.`;

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
  const messages: ChatMessage[] = [
    { role: 'system', content: ROUTER_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        message: text,
        taskState: {
          state: state.state,
          taskSummary: state.taskSummary,
          completedSteps: state.completedSteps,
          nextSteps: state.nextSteps,
          blockers: state.blockers,
        },
        draftPlan: plan?.status === 'draft' ? {
          title: plan.title,
          steps: plan.steps,
          expectedFiles: plan.expectedFiles?.map((file) => file.path),
        } : undefined,
      }),
    },
  ];
  let raw = '';
  try {
    for await (const event of chatWithRetry(provider, messages, {
      model,
      temperature: 0,
      maxTokens: 32,
      reasoning: { enabled: false },
      signal,
    }, { attempts: 1, retryOnEmpty: false })) {
      if (event.type === 'text') raw += event.text;
    }
  } catch {
    return undefined;
  }
  const parsed = parseJsonLoose(raw) as { route?: unknown; response?: unknown } | undefined;
  return typeof parsed?.route === 'string' && ROUTES.has(parsed.route as ModelMessageRoute)
    ? { route: parsed.route as ModelMessageRoute, response: typeof parsed.response === 'string' ? parsed.response.trim() : undefined }
    : undefined;
}

