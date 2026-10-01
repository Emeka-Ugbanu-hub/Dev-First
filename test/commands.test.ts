import { describe, expect, it } from 'vitest';
import { filterCommands, slashQuery } from '../webview/src/lib/commands';

describe('slashQuery', () => {
  it('matches while typing a command name', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/rev')).toBe('rev');
    expect(slashQuery('/review-my-code')).toBe('review-my-code');
  });

  it('stops matching once arguments are typed', () => {
    expect(slashQuery('/review the auth flow')).toBeNull();
    expect(slashQuery('hello')).toBeNull();
    expect(slashQuery(' /review')).toBeNull();
  });
});

describe('filterCommands', () => {
  const commands = [
    { name: 'review', description: 'Review the current changes' },
    { name: 'refactor', description: 'Refactor a file' },
    { name: 'test', description: 'Write tests' },
  ];

  it('returns all commands for an empty query', () => {
    expect(filterCommands(commands, '')).toHaveLength(3);
  });

  it('filters by prefix, case-insensitively', () => {
    expect(filterCommands(commands, 're').map((command) => command.name)).toEqual(['review', 'refactor']);
    expect(filterCommands(commands, 'REF')).toEqual([commands[1]]);
  });

  it('returns nothing when no command matches', () => {
    expect(filterCommands(commands, 'zzz')).toEqual([]);
  });
});
