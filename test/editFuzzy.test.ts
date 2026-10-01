import { describe, expect, it } from 'vitest';
import { fuzzyReplaceInContent, withFileLock } from '../src/agent/patch';

describe('fuzzyReplaceInContent', () => {
  it('uses the exact match first', () => {
    const result = fuzzyReplaceInContent('const a = 1;\n', 'const a = 1;', 'const a = 2;', false);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('exact');
    expect(result.content).toBe('const a = 2;\n');
  });

  it('falls back to a line-trimmed match and keeps the file indentation', () => {
    const content = 'function x() {\n    return 1;\n}\n';
    const result = fuzzyReplaceInContent(content, 'function x() {\n  return 1;\n}', 'function x() {\n  return 2;\n}', false);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('trimmed');
    expect(result.content).toBe('function x() {\n    return 2;\n}\n');
  });

  it('falls back to a whitespace-normalized match', () => {
    const content = 'const value = compute(1, 2);\n';
    const result = fuzzyReplaceInContent(content, 'const value =  compute(1, 2);', 'const value = compute(3, 4);', false);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('whitespace');
    expect(result.content).toBe('const value = compute(3, 4);\n');
  });

  it('re-indents a de-indented old_text against the matched block', () => {
    const content = 'if (ready) {\n    const a = 1;\n    run(a);\n}\n';
    const oldText = 'if (ready) {\nconst a = 1;\nrun(a);\n}';
    const newText = 'if (ready) {\nconst a = 2;\nrun(a);\n}';
    const result = fuzzyReplaceInContent(content, oldText, newText, false);
    expect(result.ok).toBe(true);
    expect(result.content).toBe('if (ready) {\n    const a = 2;\n    run(a);\n}\n');
  });

  it('rejects multiple matches and tells the model what to do', () => {
    const content = '  run();\n  keep();\n  run();\n';
    const result = fuzzyReplaceInContent(content, 'run();', 'stop();', false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('multiple locations');
    expect(result.error).toContain('replace_all');
  });

  it('replaces every fuzzy match when replace_all is set', () => {
    const content = '  run(  1);\nkeep();\n  run(  1);\n';
    const result = fuzzyReplaceInContent(content, 'run( 1);', 'stop();', true);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.content).toBe('  stop();\nkeep();\n  stop();\n');
  });

  it('refuses a match far larger than the old text', () => {
    const content = 'const a = 1;\n\n\n\n\n\nconst b = 2;\n';
    const result = fuzzyReplaceInContent(content, 'const a = 1;\nconst b = 2;', 'const a = 9;\nconst b = 9;', false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('match much larger than expected');
  });

  it('reports a clear error when nothing matches', () => {
    const result = fuzzyReplaceInContent('hello\n', 'nope', 'x', false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('withFileLock', () => {
  it('serializes tasks for the same file', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withFileLock('/tmp/dev-first-lock-test', async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    const second = withFileLock('/tmp/dev-first-lock-test', async () => {
      order.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('runs different files concurrently', async () => {
    const order: string[] = [];
    await Promise.all([
      withFileLock('/tmp/dev-first-lock-a', async () => {
        order.push('a');
      }),
      withFileLock('/tmp/dev-first-lock-b', async () => {
        order.push('b');
      }),
    ]);
    expect(order.sort()).toEqual(['a', 'b']);
  });
});
