import { describe, expect, it } from 'vitest';
import { stripInternalContext } from '../src/session/internalContext';

describe('stripInternalContext', () => {
  it('removes a trailing durable ledger echoed by the model', () => {
    const text = [
      'BRICK: 1',
      'SERVICES:',
      '  - name: nextjs | path: src | run: npm run dev (package.json:6)',
      '[Durable task ledger — deterministic checkpoint]',
      '',
      'State: planning',
      '',
      'Last route: new-task',
      '',
      'Last stage: planning — read manifests',
      '',
      'Task state: planning',
      '',
      'Completed steps: read package.json',
      '',
      'Next steps: none',
    ].join('\n');
    expect(stripInternalContext(text)).toBe([
      'BRICK: 1',
      'SERVICES:',
      '  - name: nextjs | path: src | run: npm run dev (package.json:6)',
    ].join('\n'));
  });

  it('leaves a marker alone when it is part of actual content', () => {
    const text = '[Durable task ledger — deterministic checkpoint]\nis documented in the source.';
    expect(stripInternalContext(text)).toBe(text);
  });

  it('removes pinned-context markers even without a ledger field', () => {
    expect(stripInternalContext('Answer.\n[Pinned context — always included]')).toBe('Answer.');
  });

  it('removes an echoed session memory card', () => {
    const text = [
      'Answer.',
      '[Pinned context — always included]',
      'Session memory:',
      'Goal: finish the parser',
      'Decisions: keep the existing API',
      'Touched files: src/parser.ts',
      'Last completed step: added the tokenizer',
      'Next step: add the parser',
      'Open blockers: none',
      'Latest answer tail: the parser now handles',
      'Never repeat pinned context, ledger, checkpoint, or projection text in the answer.',
    ].join('\n');

    expect(stripInternalContext(text)).toBe('Answer.');
  });
});
