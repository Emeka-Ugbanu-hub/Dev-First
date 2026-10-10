import type { QueuedPromptRecord } from '../../../src/shared/protocol';

export function queueStatusLabel(status: QueuedPromptRecord['status']): string | null {
  if (status === 'queued') return 'Queued';
  if (status === 'running') return 'Running';
  if (status === 'paused') return 'Paused';
  if (status === 'cancelled') return 'Cancelled';
  return null;
}
