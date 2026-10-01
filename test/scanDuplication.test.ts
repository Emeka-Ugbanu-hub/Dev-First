import { afterAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  window: {
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
  },
}));
import { TreeSitterService } from '../src/scan/treeSitter';
import { profileFor } from '../src/scan/languages/profiles';
import { bodyOf, functionsOf } from '../src/scan/rules/analyzerUtils';
import {
  DuplicationIndex,
  fingerprint,
  jaccard,
  normalizeFunctionTokens,
  tokenShingles,
} from '../src/scan/duplication';

const service = new TreeSitterService({ extensionUri: { fsPath: path.join(__dirname, '..') } });
const options = { minStatements: 2, threshold: 0.8, maxPerFunction: 3 };

afterAll(() => service.dispose());

const FILE_A = 'file:///workspace/a.ts';
const FILE_B = 'file:///workspace/b.ts';

const SOURCE_A = [
  'export function computeInvoice(items) {',
  '  let subtotal = 0;',
  '  for (const item of items) {',
  '    subtotal += item.price * item.quantity;',
  '  }',
  '  const tax = subtotal * 0.2;',
  '  return subtotal + tax;',
  '}',
  '',
].join('\n');

const SOURCE_B = [
  'export function calculateTotal(products) {',
  '  let sum = 0;',
  '  for (const product of products) {',
  '    sum += product.cost * product.count;',
  '  }',
  '  const vat = sum * 0.19;',
  '  return sum + vat;',
  '}',
  '',
].join('\n');

const SOURCE_NEAR = [
  'export function computeInvoice(items) {',
  '  let subtotal = 0;',
  '  for (const item of items) {',
  '    subtotal += item.price * item.quantity;',
  '  }',
  '  const tax = subtotal * 0.2;',
  '  subtotal = subtotal;',
  '  return subtotal + tax;',
  '}',
  '',
].join('\n');

const SOURCE_DIFFERENT = [
  'export function formatName(first, last) {',
  '  const parts = [first.trim(), last.trim()];',
  '  const joined = parts.filter(Boolean).join(" ");',
  '  return joined.toUpperCase();',
  '}',
  '',
].join('\n');

const SOURCE_WITH_STRING = [
  'function label(value) {',
  '  const prefix = "total";',
  '  const suffix = "items";',
  '  return prefix + value + suffix;',
  '}',
  '',
].join('\n');

function createIndex(): DuplicationIndex {
  return new DuplicationIndex({
    parse: (text, languageId) => service.parse(text, languageId),
  });
}

describe('duplication normalization helpers', () => {
  it('replaces identifiers, strings, and literals but keeps keywords', async () => {
    const tree = await service.parse(SOURCE_WITH_STRING, 'typescript');
    expect(tree).toBeDefined();
    const profile = profileFor('typescript');
    expect(profile).toBeDefined();
    const fn = functionsOf(tree!, profile!)[0];
    const normalized = normalizeFunctionTokens(bodyOf(fn)!, profile!, SOURCE_WITH_STRING);
    expect(normalized).toContain('$ID');
    expect(normalized).toContain('$STR');
    expect(normalized).toContain('return');
    expect(normalized).not.toContain('prefix');
    expect(normalized).not.toContain('total');
  });

  it('replaces numeric literals with $LIT', async () => {
    const tree = await service.parse(SOURCE_A, 'typescript');
    const profile = profileFor('typescript')!;
    const fn = functionsOf(tree!, profile)[0];
    const normalized = normalizeFunctionTokens(bodyOf(fn)!, profile, SOURCE_A);
    expect(normalized).toContain('$LIT');
    expect(normalized).not.toContain('0.2');
    expect(normalized).not.toContain('subtotal');
  });

  it('builds sliding-window shingles', () => {
    expect(tokenShingles(['a', 'b', 'c', 'd'], 2)).toEqual(['a b', 'b c', 'c d']);
    expect(tokenShingles(['a', 'b', 'c'])).toEqual([]);
    expect(tokenShingles(['a', 'b', 'c', 'd', 'e', 'f'], 5)).toEqual(['a b c d e', 'b c d e f']);
  });

  it('computes jaccard similarity', () => {
    const identical = new Set(['a', 'b', 'c']);
    expect(jaccard(identical, new Set(identical))).toBe(1);
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'c']))).toBeLessThan(1);
  });

  it('produces stable fingerprints', () => {
    const tokens = ['$ID', '=', '$LIT', ';'];
    expect(fingerprint(tokens)).toBe(fingerprint(['$ID', '=', '$LIT', ';']));
    expect(fingerprint(tokens)).not.toBe(fingerprint(['$ID', '=', '$STR', ';']));
  });
});

describe('DuplicationIndex', () => {
  it('finds a cross-file duplicate with identical normalized bodies', async () => {
    const index = createIndex();
    await index.indexFile(FILE_A, SOURCE_A, 'typescript');
    const matches = await index.findDuplicates(FILE_B, SOURCE_B, 'typescript', options);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ file: FILE_A, startLine: 0, similarity: 1 });
  });

  it('finds a near duplicate through shingles and jaccard', async () => {
    const index = createIndex();
    await index.indexFile(FILE_A, SOURCE_A, 'typescript');
    const matches = await index.findDuplicates(FILE_B, SOURCE_NEAR, 'typescript', {
      ...options,
      threshold: 0.6,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.6);
    expect(matches[0].similarity).toBeLessThan(1);
  });

  it('returns nothing for unrelated functions', async () => {
    const index = createIndex();
    await index.indexFile(FILE_A, SOURCE_A, 'typescript');
    const matches = await index.findDuplicates(FILE_B, SOURCE_DIFFERENT, 'typescript', options);
    expect(matches).toEqual([]);
  });

  it('never matches against the same file', async () => {
    const index = createIndex();
    await index.indexFile(FILE_A, SOURCE_A, 'typescript');
    const matches = await index.findDuplicates(FILE_A, SOURCE_A, 'typescript', options);
    expect(matches).toEqual([]);
  });

  it('replaces a file entry when re-indexed', async () => {
    const index = createIndex();
    await index.indexFile(FILE_A, SOURCE_A, 'typescript');
    await index.indexFile(FILE_A, SOURCE_DIFFERENT, 'typescript');
    const matches = await index.findDuplicates(FILE_B, SOURCE_B, 'typescript', options);
    expect(matches).toEqual([]);
  });

  it('removes entries with removeFile', async () => {
    const index = createIndex();
    await index.indexFile(FILE_A, SOURCE_A, 'typescript');
    await index.removeFile(FILE_A);
    const matches = await index.findDuplicates(FILE_B, SOURCE_B, 'typescript', options);
    expect(matches).toEqual([]);
  });
});

describe('structural language indexing', () => {
  it('indexes files whose grammar is not bundled with minimal facts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-structural-'));
    await fs.mkdir(path.join(root, 'ios'), { recursive: true });
    await fs.mkdir(path.join(root, 'android'), { recursive: true });
    await fs.writeFile(path.join(root, 'ios', 'App.swift'), 'import SwiftUI\nstruct AppView {}\n');
    await fs.writeFile(path.join(root, 'android', 'Main.kt'), 'package app\nfun main() {}\n');
    const index = new DuplicationIndex({
      root,
      parse: (text, languageId) => service.parse(text, languageId),
    });
    await index.ensureBuilt();
    const files = (await index.getFacts()).map((file) => file.file);
    expect(files.some((file) => file.endsWith('App.swift'))).toBe(true);
    expect(files.some((file) => file.endsWith('Main.kt'))).toBe(true);
  });
});
