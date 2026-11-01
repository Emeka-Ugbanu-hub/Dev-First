import { describe, expect, it } from 'vitest';
import { consolidateSystemMessages } from '../src/llm/messageNormalizer';

describe('consolidateSystemMessages', () => {
  it('keeps one leading system message and preserves turn order', () => {
    const result = consolidateSystemMessages([
      { role: 'system', content: 'base' },
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'plan' },
      { role: 'system', content: 'plan' },
      { role: 'assistant', content: 'answer' },
    ]);
    expect(result).toEqual([
      { role: 'system', content: 'base\n\nplan' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'answer' },
    ]);
  });
});
