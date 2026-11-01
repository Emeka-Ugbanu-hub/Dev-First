import { ChatMessage } from './types';

/**
 * Keep provider-facing transcripts compatible with strict local templates.
 * Some Ollama/llama.cpp templates only accept one system message at index 0.
 * Dev-First may add system context during planning, compaction, or recovery,
 * so merge those blocks before serializing the request.
 */
export function consolidateSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  const system: string[] = [];
  const rest: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const content = message.content.trim();
      if (content && system[system.length - 1] !== content) {
        system.push(content);
      }
    } else {
      rest.push(message);
    }
  }
  if (system.length === 0) {
    return rest.length === messages.length ? messages : rest;
  }
  return [{ role: 'system', content: system.join('\n\n') }, ...rest];
}
