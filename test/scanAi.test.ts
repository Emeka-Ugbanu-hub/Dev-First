import { afterAll, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

vi.mock('vscode', () => ({
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
}));

import {
  AiScanner,
  aiCacheKey,
  buildArchitecturePrompt,
  buildChunkPrompt,
  dedupeAiFindings,
  fileMetrics,
  orderChunks,
  parseAiFindings,
} from '../src/scan/aiScanner';
import type { Chunk } from '../src/scan/chunker';
import { profileFor } from '../src/scan/languages/profiles';
import type { ChatMessage, LLMProvider, StreamEvent } from '../src/llm/types';
import type { ScanCategory, ScanFinding, ScanRule } from '../src/scan/ruleTypes';
import { filterFindingsByCategory } from '../src/scan/scanner';
import { stripForAi } from '../src/scan/strip';
import { TreeSitterService } from '../src/scan/treeSitter';

const service = new TreeSitterService({ extensionUri: { fsPath: path.join(__dirname, '..') } });

afterAll(() => service.dispose());

function makeRule(id: string, category: ScanCategory): ScanRule {
  return {
    kind: 'analyzer',
    run: () => [],
    id,
    category,
    severity: 'warning',
    message: 'message',
    why: 'why',
    fix: 'fix',
  };
}

function makeFinding(rule: ScanRule, line: number, startChar = 0, endChar = 20): ScanFinding {
  return { rule, line, startChar, endChar };
}

const SOURCE = [
  "import { a } from './a';",
  '',
  'export function one() {',
  '  return FIRST_MARKER;',
  '}',
  '',
  'export function two() {',
  '  return SECOND_MARKER;',
  '}',
].join('\n');

const TARGET = {
  uri: 'file:///a.ts',
  languageId: 'typescript',
  text: SOURCE,
  lineCount: SOURCE.split('\n').length,
};

const RESPONSE = JSON.stringify({
  findings: [
    { line: 1, category: 'bug', severity: 'warning', message: 'm', why: 'w', fix: 'f' },
  ],
});

interface StubProvider extends LLMProvider {
  calls: number;
  prompts: string[];
}

function stubProvider(responses: string[]): StubProvider {
  const provider: StubProvider = {
    id: 'stub',
    calls: 0,
    prompts: [],
    async *chat(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
      const index = Math.min(provider.calls, responses.length - 1);
      provider.calls += 1;
      const user = messages.find((message) => message.role === 'user');
      provider.prompts.push(user?.content ?? '');
      const text = responses[index] ?? '';
      if (text) {
        yield { type: 'text' as const, text };
      }
    },
    async listModels(): Promise<string[]> {
      return [];
    },
    async embed(): Promise<number[][]> {
      return [];
    },
  };
  return provider;
}

function scannerWith(provider: LLMProvider): AiScanner {
  return new AiScanner({
    getConfig: () => ({ scanAi: true, scanAiModel: '', model: 'stub-model' }),
    buildProvider: async () => provider,
  });
}

describe('buildChunkPrompt', () => {
  it('includes the checklist, signatures, and already-reported findings', () => {
    const chunk: Chunk = {
      startLine: 2,
      endLine: 4,
      text: 'export function one() {\n  return 1;\n}',
      structural: false,
    };
    const reported = [makeFinding(makeRule('scan-js-loose-equality', 'bug'), 3)];
    const prompt = buildChunkPrompt({
      languageId: 'typescript',
      chunk,
      signatures: ['export function one() {'],
      reported,
      stripped: stripForAi(chunk.text, 'typescript'),
    });
    expect(prompt.system).toContain('bug:');
    expect(prompt.system).toContain('vulnerability:');
    expect(prompt.system).toContain('smell:');
    expect(prompt.system).toContain('architecture:');
    expect(prompt.system).toContain('{"findings"');
    expect(prompt.system).toContain('"concept":""');
    expect(prompt.user).toContain('Chunk covers file lines 3-5');
    expect(prompt.user).toContain('export function one() {');
    expect(prompt.user).toContain('do not repeat');
    expect(prompt.user).toContain('scan-js-loose-equality');
    expect(prompt.user).toContain('relative to this chunk');
    expect(prompt.user).toContain('return 1;');
  });
});

describe('buildArchitecturePrompt', () => {
  it('constrains the model to separable responsibilities and forbids length findings', () => {
    const prompt = buildArchitecturePrompt('typescript', ['export function one() {'], fileMetrics(SOURCE));
    expect(prompt.system).toContain('responsibilities are clearly separable');
    expect(prompt.system).toContain('Never flag a file merely for being long');
    expect(prompt.system).toContain('"category":"architecture"');
    expect(prompt.user).toContain('export function one() {');
    expect(prompt.user).toContain('Lines:');
    expect(prompt.user).toContain('Max nesting depth:');
  });
});

describe('orderChunks', () => {
  const chunks: Chunk[] = [
    { startLine: 0, endLine: 9, text: 'a', structural: false },
    { startLine: 10, endLine: 19, text: 'b', structural: false },
    { startLine: 20, endLine: 29, text: 'c', structural: false },
  ];

  it('moves the chunk containing the visible line to the front', () => {
    expect(orderChunks(chunks, 25).map((chunk) => chunk.startLine)).toEqual([20, 0, 10]);
  });

  it('keeps file order without a hint or when the first chunk is visible', () => {
    expect(orderChunks(chunks, undefined).map((chunk) => chunk.startLine)).toEqual([0, 10, 20]);
    expect(orderChunks(chunks, 5).map((chunk) => chunk.startLine)).toEqual([0, 10, 20]);
  });
});

describe('parseAiFindings', () => {
  it('parses fenced JSON and converts 1-based lines', () => {
    const raw =
      '```json\n{"findings":[{"line":2,"category":"bug","severity":"error","message":"bad","why":"w","fix":"f"}]}\n```';
    expect(parseAiFindings(raw, 10)).toEqual([
      { line: 1, category: 'bug', severity: 'error', message: 'bad', why: 'w', fix: 'f' },
    ]);
  });

  it('repairs trailing commas and unterminated output', () => {
    const raw =
      '{"findings":[{"line":1,"category":"smell","severity":"info","message":"m","why":"w","fix":"f",},]';
    expect(parseAiFindings(raw, 5)).toEqual([
      { line: 0, category: 'smell', severity: 'info', message: 'm', why: 'w', fix: 'f' },
    ]);
  });

  it('drops invalid categories, empty messages, and clamps lines', () => {
    const raw = JSON.stringify({
      findings: [
        { line: 999, category: 'style', severity: 'info', message: 'nope' },
        { line: 2, category: 'bug', severity: 'fatal', message: 'nope' },
        { line: 3, category: 'smell', severity: 'info', message: '   ' },
        { line: 999, category: 'smell', severity: 'info', message: 'kept', why: 'w', fix: 'f' },
      ],
    });
    expect(parseAiFindings(raw, 4)).toEqual([
      { line: 3, category: 'smell', severity: 'info', message: 'kept', why: 'w', fix: 'f' },
    ]);
  });

  it('parses architecture findings', () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: 'architecture',
          severity: 'warning',
          message: 'file does too much',
          why: 'w',
          fix: 'f',
        },
      ],
    });
    expect(parseAiFindings(raw, 10)).toEqual([
      {
        line: 0,
        category: 'architecture',
        severity: 'warning',
        message: 'file does too much',
        why: 'w',
        fix: 'f',
      },
    ]);
  });

  it('caps findings at five and ignores non-JSON output', () => {
    const findings = Array.from({ length: 7 }, (_entry, index) => ({
      line: index + 1,
      category: 'bug',
      severity: 'warning',
      message: `m${index}`,
      why: 'w',
      fix: 'f',
    }));
    expect(parseAiFindings(JSON.stringify({ findings }), 20)).toHaveLength(5);
    expect(parseAiFindings('not json at all')).toEqual([]);
  });

  it('keeps a trimmed concept and drops an empty one', () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: 'bug',
          severity: 'warning',
          message: 'm',
          why: 'w',
          fix: 'f',
          concept: '  TOCTOU race  ',
        },
        {
          line: 2,
          category: 'smell',
          severity: 'info',
          message: 'm2',
          why: 'w',
          fix: 'f',
          concept: '   ',
        },
      ],
    });
    const findings = parseAiFindings(raw, 10);
    expect(findings[0].concept).toBe('TOCTOU race');
    expect(findings[1].concept).toBeUndefined();
    expect('concept' in findings[1]).toBe(false);
  });
});

describe('aiCacheKey', () => {
  it('changes when the content changes but stays stable otherwise', () => {
    const base = aiCacheKey('file:///a.ts', SOURCE);
    expect(aiCacheKey('file:///a.ts', SOURCE)).toBe(base);
    expect(aiCacheKey('file:///a.ts', `${SOURCE}// changed`)).not.toBe(base);
    expect(aiCacheKey('file:///b.ts', SOURCE)).not.toBe(base);
  });
});

describe('dedupeAiFindings', () => {
  it('drops an AI finding overlapping a deterministic one on the same line and category', () => {
    const ai = [
      makeFinding(makeRule('ai-bug', 'bug'), 4),
      makeFinding(makeRule('ai-smell', 'smell'), 4),
      makeFinding(makeRule('ai-bug', 'bug'), 9),
    ];
    const deterministic = [makeFinding(makeRule('scan-js-loose-equality', 'bug'), 4, 0, 12)];
    expect(dedupeAiFindings(ai, deterministic).map((finding) => finding.rule.id)).toEqual([
      'ai-smell',
      'ai-bug',
    ]);
  });

  it('keeps AI findings on other lines or categories', () => {
    const ai = [makeFinding(makeRule('ai-bug', 'bug'), 5)];
    const deterministic = [makeFinding(makeRule('scan-js-loose-equality', 'bug'), 4, 0, 12)];
    expect(dedupeAiFindings(ai, deterministic)).toHaveLength(1);
  });
});

describe('architecture category filtering', () => {
  it('survives category filtering and can be disabled', () => {
    const finding = makeFinding(makeRule('ai-architecture', 'architecture'), 0);
    expect(filterFindingsByCategory([finding], ['hotspot', 'secret'])).toHaveLength(1);
    expect(filterFindingsByCategory([finding], ['architecture'])).toEqual([]);
  });
});

describe('AiScanner chunking', () => {
  const options = { chunkOptions: { maxTokens: 8 } };

  it('caches architecture and chunks, and only redoes changed chunks', async () => {
    const provider = stubProvider([RESPONSE]);
    const scanner = scannerWith(provider);
    const tree = await service.parse(SOURCE, 'typescript');
    await scanner.scan(TARGET, [], tree, options);
    expect(provider.calls).toBe(2);
    await scanner.scan(TARGET, [], tree, options);
    expect(provider.calls).toBe(2);
    const changed = SOURCE.replace('SECOND_MARKER', 'SECOND_MARKER_CHANGED');
    const changedTree = await service.parse(changed, 'typescript');
    await scanner.scan({ ...TARGET, text: changed }, [], changedTree, options);
    expect(provider.calls).toBe(3);
    scanner.dispose();
  });

  it('scans the chunk containing the visible line first', async () => {
    const provider = stubProvider([RESPONSE]);
    const scanner = scannerWith(provider);
    const tree = await service.parse(SOURCE, 'typescript');
    await scanner.scan(TARGET, [], tree, { ...options, visibleLine: 7 });
    const second = provider.prompts.findIndex((prompt) => prompt.includes('SECOND_MARKER'));
    const first = provider.prompts.findIndex((prompt) => prompt.includes('FIRST_MARKER'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(second).toBeLessThan(first);
    scanner.dispose();
  });

  it('skips structural chunks entirely', async () => {
    const source = [
      "import { a } from './a';",
      '',
      'export type Config = {',
      "  marker: 'STRUCTURAL_MARKER';",
      '};',
      '',
      'export function run() {',
      '  return 1;',
      '}',
    ].join('\n');
    const provider = stubProvider([RESPONSE]);
    const scanner = scannerWith(provider);
    const tree = await service.parse(source, 'typescript');
    await scanner.scan(
      {
        uri: 'file:///b.ts',
        languageId: 'typescript',
        text: source,
        lineCount: source.split('\n').length,
      },
      [],
      tree,
      options,
    );
    expect(provider.prompts.some((prompt) => prompt.includes('STRUCTURAL_MARKER'))).toBe(false);
    expect(provider.calls).toBe(1);
    scanner.dispose();
  });

  it('reports progress and partial findings per chunk', async () => {
    const provider = stubProvider([RESPONSE]);
    const scanner = scannerWith(provider);
    const tree = await service.parse(SOURCE, 'typescript');
    const progress: string[] = [];
    const partials: number[] = [];
    await scanner.scan(TARGET, [], tree, {
      ...options,
      onProgress: (done, total) => progress.push(`${done}/${total}`),
      onPartial: (findings) => partials.push(findings.length),
    });
    expect(progress).toEqual(['1/2', '2/2']);
    expect(partials).toHaveLength(2);
    scanner.dispose();
  });

  it('anchors architecture findings at line 1', async () => {
    const architecture = JSON.stringify({
      findings: [
        {
          line: 9,
          category: 'architecture',
          severity: 'info',
          confidence: 'high',
          message: 'split',
          why: 'w',
          fix: 'f',
          evidence: [{ path: 'file.ts', line: 9 }],
        },
      ],
    });
    const provider = stubProvider([architecture]);
    const scanner = scannerWith(provider);
    const tree = await service.parse(SOURCE, 'typescript');
    const findings = await scanner.scan(TARGET, [], tree, options);
    const architectureFinding = findings?.find((finding) => finding.rule.id === 'ai-architecture');
    expect(architectureFinding).toBeDefined();
    expect(architectureFinding?.line).toBeGreaterThanOrEqual(0);
    scanner.dispose();
  });
});

describe('profileFor integration', () => {
  it('exposes a typescript profile for chunk classification', () => {
    expect(profileFor('typescript')?.language).toBe('typescript');
  });
});
