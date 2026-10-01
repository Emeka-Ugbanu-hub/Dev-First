import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('vscode', () => ({}));

import { ToolBox } from '../src/agent/ToolBox';

let root: string;
let applyChange: ReturnType<typeof vi.fn>;
let applyDeletion: ReturnType<typeof vi.fn>;

function toolbox(): ToolBox {
  applyChange = vi.fn(async (file: string, content: string) => {
    await fs.writeFile(file, content, 'utf-8');
    return `Applied changes to ${path.basename(file)}.`;
  });
  applyDeletion = vi.fn(async (file: string) => {
    await fs.unlink(file);
    return `Deleted ${path.basename(file)}.`;
  });
  return new ToolBox({
    root,
    diffManager: { applyChange, applyDeletion } as any,
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-patch-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('apply_patch validate then commit', () => {
  it('applies every operation when all hunks resolve', async () => {
    await fs.writeFile(path.join(root, 'b.txt'), 'present\n', 'utf-8');
    const result = await toolbox().execute(
      'apply_patch',
      JSON.stringify({
        patch: `*** Begin Patch
*** Add File: a.txt
+hello
*** Update File: b.txt
@@
-present
+changed
*** End Patch`,
      }),
      context,
    );
    expect(result).toContain('Applied changes to a.txt.');
    expect(result).toContain('Applied changes to b.txt.');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('hello');
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('changed\n');
  });

  it('writes nothing when a later hunk fails', async () => {
    await fs.writeFile(path.join(root, 'b.txt'), 'present\n', 'utf-8');
    const result = await toolbox().execute(
      'apply_patch',
      JSON.stringify({
        patch: `*** Begin Patch
*** Add File: a.txt
+hello
*** Update File: b.txt
@@
-missing
+changed
*** End Patch`,
      }),
      context,
    );
    expect(result).toContain('Error in b.txt');
    expect(result).toContain('Could not locate');
    expect(applyChange).not.toHaveBeenCalled();
    expect(applyDeletion).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, 'a.txt'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('present\n');
  });

  it('aborts a delete of a missing file without touching other operations', async () => {
    const result = await toolbox().execute(
      'apply_patch',
      JSON.stringify({
        patch: `*** Begin Patch
*** Add File: a.txt
+hello
*** Delete File: missing.txt
*** End Patch`,
      }),
      context,
    );
    expect(result).toContain('missing.txt does not exist');
    expect(applyChange).not.toHaveBeenCalled();
    expect(applyDeletion).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, 'a.txt'))).rejects.toThrow();
  });

  it('lets a later update see an earlier update in the same patch', async () => {
    await fs.writeFile(path.join(root, 'b.txt'), 'one\n', 'utf-8');
    const result = await toolbox().execute(
      'apply_patch',
      JSON.stringify({
        patch: `*** Begin Patch
*** Update File: b.txt
@@
-one
+two
*** Update File: b.txt
@@
-two
+three
*** End Patch`,
      }),
      context,
    );
    expect(result).toContain('Applied changes to b.txt.');
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('three\n');
  });
});
