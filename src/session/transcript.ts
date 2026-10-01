import { UiMessage } from '../shared/protocol';

export function buildTranscript(messages: UiMessage[], title: string, date: Date): string {
  const lines = [
    `# ${title}`,
    '',
    `_Exported ${date.toISOString().slice(0, 16).replace('T', ' ')}_`,
    '',
  ];
  for (const message of messages) {
    if (message.role === 'notice' || !message.text.trim()) {
      continue;
    }
    lines.push(message.role === 'user' ? '## You' : '## Dev-First', '', message.text.trim(), '');
  }
  return lines.join('\n');
}
