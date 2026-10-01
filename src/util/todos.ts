import { TodoItem } from '../shared/protocol';

export function mergeTodoCheckpoints(previous: TodoItem[], next: TodoItem[]): TodoItem[] {
  return next.map((todo) => {
    const prior = previous.find((item) => item.text === todo.text);
    return prior?.checkpointId ? { ...todo, checkpointId: prior.checkpointId } : todo;
  });
}

export function findNewlyStartedTodos(previous: TodoItem[], next: TodoItem[]): number[] {
  const indexes: number[] = [];
  next.forEach((todo, index) => {
    if (todo.status !== 'in_progress') {
      return;
    }
    const prior = previous.find((item) => item.text === todo.text);
    if (!prior || prior.status !== 'in_progress') {
      indexes.push(index);
    }
  });
  return indexes;
}
