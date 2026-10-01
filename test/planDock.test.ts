import { describe, expect, it } from 'vitest';
import type { Phase, Plan } from '../src/shared/protocol';
import { shouldDockPlan } from '../webview/src/lib/planDock';

const draft: Plan = { version: 1, status: 'draft', what: 'Add the endpoint', steps: ['Add the handler'] };
const approved: Plan = { ...draft, status: 'approved' };
const completed: Plan = { ...approved, status: 'completed' };
const PHASES: Phase[] = ['idle', 'planning', 'executing', 'review'];

describe('shouldDockPlan matrix', () => {
  it('never docks without a plan', () => {
    for (const phase of PHASES) {
      expect(shouldDockPlan(phase, null)).toBe(false);
    }
  });

  it('docks a draft in every phase so a pending approval is never lost', () => {
    for (const phase of PHASES) {
      expect(shouldDockPlan(phase, draft)).toBe(true);
    }
  });

  it('docks an approved plan only while executing', () => {
    expect(shouldDockPlan('idle', approved)).toBe(false);
    expect(shouldDockPlan('planning', approved)).toBe(false);
    expect(shouldDockPlan('executing', approved)).toBe(true);
    expect(shouldDockPlan('review', approved)).toBe(false);
  });

  it('moves a completed plan inline once the run finishes', () => {
    expect(shouldDockPlan('executing', completed)).toBe(false);
    expect(shouldDockPlan('idle', completed)).toBe(false);
    expect(shouldDockPlan('review', completed)).toBe(false);
  });

  it('clears a finished dock when a new message starts planning', () => {
    expect(shouldDockPlan('idle', approved)).toBe(false);
    expect(shouldDockPlan('planning', approved)).toBe(false);
    expect(shouldDockPlan('planning', draft)).toBe(true);
  });

  it('does not dock a completed plan while another phase is active', () => {
    expect(shouldDockPlan('planning', completed)).toBe(false);
    expect(shouldDockPlan('executing', completed)).toBe(false);
  });
});
