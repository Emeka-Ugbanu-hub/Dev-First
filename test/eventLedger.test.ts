import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventLedger } from '../src/session/EventLedger';

describe('EventLedger', () => {
  it('projects durable route and state events into a compact checkpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dev-first-ledger-'));
    try {
      const ledger = new EventLedger(root, 'session-a');
      ledger.setTask('task-a');
      ledger.append('route', { route: 'question', stateBefore: 'idle', stateAfter: 'idle' });
      ledger.append('state', { state: 'idle', completedSteps: [0], nextSteps: [1], blockers: ['needs test'] });
      ledger.append('tool', { tool: 'edit_file', status: 'succeeded', changedFiles: ['src/a.ts'] });
      const text = ledger.condensed();
      expect(text).toContain('Last route: question');
      expect(text).toContain('Completed steps: 0');
      expect(text).toContain('Changed files: src/a.ts');

      await ledger.flush();
      const restored = new EventLedger(root, 'session-a');
      await restored.hydrate();
      expect(restored.condensed()).toContain('Last route: question');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
