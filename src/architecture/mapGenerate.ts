import type {
  ChatMessage,
  LLMProvider,
  ToolCall,
  ToolDef,
} from '../llm/types';
import { describeToolCall } from '../agent/tools';
import { normalizeToolArguments } from '../util/toolArgs';
import { errorMessage } from '../util/errors';

export interface MapGenerateDeps {
  provider: LLMProvider;
  model: string;
  tools: ToolDef[];
  executeTool: (call: ToolCall) => Promise<string>;
  signal: AbortSignal;
  maxSteps?: number;
  onProgress?: (text: string, done?: boolean) => void;
}

export const MAP_SYSTEM_PROMPT = `You are a software architect. The digest below is supporting context, not the whole picture.
Explore this codebase however you think is best to understand how it actually works.
Base every label and arrow on what you read. Trust files over the digest.

Your diagram exists so a developer who has never seen this codebase can look at it
and understand how it works. Preserve the structural understanding: the layers,
the components, their responsibilities, and how data moves between them. The result
should read like a clear explanation of the architecture, not a list of files.

Then respond with a single JSON object only (no prose, no code fences, no markdown):
{"nodes":[{"id":"ui","label":"Components","group":"Frontend","path":"src/components"}],"edges":[{"from":"ui","to":"api","label":"calls"}]}

Rules:
- Build the hierarchy with groups for the main areas (Frontend, Backend, Services, Database, External Services...). A group name is 1-3 words. Groups may nest with "/" (for example "Backend/Services") when it makes the architecture clearer.
- Every node must belong to a group. Keep each group to at most 7 nodes; when a group grows bigger, split it into nested subgroups ("Frontend/Screens", "Frontend/Shell", "Frontend/Components"). Aim for a Project -> area -> sub-area -> component hierarchy of 2-3 levels.
- One root node named after the project, connected to the main areas.
- Real components of THIS codebase as nodes; label every node yourself, 1-3 words; labels only, no descriptions.
- Edge labels describe behavior: reads, writes, calls, sends, emits, queries, returns. Show data movement between UI, backend, database, external APIs.
- Mark entry points, database/storage, and external services explicitly through their labels or groups.
- Never invent files, components, or services not supported by what you read. Omit rather than guess.
- Each node may include a "path": a real folder or file relative to the project root that represents that node. Only include paths you actually saw. Omit the field when unsure.
- Keep it readable: at most 40 nodes and 60 edges.
- ids are short lowercase identifiers; every edge must reference existing node ids.
- Output the JSON object only — nothing before or after it.`;

const DEFAULT_MAX_STEPS = 30;

interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  reasoning: string;
}

async function runTurn(
  messages: ChatMessage[],
  deps: MapGenerateDeps,
): Promise<TurnResult> {
  let text = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  for await (const event of deps.provider.chat(messages, {
    model: deps.model,
    tools: deps.tools.length > 0 ? deps.tools : undefined,
    signal: deps.signal,
  })) {
    if (event.type === 'text') {
      text += event.text;
    } else if (event.type === 'reasoning') {
      reasoning += event.text;
    } else if (event.type === 'toolCall') {
      toolCalls.push(event.toolCall);
    }
  }
  return { text, toolCalls, reasoning };
}

function normalizeCall(call: ToolCall, tools: ToolDef[]): ToolCall {
  const definition = tools.find((tool) => tool.name === call.name);
  if (!definition) {
    return call;
  }
  return {
    ...call,
    arguments: normalizeToolArguments(call.arguments, definition.parameters),
  };
}

export async function generateArchitectureMap(
  digest: string,
  deps: MapGenerateDeps,
): Promise<string | undefined> {
  const maxSteps = deps.maxSteps && deps.maxSteps > 0 ? deps.maxSteps : DEFAULT_MAX_STEPS;
  const messages: ChatMessage[] = [
    { role: 'system', content: MAP_SYSTEM_PROMPT },
    { role: 'user', content: digest },
  ];

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (deps.signal.aborted) {
        return undefined;
      }
      const { text, toolCalls, reasoning } = await runTurn(messages, deps);
      if (toolCalls.length === 0) {
        deps.onProgress?.('Architecture map ready', true);
        return text;
      }

      const normalizedCalls = toolCalls.map((call) => normalizeCall(call, deps.tools));
      messages.push({
        role: 'assistant',
        content: text,
        toolCalls: normalizedCalls,
        ...(reasoning ? { reasoning } : {}),
      });

      for (const call of normalizedCalls) {
        if (deps.signal.aborted) {
          return undefined;
        }
        deps.onProgress?.(describeToolCall(call));
        let result: string;
        try {
          result = await deps.executeTool(call);
        } catch (error) {
          result = `Error: ${errorMessage(error)}`;
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: result,
        });
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
