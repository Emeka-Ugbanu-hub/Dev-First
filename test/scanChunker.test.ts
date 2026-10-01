import { afterAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import { chunkFile, signaturesOf } from '../src/scan/chunker';
import { profileFor } from '../src/scan/languages/profiles';
import { TreeSitterService } from '../src/scan/treeSitter';

const service = new TreeSitterService({ extensionUri: { fsPath: path.join(__dirname, '..') } });

afterAll(() => service.dispose());

const SOURCE = [
  "import { a } from './a';",
  '',
  'export function one() {',
  '  return a;',
  '}',
  '',
  'export function two() {',
  '  return 1;',
  '}',
].join('\n');

describe('chunkFile with a tree', () => {
  it('splits at top-level declarations and keeps every line covered', async () => {
    const tree = await service.parse(SOURCE, 'typescript');
    const chunks = chunkFile(SOURCE, tree, profileFor('typescript'), { maxTokens: 8 });
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toMatchObject({ startLine: 0, endLine: 0 });
    expect(chunks[1]).toMatchObject({ startLine: 1, endLine: 4 });
    expect(chunks[2]).toMatchObject({ startLine: 5, endLine: 8 });
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index].startLine).toBe(chunks[index - 1].endLine + 1);
    }
    expect(chunks[1].text).toContain('export function one() {');
    expect(chunks[1].text).toContain('}');
    expect(chunks[2].text).toContain('export function two() {');
  });

  it('never splits a declaration even when it exceeds the token budget', async () => {
    const tree = await service.parse(SOURCE, 'typescript');
    const chunks = chunkFile(SOURCE, tree, profileFor('typescript'), { maxTokens: 1 });
    const one = chunks.find((chunk) => chunk.startLine <= 2 && chunk.endLine >= 2);
    expect(one?.startLine).toBe(1);
    expect(one?.endLine).toBe(4);
    const two = chunks.find((chunk) => chunk.startLine <= 6 && chunk.endLine >= 6);
    expect(two?.startLine).toBe(5);
    expect(two?.endLine).toBe(8);
  });

  it('classifies import, type, and constant chunks as structural', async () => {
    const source = [
      "import { a } from './a';",
      '',
      'export type Config = {',
      "  marker: 'STRUCTURAL_MARKER';",
      '};',
      '',
      'export const LIMIT = 42;',
      '',
      'export function run() {',
      '  return LIMIT;',
      '}',
    ].join('\n');
    const tree = await service.parse(source, 'typescript');
    const chunks = chunkFile(source, tree, profileFor('typescript'), { maxTokens: 8 });
    expect(chunks.map((chunk) => chunk.structural)).toEqual([true, true, true, false]);
    expect(chunks.some((chunk) => chunk.structural && chunk.text.includes('STRUCTURAL_MARKER'))).toBe(
      true,
    );
  });

  it('classifies a constant function chunk as logic', async () => {
    const source = ['export const handler = () => {', '  return 1;', '};'].join('\n');
    const tree = await service.parse(source, 'typescript');
    const chunks = chunkFile(source, tree, profileFor('typescript'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].structural).toBe(false);
  });
});

describe('chunkFile without a grammar', () => {
  it('falls back to line windows with overlap', () => {
    const lines = Array.from({ length: 1000 }, (_entry, index) => `line ${index}`);
    const chunks = chunkFile(lines.join('\n'), undefined, undefined);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [0, 399],
      [390, 789],
      [780, 999],
    ]);
    expect(chunks[1].text.split('\n')[0]).toBe('line 390');
    expect(chunks.every((chunk) => !chunk.structural)).toBe(true);
  });

  it('marks an import-only window structural', () => {
    const lines = Array.from({ length: 500 }, (_entry, index) =>
      index < 400 ? `import value${index}` : `call${index}();`,
    );
    const chunks = chunkFile(lines.join('\n'), undefined, undefined);
    expect(chunks[0].structural).toBe(true);
    expect(chunks[1].structural).toBe(false);
  });
});

describe('signaturesOf', () => {
  it('collects imports and declaration signatures for typescript', () => {
    const source = [
      "import { a } from './a';",
      '',
      'export class Demo {',
      '  run(value: string): void {',
      '    work();',
      '  }',
      '}',
      '',
      'export function helper(x: number): number {',
      '  return x;',
      '}',
    ].join('\n');
    const signatures = signaturesOf(source, profileFor('typescript'));
    expect(signatures).toContain("import { a } from './a';");
    expect(signatures).toContain('export class Demo {');
    expect(signatures).toContain('run(value: string): void {');
    expect(signatures).toContain('export function helper(x: number): number {');
    expect(signatures).not.toContain('work();');
    expect(signatures).not.toContain('return x;');
  });

  it('collects python definitions and constants', () => {
    const source = [
      'import os',
      '',
      'class Demo:',
      '    def run(self):',
      '        return 1',
      '',
      'MAX = 10',
    ].join('\n');
    const signatures = signaturesOf(source, profileFor('python'));
    expect(signatures).toContain('import os');
    expect(signatures).toContain('class Demo:');
    expect(signatures).toContain('def run(self):');
    expect(signatures).toContain('MAX = 10');
    expect(signatures).not.toContain('return 1');
  });
});
