import { LLMProvider, ToolDef } from '../llm/types';
import { Plan } from '../shared/protocol';
import { AgentService } from './AgentService';
import { ToolBox } from './ToolBox';
import { PromptFamily } from '../planner/prompts';
import { DEFAULT_CONTEXT_LIMIT } from './compaction';

export const SUBAGENT_MAX_STEPS = 20;
export const SUBAGENT_TYPES = ['explore'] as const;

export interface SubagentRequest {
  description: string;
  prompt: string;
  subagentType?: string;
}

export interface SubagentDeps {
  provider: LLMProvider;
  model: string;
  toolbox: ToolBox;
  tools: ToolDef[];
  rules?: string;
  family?: PromptFamily;
  signal: AbortSignal;
}

export function normalizeSubagentType(value: unknown): string {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return type || 'explore';
}

export async function runSubagent(request: SubagentRequest, deps: SubagentDeps): Promise<string> {
  const type = normalizeSubagentType(request.subagentType);
  if (!(SUBAGENT_TYPES as readonly string[]).includes(type)) {
    return `Error: unknown subagent type "${request.subagentType}". Available: ${SUBAGENT_TYPES.join(', ')}.`;
  }
  const prompt = request.prompt.trim();
  if (!prompt) {
    return 'Error: a prompt is required for the subagent.';
  }
  let text = '';
  const plan: Plan = {
    version: 1,
    status: 'approved',
    title: request.description.trim() || 'Subagent task',
    steps: [],
  };
  const agent = new AgentService(deps.provider, deps.model, deps.toolbox, {
    maxSteps: SUBAGENT_MAX_STEPS,
    tools: deps.tools,
    rules: deps.rules,
    family: deps.family,
    autoCompact: false,
    contextLimitTokens: DEFAULT_CONTEXT_LIMIT,
  });
  const result = await agent.run(plan, prompt, deps.signal, {
    onTextDelta: (delta) => {
      text += delta;
    },
    onToolActivity: (_id, _label, status) => {
      if (status === 'running') {
        text = '';
      }
    },
    requestTerminalApproval: async () => 'deny',
    askUser: async () => 'The developer is unavailable; choose the most reasonable option and continue.',
  });
  const summary = result.summary?.trim() || text.trim();
  return summary || 'The subagent returned no findings.';
}
