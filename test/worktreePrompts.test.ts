import { describe, expect, it } from 'vitest';
import { worktreeMergeConflictPrompt } from '../src/worktree/prompts';

describe('worktreeMergeConflictPrompt', () => {
  it('names both branches and lists conflicted files', () => {
    const prompt = worktreeMergeConflictPrompt('dev-first/feature', 'main', ['a.ts', 'src/b.ts']);
    expect(prompt).toContain('dev-first/feature');
    expect(prompt).toContain('main');
    expect(prompt).toContain('- a.ts');
    expect(prompt).toContain('- src/b.ts');
    expect(prompt).toContain('do not abort');
  });
});
