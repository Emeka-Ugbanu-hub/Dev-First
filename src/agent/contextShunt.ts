import type { ChatMessage, LLMProvider } from '../llm/types';
import { chatWithRetry } from '../llm/retry';

/** Start shunting only when direct context would be large enough to matter. */
export const CONTEXT_SHUNT_BYTES = 32 * 1024;
// Avoid loading very large files into memory just to summarize them. Larger
// reads fall through to the existing bounded/ranged file reader instead.
export const CONTEXT_SHUNT_MAX_BYTES = 256 * 1024;
export const CONTEXT_SHUNT_MAX_OUTPUT = 1_200;

export interface ContextShuntInput {
  path: string;
  text: string;
  hash: string;
  signal?: AbortSignal;
}

export interface ContextShunt {
  summarize(input: ContextShuntInput): Promise<string | undefined>;
}

export async function summarizeWithWorker(
  provider: LLMProvider,
  model: string,
  input: ContextShuntInput,
): Promise<string | undefined> {
  const numbered = input.text
    .split(/\r?\n/)
    .map((line, index) => `${index + 1} | ${line}`)
    .join('\n');
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a read-only context worker for a coding agent.',
        'Summarize the supplied file for another model. Do not propose edits and do not invent code.',
        'Preserve important symbols, imports, control flow, side effects, configuration, and likely change points.',
        'Include exact line ranges for every important claim. End with unresolved questions and omitted ranges.',
        'Keep the response under 1200 tokens.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `File: ${input.path}\nContent hash: ${input.hash}\n\n${numbered}`,
    },
  ];
  let summary = '';
  try {
    for await (const event of chatWithRetry(
      provider,
      messages,
      {
        model,
        maxTokens: CONTEXT_SHUNT_MAX_OUTPUT,
        signal: input.signal,
        reasoning: { enabled: false, effort: 'off' },
      },
      { retryOnEmpty: false },
    )) {
      if (event.type === 'text') summary += event.text;
    }
  } catch {
    return undefined;
  }
  const trimmed = summary.trim();
  return trimmed
    ? `[CONTEXT SHUNT — ${input.path} — hash ${input.hash}]\n${trimmed}\n[END CONTEXT SHUNT]\nRead exact line ranges before editing.`
    : undefined;
}
