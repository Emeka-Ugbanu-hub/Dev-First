import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { includeBaseDir, matchesWorktreeInclude, parseWorktreeInclude } from './worktreeInclude';

const exec = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export type MergeResult = { status: 'merged' } | { status: 'conflict'; conflicts: string[] };

export class WorktreeManager {
  constructor(private readonly root: string) {}

  async isGitRepo(): Promise<boolean> {
    try {
      await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.root });
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<WorktreeInfo[]> {
    try {
      const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: this.root });
      const worktrees: WorktreeInfo[] = [];
      let currentPath = '';
      let currentBranch = '';
      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (currentPath) {
            worktrees.push({ path: currentPath, branch: currentBranch });
          }
          currentPath = line.slice('worktree '.length).trim();
          currentBranch = '';
        } else if (line.startsWith('branch ')) {
          currentBranch = line.slice('branch '.length).replace('refs/heads/', '').trim();
        }
      }
      if (currentPath) {
        worktrees.push({ path: currentPath, branch: currentBranch });
      }
      return worktrees;
    } catch {
      return [];
    }
  }

  async create(name: string): Promise<WorktreeInfo> {
    if (!(await this.isGitRepo())) {
      throw new Error('Worktrees require a git repository.');
    }
    const sanitized = name
      .trim()
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
    if (!sanitized) {
      throw new Error('Provide a name for the worktree.');
    }
    const branch = `dev-first/${sanitized}`;
    const worktreePath = path.join(this.root, '.dev-first', 'worktrees', sanitized);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    const worktrees = await this.list();
    if (worktrees.some((entry) => entry.path === worktreePath)) {
      return { path: worktreePath, branch };
    }

    try {
      await exec('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], { cwd: this.root });
    } catch (error) {
      throw new Error(
        `Could not create worktree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.excludeDevFirstDir();
    await this.copyIncludes(worktreePath);
    return { path: worktreePath, branch };
  }

  async currentBranch(): Promise<string> {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.root });
    return stdout.trim();
  }

  async merge(branch: string): Promise<MergeResult> {
    try {
      await exec('git', ['merge', '--no-edit', branch], { cwd: this.root });
      return { status: 'merged' };
    } catch (error) {
      const conflicts = await this.conflictedFiles();
      if (conflicts.length > 0) {
        return { status: 'conflict', conflicts };
      }
      throw new Error(`Could not merge: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteBranch(branch: string): Promise<string> {
    const trimmed = branch.trim();
    if (!trimmed) {
      throw new Error('No branch to delete.');
    }
    const current = await this.currentBranch().catch(() => '');
    if (trimmed === current) {
      throw new Error(`Cannot delete the checked-out branch ${trimmed}.`);
    }
    try {
      await exec('git', ['branch', '-D', trimmed], { cwd: this.root });
      return `Deleted branch ${trimmed}.`;
    } catch (error) {
      throw new Error(
        `Could not delete branch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async remove(worktreePath: string): Promise<string> {
    try {
      await exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: this.root });
      return `Removed worktree ${worktreePath}.`;
    } catch (error) {
      throw new Error(
        `Could not remove worktree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async conflictedFiles(): Promise<string[]> {
    try {
      const { stdout } = await exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: this.root });
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    } catch {
      return [];
    }
  }

  private async copyIncludes(worktreePath: string): Promise<void> {
    const includeFile = path.join(this.root, '.worktreeinclude');
    const content = await fs.readFile(includeFile, 'utf-8').catch(() => undefined);
    if (!content) {
      return;
    }
    const found = new Set<string>();
    for (const pattern of parseWorktreeInclude(content)) {
      if (!pattern.includes('*')) {
        const exists = await fs
          .access(path.join(this.root, pattern))
          .then(() => true)
          .catch(() => false);
        if (exists) {
          found.add(pattern);
        }
        continue;
      }
      const base = includeBaseDir(pattern);
      const start = base ? path.join(this.root, base) : this.root;
      for (const file of await this.walkFiles(start, worktreePath)) {
        const relative = path.relative(this.root, file).split(path.sep).join('/');
        if (matchesWorktreeInclude(pattern, relative)) {
          found.add(relative);
        }
      }
    }
    for (const relative of found) {
      const source = path.join(this.root, relative);
      const destination = path.join(worktreePath, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true }).catch(() => undefined);
      await fs.cp(source, destination, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async walkFiles(dir: string, worktreePath: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (full === worktreePath || full.startsWith(`${worktreePath}${path.sep}`)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.dev-first' || entry.name === 'node_modules') {
          continue;
        }
        files.push(...(await this.walkFiles(full, worktreePath)));
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
    return files;
  }

  private async excludeDevFirstDir(): Promise<void> {
    try {
      const { stdout } = await exec('git', ['rev-parse', '--git-dir'], { cwd: this.root });
      const gitDir = path.isAbsolute(stdout.trim())
        ? stdout.trim()
        : path.join(this.root, stdout.trim());
      const excludeFile = path.join(gitDir, 'info', 'exclude');
      const existing = await fs.readFile(excludeFile, 'utf-8').catch(() => '');
      if (!existing.includes('.dev-first/')) {
        await fs.mkdir(path.dirname(excludeFile), { recursive: true });
        const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
        await fs.appendFile(excludeFile, `${separator}.dev-first/\n`);
      }
    } catch {
      // best effort
    }
  }
}
