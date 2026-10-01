import { ChatMessage, LLMProvider } from '../llm/types';

export const COMPLETION_SYSTEM_PROMPT =
  'You are a code completion engine. Output ONLY the code that belongs at the cursor — no explanations, no markdown fences, at most 3 short lines. If you are not confident, output nothing at all.';

export function buildCompletionMessages(prefix: string, suffix: string): ChatMessage[] {
  const trimmedPrefix = prefix.slice(-1000);
  const trimmedSuffix = suffix.slice(0, 400);
  return [
    { role: 'system', content: COMPLETION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Code before the cursor:\n\`\`\`\n${trimmedPrefix}\n\`\`\`\n\nCode after the cursor:\n\`\`\`\n${trimmedSuffix}\n\`\`\`\n\nWrite only the missing code that belongs between them.`,
    },
  ];
}

export function cleanCompletion(text: string): string | undefined {
  let cleaned = text.trim();
  if (!cleaned) {
    return undefined;
  }
  cleaned = cleaned.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '');
  const lines = cleaned.split('\n').slice(0, 3);
  const result = lines.join('\n').trimEnd();
  return result.trim() ? result : undefined;
}

export async function fetchChatCompletion(
  provider: LLMProvider,
  model: string,
  prefix: string,
  suffix: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const messages = buildCompletionMessages(prefix, suffix);
  let text = '';
  for await (const event of provider.chat(messages, {
    model,
    maxTokens: 128,
    temperature: 0.2,
    signal,
  })) {
    if (event.type === 'text') {
      text += event.text;
    }
  }
  return cleanCompletion(text);
}
