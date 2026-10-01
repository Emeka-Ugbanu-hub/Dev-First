import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';
import {
  expandBraces,
  parseRipgrepJson,
  resetRipgrepCache,
  rgListFiles,
  rgSearch,
} from '../src/util/fsWalk';

let root: string;
let fakeRg: string;

const context = { requestTerminalApproval: async () => 'allow' as const };

function toolbox(): ToolBox {
  return new ToolBox({
    root,
    diffManager: {} as any,
    terminalTimeoutSeconds: 15,
    autoApproveTerminal: false,
    autoApproveEdits: true,
    safeCommandsOnly: true,
    yolo: false,
    autoApproveMcp: true,
    checkDiagnostics: false,
    sandbox: 'off',
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-rg-'));
  fakeRg = path.join(root, 'fake-rg');
  await fs.writeFile(
    fakeRg,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "ripgrep 14.0.0"
  exit 0
fi
if [ "$1" = "--files" ]; then
  printf 'a.ts\\nb.tsx\\nc.md\\n'
  exit 0
fi
printf '%s\\n' '{"type":"match","data":{"path":{"text":"a.ts"},"lines":{"text":"const x = 1;\\n"},"line_number":3}}'
printf '%s\\n' '{"type":"match","data":{"path":{"text":"b.tsx"},"lines":{"text":"const y = 2;\\n"},"line_number":5}}'
exit 0
`,
    'utf-8',
  );
  await fs.chmod(fakeRg, 0o755);
  process.env.DEV_FIRST_RG_PATH = fakeRg;
  resetRipgrepCache();
});

afterEach(async () => {
  delete process.env.DEV_FIRST_RG_PATH;
  resetRipgrepCache();
  await fs.rm(root, { recursive: true, force: true });
});

describe('expandBraces', () => {
  it('expands a simple extension set', () => {
    expect(expandBraces('*.{ts,tsx}')).toEqual(['*.ts', '*.tsx']);
  });

  it('expands nested braces', () => {
    expect(expandBraces('src/**/*.{test,spec}.{ts,tsx}')).toEqual([
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/*.spec.ts',
      'src/**/*.spec.tsx',
    ]);
  });

  it('leaves patterns without braces alone', () => {
    expect(expandBraces('**/*.ts')).toEqual(['**/*.ts']);
  });
});

describe('parseRipgrepJson', () => {
  it('collects match events with line numbers', () => {
    const matches = parseRipgrepJson(
      '{"type":"begin","data":{"path":{"text":"a.ts"}}}\n' +
        '{"type":"match","data":{"path":{"text":"a.ts"},"lines":{"text":"hello\\n"},"line_number":7}}\n' +
        'not json\n',
    );
    expect(matches).toEqual([{ file: 'a.ts', line: 7, text: 'hello' }]);
  });
});

describe('ripgrep integration', () => {
  it('runs rg --json and groups matches by file', async () => {
    const result = await rgSearch({
      root,
      base: root,
      query: 'const',
      isRegex: false,
      caseSensitive: false,
      maxResults: 100,
    });
    expect(result?.matches).toHaveLength(2);
    expect(result?.truncated).toBe(false);
    const text = await toolbox().execute('search_text', JSON.stringify({ query: 'const' }), context);
    expect(text).toContain('a.ts:');
    expect(text).toContain('  3: const x = 1;');
    expect(text).toContain('b.tsx:');
    expect(text).toContain('  5: const y = 2;');
  });

  it('caps matches and reports truncation', async () => {
    const result = await rgSearch({
      root,
      base: root,
      query: 'const',
      isRegex: false,
      caseSensitive: false,
      maxResults: 1,
    });
    expect(result?.matches).toHaveLength(1);
    expect(result?.truncated).toBe(true);
    const text = await toolbox().execute(
      'search_text',
      JSON.stringify({ query: 'const', max_results: 1 }),
      context,
    );
    expect(text).toContain('... [showing first 1 matches; narrow the query or path]');
  });

  it('lists files and expands brace globs', async () => {
    await fs.writeFile(path.join(root, 'a.ts'), 'const a = 1;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'b.tsx'), 'const b = 2;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'c.md'), '# c\n', 'utf-8');
    const listing = await rgListFiles(root, 10);
    expect(listing?.files).toEqual(['a.ts', 'b.tsx', 'c.md']);
    const result = await toolbox().execute('list_files', JSON.stringify({ glob: '*.{ts,tsx}' }), context);
    expect(result).toContain('a.ts');
    expect(result).toContain('b.tsx');
    expect(result).not.toContain('c.md');
  });

  it('falls back to the directory walk when rg is missing', async () => {
    process.env.DEV_FIRST_RG_PATH = path.join(root, 'nope');
    resetRipgrepCache();
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const needle = 1;\n', 'utf-8');
    await fs.writeFile(path.join(root, 'b.tsx'), 'const needle = 2;\n', 'utf-8');
    const search = await toolbox().execute('search_text', JSON.stringify({ query: 'needle' }), context);
    expect(search).toContain('src/a.ts:1');
    expect(search).toContain('b.tsx:1');
    const listing = await toolbox().execute(
      'list_files',
      JSON.stringify({ path: 'src', glob: '*.{ts,tsx}' }),
      context,
    );
    expect(listing).toContain('src/a.ts');
  });
});
