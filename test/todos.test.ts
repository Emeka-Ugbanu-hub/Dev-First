import { describe, expect, it } from 'vitest';
import { findNewlyStartedTodos, mergeTodoCheckpoints } from '../src/util/todos';
import { TodoItem } from '../src/shared/protocol';

function todo(text: string, status: TodoItem['status'], checkpointId?: string): TodoItem {
  return { text, status, checkpointId };
}

describe('findNewlyStartedTodos', () => {
  it('finds a todo that just flipped to in_progress', () => {
    const previous = [todo('one', 'done'), todo('two', 'pending')];
    const next = [todo('one', 'done'), todo('two', 'in_progress')];
    expect(findNewlyStartedTodos(previous, next)).toEqual([1]);
  });

  it('ignores already-running todos', () => {
    const previous = [todo('one', 'in_progress')];
    const next = [todo('one', 'in_progress')];
    expect(findNewlyStartedTodos(previous, next)).toEqual([]);
  });

  it('handles a fresh list', () => {
    expect(findNewlyStartedTodos([], [todo('one', 'in_progress')])).toEqual([0]);
  });
});

describe('mergeTodoCheckpoints', () => {
  it('carries checkpoint ids across updates by text', () => {
    const previous = [todo('one', 'in_progress', 'cp_1')];
    const next = [todo('one', 'done')];
    expect(mergeTodoCheckpoints(previous, next)[0].checkpointId).toBe('cp_1');
  });

  it('does not leak checkpoints to different todos', () => {
    const previous = [todo('one', 'done', 'cp_1')];
    const next = [todo('two', 'in_progress')];
    expect(mergeTodoCheckpoints(previous, next)[0].checkpointId).toBeUndefined();
  });
});
