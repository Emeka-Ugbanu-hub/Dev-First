import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SPILL_MAX_LINES,
  cleanupSpillFiles,
  initOutputStore,
  spillFileName,
  spillOutput,
} from '../src/agent/outputStore';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-spill-'));
  initOutputStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function longText(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n');
}

describe('spillOutput', () => {
  it('passes short text through untouched', async () => {
    expect(await spillOutput('hello', 'read_file')).toBe('hello');
  });

  it('spills long output and returns a head/tail preview pointing at the full file', async () => {
    const text = longText(SPILL_MAX_LINES + 10);
    const result = await spillOutput(text, 'search_text');
    expect(result).toContain('line 0 ');
    expect(result).toContain(`line ${SPILL_MAX_LINES + 9} `);
    expect(result).toMatch(/\.\.\. \[\d+ lines omitted — full output: .dev-first\/tool-output\/search_text-/);
    const match = /full output: (.+?)\]/.exec(result);
    expect(match).not.toBeNull();
    const stored = await fs.readFile(path.join(root, match![1]), 'utf-8');
    expect(stored).toBe(text);
  });

  it('spills by byte size even under the line cap', async () => {
    const text = `head\n${'y'.repeat(60 * 1024)}\ntail`;
    const result = await spillOutput(text, 'web_fetch');
    expect(result).toContain('lines omitted — full output: .dev-first/tool-output/web_fetch-');
  });

  it('cleans up files older than seven days', async () => {
    const result = await spillOutput(longText(SPILL_MAX_LINES + 1), 'read_file');
    const match = /full output: (.+?)\]/.exec(result)!;
    const file = path.join(root, match[1]);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(file, old, old);
    expect(await cleanupSpillFiles(root)).toBeGreaterThan(0);
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('keeps recent files during cleanup', async () => {
    const result = await spillOutput(longText(SPILL_MAX_LINES + 1), 'read_file');
    const match = /full output: (.+?)\]/.exec(result)!;
    expect(await cleanupSpillFiles(root)).toBe(0);
    await expect(fs.stat(path.join(root, match[1]))).resolves.toBeTruthy();
  });
});

describe('spillFileName', () => {
  it('sanitizes labels and keeps the extension', () => {
    const name = spillFileName('search_text/../weird name');
    expect(name).toContain('search_text');
    expect(name).toMatch(/\.txt$/);
    expect(name).not.toContain('/');
    expect(name).not.toContain(' ');
  });
});
