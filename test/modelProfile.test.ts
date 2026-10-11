import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
}));

vi.mock('vscode', () => {
  const disposable = { dispose() {} };
  return {
    workspace: {
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => env.config[key] ?? fallback,
        update: async () => undefined,
      }),
      onDidChangeTextDocument: () => disposable,
      onDidOpenTextDocument: () => disposable,
      onDidSaveTextDocument: () => disposable,
      onDidCloseTextDocument: () => disposable,
    },
    window: {
      onDidChangeTextEditorSelection: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      visibleTextEditors: [],
      showInformationMessage: () => undefined,
      showErrorMessage: () => undefined,
    },
    commands: { executeCommand: async () => undefined, registerCommand: () => disposable },
    ConfigurationTarget: { Global: 1 },
  };
});

import {
  MIN_RECENT_MESSAGES,
  contextProfileFor,
  effectiveThresholdTokens,
  preserveBudgetTokens,
  reserveRatioTotal,
  tierForWindow,
  type ContextProfileInput,
} from '../src/agent/modelProfile';
import {
  ADAPTIVE_RECENT_FLOOR,
  MIN_RECENT_TOOL_RESULTS,
  checkCompaction,
  chooseRecentStart,
} from '../src/agent/compaction';
import { shouldPrune } from '../src/agent/prune';
import { getConfig } from '../src/config';
import { COMPACTION_PROMPT } from '../src/planner/prompts';
import type { ChatMessage } from '../src/llm/types';

function input(contextWindow: number, overrides: Partial<ContextProfileInput> = {}): ContextProfileInput {
  return {
    contextWindow,
    maxOutput: 16_384,
    supportsTools: true,
    supportsReasoning: false,
    ...overrides,
  };
}

function conversationWithTools(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'plan' },
  ];
  for (let index = 0; index < 6; index++) {
    messages.push({ role: 'assistant', content: `step ${index}` });
  }
  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 't1', name: 'read_file', arguments: '{"path":"a"}' }],
  });
  messages.push({ role: 'tool', toolCallId: 't1', toolName: 'read_file', content: 'a' });
  messages.push({ role: 'assistant', content: 'more' });
  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 't2', name: 'read_file', arguments: '{"path":"b"}' }],
  });
  messages.push({ role: 'tool', toolCallId: 't2', toolName: 'read_file', content: 'b' });
  return messages;
}

beforeEach(() => {
  env.config = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('contextProfileFor', () => {
  it('derives the tier from the context window', () => {
    expect(tierForWindow(8_000)).toBe('compact');
    expect(tierForWindow(32_000)).toBe('compact');
    expect(tierForWindow(32_001)).toBe('standard');
    expect(tierForWindow(200_000)).toBe('standard');
    expect(tierForWindow(200_001)).toBe('large');
    expect(contextProfileFor(input(16_000)).tier).toBe('compact');
    expect(contextProfileFor(input(128_000)).tier).toBe('standard');
    expect(contextProfileFor(input(1_000_000)).tier).toBe('large');
  });

  it('uses the tier numbers for the derived profile', () => {
    expect(contextProfileFor(input(16_000))).toEqual({
      tier: 'compact',
      triggerRatio: 0.45,
      pruneRatio: 0.35,
      preserveTokens: 8_000,
      reserveRatio: 0.2,
    });
    expect(contextProfileFor(input(128_000))).toMatchObject({ triggerRatio: 0.6, preserveTokens: 20_000 });
    expect(contextProfileFor(input(1_000_000))).toMatchObject({ triggerRatio: 0.62, preserveTokens: 24_000 });
  });

  it('lets an override force the tier', () => {
    expect(contextProfileFor(input(1_000_000, { override: 'compact' })).tier).toBe('compact');
    expect(contextProfileFor(input(8_000, { override: 'standard' })).tier).toBe('standard');
    expect(contextProfileFor(input(128_000, { override: 'large' })).tier).toBe('large');
    expect(contextProfileFor(input(128_000, { override: 'auto' })).tier).toBe('standard');
  });

  it('ignores name hints and derives the tier from the window only', () => {
    for (const name of ['x-4b', 'x-9b', 'x-70b-q4', 'tiny-1b']) {
      expect(contextProfileFor(input(128_000)).tier, name).toBe('standard');
      expect(contextProfileFor(input(16_000)).tier, name).toBe('compact');
    }
  });
});

describe('coherence math', () => {
  it('keeps preserve below threshold minus the reserve budget', () => {
    for (const contextWindow of [32_000, 128_000, 200_000, 400_000, 1_000_000]) {
      for (const reasoning of [false, true]) {
        const profile = contextProfileFor(input(contextWindow, { supportsReasoning: reasoning }));
        const threshold = effectiveThresholdTokens(profile, contextWindow, reasoning, 0);
        const reserve = reserveRatioTotal(profile, contextWindow, reasoning) * contextWindow;
        const preserve = preserveBudgetTokens(profile, contextWindow, reasoning);
        expect(preserve, `${profile.tier} ${contextWindow} reasoning=${reasoning}`).toBeLessThan(threshold - reserve);
      }
    }
  });

  it('never reserves more than thirty percent of the window', () => {
    for (const contextWindow of [8_000, 16_000, 32_000, 128_000, 1_000_000]) {
      for (const reasoning of [false, true]) {
        const profile = contextProfileFor(input(contextWindow, { supportsReasoning: reasoning }));
        expect(reserveRatioTotal(profile, contextWindow, reasoning)).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it('caps the reasoning reserve extra at five points', () => {
    const profile = contextProfileFor(input(8_000, { supportsReasoning: true }));
    expect(reserveRatioTotal(profile, 8_000, true) - reserveRatioTotal(profile, 8_000, false)).toBeCloseTo(0.05);
    expect(reserveRatioTotal(profile, 16_000, true) - reserveRatioTotal(profile, 16_000, false)).toBeCloseTo(0.05);
    const largeExtra = reserveRatioTotal(profile, 1_000_000, true) - reserveRatioTotal(profile, 1_000_000, false);
    expect(largeExtra).toBeGreaterThan(0);
    expect(largeExtra).toBeLessThan(0.05);
  });

  it('produces a usable threshold and a positive preserve for tiny windows', () => {
    for (const contextWindow of [8_000, 16_000]) {
      const profile = contextProfileFor(input(contextWindow));
      const threshold = effectiveThresholdTokens(profile, contextWindow, false, 0);
      const preserve = preserveBudgetTokens(profile, contextWindow, false);
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThan(contextWindow);
      expect(preserve).toBeGreaterThan(0);
      expect(preserve).toBeLessThanOrEqual(threshold);
    }
  });

  it('lowers the threshold by ten percent under heavy recent tool output', () => {
    const contextWindow = 128_000;
    const profile = contextProfileFor(input(contextWindow));
    const base = effectiveThresholdTokens(profile, contextWindow, false, 0);
    const heavy = effectiveThresholdTokens(profile, contextWindow, false, contextWindow * 0.2 * 4 + 1);
    expect(heavy).toBeCloseTo(base * 0.9);
    expect(effectiveThresholdTokens(profile, contextWindow, false, contextWindow * 0.2 * 4)).toBe(base);
  });
});

describe('checkCompaction with a profile', () => {
  it('triggers at the profile ratio where the default would not', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'plan' },
      { role: 'user', content: 'x'.repeat(16_000) },
    ];
    const profile = contextProfileFor(input(8_000));
    const adaptive = checkCompaction(messages, 8_000, { profile });
    const fallback = checkCompaction(messages, 8_000);
    expect(adaptive.needed).toBe(true);
    expect(adaptive.threshold).toBeLessThan(8_000 * 0.6);
    expect(fallback.needed).toBe(false);
  });

  it('keeps the default behavior identical without a profile', () => {
    const small: ChatMessage[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'hi' }];
    expect(checkCompaction(small, 128_000)).toEqual({ needed: false, recentStart: small.length, tokens: expect.any(Number) });
    const big: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'plan' },
      { role: 'user', content: 'x'.repeat(400_000) },
    ];
    const check = checkCompaction(big, 100_000);
    expect(check.needed).toBe(true);
    expect(check.threshold).toBeUndefined();
  });
});

describe('shouldPrune with a profile', () => {
  it('honors the profile prune ratio', () => {
    const profile = contextProfileFor(input(8_000));
    expect(shouldPrune(3_500, 8_000, profile)).toBe(true);
    expect(shouldPrune(3_500, 8_000)).toBe(false);
  });

  it('keeps the default ratio without a profile', () => {
    expect(shouldPrune(3_000, 8_000)).toBe(false);
    expect(shouldPrune(5_000, 8_000)).toBe(true);
    expect(shouldPrune(5_000, 0)).toBe(false);
  });
});

describe('message floor', () => {
  it('keeps at least the last six messages and two tool results under tiny budgets', () => {
    const messages = conversationWithTools();
    expect(messages.length).toBeGreaterThan(MIN_RECENT_MESSAGES);
    for (const preserveTokens of [0, 1, 100]) {
      const start = chooseRecentStart(messages, preserveTokens, ADAPTIVE_RECENT_FLOOR);
      expect(messages.length - start).toBeGreaterThanOrEqual(MIN_RECENT_MESSAGES);
      const toolIndexes = messages
        .map((message, index) => (message.role === 'tool' ? index : -1))
        .filter((index) => index >= 0);
      expect(toolIndexes.length).toBeGreaterThanOrEqual(MIN_RECENT_TOOL_RESULTS);
      for (const index of toolIndexes.slice(-MIN_RECENT_TOOL_RESULTS)) {
        expect(index).toBeGreaterThanOrEqual(start);
      }
      expect(messages[start].role).not.toBe('tool');
    }
  });

  it('does not change the legacy cut when no floor is requested', () => {
    const messages = conversationWithTools();
    const legacyStart = chooseRecentStart(messages, 1);
    expect(messages.length - legacyStart).toBeLessThan(MIN_RECENT_MESSAGES);
    expect(chooseRecentStart(messages, 1, ADAPTIVE_RECENT_FLOOR)).toBeLessThan(legacyStart);
  });
});

describe('contextProfile setting', () => {
  it('defaults to auto', () => {
    expect(getConfig().contextProfile).toBe('auto');
  });

  it('reads an override from configuration', () => {
    env.config = { contextProfile: 'large' };
    expect(getConfig().contextProfile).toBe('large');
  });
});

describe('COMPACTION_PROMPT', () => {
  it('asks for pending decisions, per-file state, and surviving tool results', () => {
    expect(COMPACTION_PROMPT).toContain('- Pending decisions or questions the agent is waiting on');
    expect(COMPACTION_PROMPT).toContain(
      '- One line per file created or modified with its exact path and current state',
    );
    expect(COMPACTION_PROMPT).toContain(
      '- A compact summary of tool results that still matter (what ran, what it proved)',
    );
  });
});
