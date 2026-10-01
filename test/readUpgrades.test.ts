import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';
import { clearAgentsMdCache } from '../src/agent/fileRead';

let root: string;

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

const context = { requestTerminalApproval: async () => 'allow' as const };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-read-'));
  clearAgentsMdCache();
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('read_file upgrades', () => {
  it('suggests case-insensitive names when the path is missing', async () => {
    await fs.writeFile(path.join(root, 'README.md'), '# hi\n', 'utf-8');
    const result = await toolbox().execute('read_file', JSON.stringify({ path: 'readme.mdx' }), context);
    expect(result).toContain('does not exist');
    expect(result).toContain('Did you mean');
    expect(result).toContain('README.md');
  });

  it('reports images instead of returning binary garbage', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    await fs.writeFile(path.join(root, 'logo.png'), png);
    const result = await toolbox().execute('read_file', JSON.stringify({ path: 'logo.png' }), context);
    expect(result).toContain('logo.png');
    expect(result).toContain('cannot be read as text');
    expect(result).not.toContain('\u0000');
  });

  it('reports PDFs with their size', async () => {
    await fs.writeFile(path.join(root, 'doc.pdf'), Buffer.from('%PDF-1.7\n'));
    const result = await toolbox().execute('read_file', JSON.stringify({ path: 'doc.pdf' }), context);
    expect(result).toContain('PDF document');
    expect(result).toContain('cannot be read as text');
  });

  it('stops at the byte budget and reports the exact continuation', async () => {
    const content = Array.from({ length: 4000 }, (_, index) => `line ${index} ${'x'.repeat(70)}`).join('\n');
    await fs.writeFile(path.join(root, 'big.txt'), content, 'utf-8');
    const result = await toolbox().execute('read_file', JSON.stringify({ path: 'big.txt' }), context);
    const match = /Showing lines (\d+)–(\d+); use start_line=(\d+)/.exec(result);
    expect(match).not.toBeNull();
    expect(Number(match![3])).toBe(Number(match![2]) + 1);
    expect(result.length).toBeLessThan(content.length);

    const next = await toolbox().execute(
      'read_file',
      JSON.stringify({ path: 'big.txt', start_line: Number(match![3]) }),
      context,
    );
    expect(next).toContain(`${Number(match![3])} | line ${Number(match![3]) - 1} `);
  });

  it('appends AGENTS.md from an ancestor directory as a system reminder', async () => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Always run npm test.\n', 'utf-8');
    await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'deep', 'a.ts'), 'const a = 1;\n', 'utf-8');
    const result = await toolbox().execute('read_file', JSON.stringify({ path: 'src/deep/a.ts' }), context);
    expect(result).toContain('const a = 1;');
    expect(result).toContain('<system-reminder>');
    expect(result).toContain('Always run npm test.');
  });

  it('uses the nearest AGENTS.md and not a farther one', async () => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'root rules\n', 'utf-8');
    await fs.mkdir(path.join(root, 'pkg'), { recursive: true });
    await fs.writeFile(path.join(root, 'pkg', 'AGENTS.md'), 'pkg rules\n', 'utf-8');
    await fs.writeFile(path.join(root, 'pkg', 'x.ts'), 'const x = 1;\n', 'utf-8');
    const result = await toolbox().execute('read_file', JSON.stringify({ path: 'pkg/x.ts' }), context);
    expect(result).toContain('pkg rules');
    expect(result).not.toContain('root rules');
  });
});
