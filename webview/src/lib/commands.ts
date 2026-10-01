import type { CommandInfo } from '../../../src/shared/protocol';

export function slashQuery(text: string): string | null {
  const match = /^\/([a-zA-Z0-9_-]*)$/.exec(text);
  return match ? match[1] : null;
}

export function filterCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const normalized = query.toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(normalized));
}
