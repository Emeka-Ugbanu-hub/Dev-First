import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class MarkdownString {
    value = '';
    supportThemeIcons = false;
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
  }
  class Hover {
    constructor(public contents: MarkdownString) {}
  }
  return { MarkdownString, Hover };
});

import { createHoverProvider } from '../src/scan/hover';
import type { ScanFinding, ScanRule } from '../src/scan/ruleTypes';

function finding(concept?: string): ScanFinding {
  const rule: ScanRule = {
    kind: 'analyzer',
    run: () => [],
    id: 'ai-bug',
    category: 'bug',
    severity: 'warning',
    message: 'message',
    why: 'why',
    fix: 'fix',
    concept,
  };
  return { rule, line: 0, startChar: 0, endChar: 5 };
}

function hoverFor(entry: ScanFinding): { contents: { value: string } } | undefined {
  const provider = createHoverProvider({ getFindings: () => [entry] } as never);
  return provider.provideHover!(
    { uri: { scheme: 'file' } } as never,
    { line: 0, character: 0 } as never,
  ) as never;
}

describe('scan hover concepts', () => {
  it('appends a concept line when the finding has one', () => {
    const hover = hoverFor(finding('single responsibility'));
    expect(hover?.contents.value).toContain('_Concept: single responsibility_');
  });

  it('omits the concept line when the finding has none', () => {
    const hover = hoverFor(finding());
    expect(hover?.contents.value).not.toContain('_Concept:');
  });
});
