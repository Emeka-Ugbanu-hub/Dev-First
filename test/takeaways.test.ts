import { describe, expect, it } from 'vitest';
import { buildExecutorSystemPrompt } from '../src/planner/prompts';
import { extractTakeaways } from '../src/session/takeaways';

describe('extractTakeaways', () => {
  it('extracts prefixed lines, strips them from the body, and caps at three', () => {
    const result = extractTakeaways(
      'What changed\n\nTAKEAWAYS: one\nTAKEAWAYS: two\n- TAKEAWAYS: three\nTAKEAWAYS: four',
    );
    expect(result.takeaways).toEqual(['one', 'two', 'three']);
    expect(result.text).toBe('What changed');
    expect(result.text).not.toContain('TAKEAWAYS');
  });

  it('leaves text untouched when no takeaways are present', () => {
    const result = extractTakeaways('Just a summary.');
    expect(result.takeaways).toBeUndefined();
    expect(result.text).toBe('Just a summary.');
  });

  it('drops empty takeaway lines and strips them from the body', () => {
    const result = extractTakeaways('Body\nTAKEAWAYS:   ');
    expect(result.takeaways).toBeUndefined();
    expect(result.text).toBe('Body');
  });
});

describe('executor prompt takeaways', () => {
  it('asks for TAKEAWAYS lines on non-obvious work', () => {
    const prompt = buildExecutorSystemPrompt();
    expect(prompt).toContain('TAKEAWAYS:');
    expect(prompt).toContain('non-obvious');
  });
});
