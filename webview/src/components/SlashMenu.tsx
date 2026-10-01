import type { CommandInfo } from '../../../src/shared/protocol';
import { filterCommands } from '../lib/commands';

export function SlashMenu({
  commands,
  query,
  onPick,
}: {
  commands: CommandInfo[];
  query: string;
  onPick: (name: string) => void;
}) {
  const all = [
    { name: 'review', description: 'Review changes — uncommitted, staged, branch, or commit' },
    ...commands.filter((command) => command.name !== 'review'),
  ];
  const filtered = filterCommands(all, query);
  if (filtered.length === 0) {
    return null;
  }
  const builtin = filtered.filter((command) => command.name === 'review');
  const custom = filtered.filter((command) => command.name !== 'review');
  return (
    <div className="slash-menu" role="listbox" aria-label="Commands">
      {builtin.length > 0 && (
        <div className="slash-group" role="presentation">
          BUILT-IN
        </div>
      )}
      {builtin.map((command) => (
        <button
          key={command.name}
          className="slash-item"
          role="option"
          aria-selected={false}
          onClick={() => onPick(command.name)}
        >
          <span className="codicon codicon-terminal-cmd" />
          <span className="slash-name">/{command.name}</span>
          {command.description && <span className="slash-desc">{command.description}</span>}
        </button>
      ))}
      {custom.length > 0 && (
        <div className="slash-group" role="presentation">
          COMMANDS
        </div>
      )}
      {custom.slice(0, 8).map((command) => (
        <button
          key={command.name}
          className="slash-item"
          role="option"
          aria-selected={false}
          onClick={() => onPick(command.name)}
        >
          <span className="codicon codicon-terminal-cmd" />
          <span className="slash-name">/{command.name}</span>
          {command.description && <span className="slash-desc">{command.description}</span>}
        </button>
      ))}
    </div>
  );
}
