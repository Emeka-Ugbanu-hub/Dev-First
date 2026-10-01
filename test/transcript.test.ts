import { describe, expect, it } from 'vitest';
import { buildTranscript } from '../src/session/transcript';
import { UiMessage } from '../src/shared/protocol';

function message(overrides: Partial<UiMessage>): UiMessage {
  return { id: 'm1', role: 'user', text: 'hello', ...overrides };
}

describe('buildTranscript', () => {
  it('renders title, date, and role sections', () => {
    const output = buildTranscript(
      [message({ text: 'do it' }), message({ id: 'm2', role: 'assistant', text: 'done' })],
      'Fix the bug',
      new Date('2026-09-18T10:30:00Z'),
    );
    expect(output).toContain('# Fix the bug');
    expect(output).toContain('_Exported 2026-09-18 10:30_');
    expect(output).toContain('## You\n\ndo it');
    expect(output).toContain('## Dev-First\n\ndone');
  });

  it('skips notices and empty messages', () => {
    const output = buildTranscript(
      [message({ role: 'notice', text: 'checkpoint created' }), message({ text: '   ' })],
      'Session',
      new Date('2026-09-18T00:00:00Z'),
    );
    expect(output).not.toContain('checkpoint');
    expect(output.trim().endsWith('_')).toBe(true);
  });
});
