import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { listWorkspaceFiles } from '../util/fsWalk';

const exec = promisify(execFile);

export interface CheckpointInfo {
  id: string;
  label: string;
  createdAt: number;
}

export class CheckpointManager {
  constructor(
    private readonly root: string,
    private readonly storageDir: string,
  ) {}

  async isGitRepo(): Promise<boolean> {
    try {
      await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.root });
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(label: string): Promise<string | undefined> {
    if (!(await this.isGitRepo())) {
      return undefined;
    }
    await fs.mkdir(this.storageDir, { recursive: true });
    const indexPath = path.join(this.storageDir, `index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };

    try {
      await exec('git', ['add', '-A'], { cwd: this.root, env, maxBuffer: 50 * 1024 * 1024 });
      const { stdout: treeOutput } = await exec('git', ['write-tree'], { cwd: this.root, env });
      const tree = treeOutput.trim();

      let head = '';
      try {
        const result = await exec('git', ['rev-parse', 'HEAD'], { cwd: this.root });
        head = result.stdout.trim();
      } catch {
        head = '';
      }

      const commitArgs = ['commit-tree', tree, '-m', `dev-first checkpoint: ${label}`];
      if (head) {
        commitArgs.push('-p', head);
      }
      const { stdout: commitOutput } = await exec('git', commitArgs, { cwd: this.root, env });
      const commit = commitOutput.trim();

      const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      await exec('git', ['update-ref', `refs/dev-first/checkpoints/${id}`, commit], { cwd: this.root });
      return id;
    } catch {
      return undefined;
    } finally {
      await fs.rm(indexPath, { force: true }).catch(() => undefined);
    }
  }

  async restore(id: string): Promise<string> {
    if (!(await this.isGitRepo())) {
      return 'Checkpoints require a git repository.';
    }
    const ref = `refs/dev-first/checkpoints/${id}`;
    try {
      await exec('git', ['rev-parse', '--verify', ref], { cwd: this.root });
    } catch {
      return `Checkpoint ${id} not found.`;
    }

    const { stdout: fileList } = await exec('git', ['ls-tree', '-r', '--name-only', ref], {
      cwd: this.root,
      maxBuffer: 50 * 1024 * 1024,
    });
    const snapshotFiles = new Set(fileList.split('\n').map((line) => line.trim()).filter(Boolean));

    const currentFiles = await listWorkspaceFiles(this.root, { maxEntries: 5000 });
    for (const relative of currentFiles) {
      if (!snapshotFiles.has(relative)) {
        await fs.rm(path.join(this.root, relative), { force: true }).catch(() => undefined);
      }
    }

    await fs.mkdir(this.storageDir, { recursive: true });
    const indexPath = path.join(this.storageDir, `restore-${Date.now()}`);
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      await exec('git', ['read-tree', ref], { cwd: this.root, env });
      await exec('git', ['checkout-index', '-a', '-f'], {
        cwd: this.root,
        env,
        maxBuffer: 50 * 1024 * 1024,
      });
    } finally {
      await fs.rm(indexPath, { force: true }).catch(() => undefined);
    }

    return `Restored ${snapshotFiles.size} files from checkpoint ${id}.`;
  }
}
