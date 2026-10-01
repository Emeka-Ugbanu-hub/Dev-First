import { describe, expect, it } from 'vitest';
import { buildExecutorSystemPrompt } from '../src/planner/prompts';
import { extractFailureConcept } from '../src/session/failureConcept';

describe('extractFailureConcept', () => {
  it('extracts the concept line and strips it from the body', () => {
    const result = extractFailureConcept(
      'What changed\n\nFAILURE_CONCEPT: stale closure — the effect captured the first render state',
    );
    expect(result.failureConcept).toBe('stale closure — the effect captured the first render state');
    expect(result.text).toBe('What changed');
    expect(result.text).not.toContain('FAILURE_CONCEPT');
  });

  it('keeps only the first concept when several are present', () => {
    const result = extractFailureConcept('Body\n- FAILURE_CONCEPT: first\nFAILURE_CONCEPT: second');
    expect(result.failureConcept).toBe('first');
    expect(result.text).toBe('Body');
  });

  it('leaves text untouched when no concept line is present', () => {
    const result = extractFailureConcept('Everything passed.');
    expect(result.failureConcept).toBeUndefined();
    expect(result.text).toBe('Everything passed.');
  });

  it('drops empty concept lines and strips them from the body', () => {
    const result = extractFailureConcept('Body\nFAILURE_CONCEPT:   ');
    expect(result.failureConcept).toBeUndefined();
    expect(result.text).toBe('Body');
  });
});

describe('executor prompt failure concepts', () => {
  it('asks for a single FAILURE_CONCEPT line only when something failed', () => {
    const prompt = buildExecutorSystemPrompt();
    expect(prompt).toContain('FAILURE_CONCEPT:');
    expect(prompt).toContain('Omit the line entirely when nothing failed');
  });
});
