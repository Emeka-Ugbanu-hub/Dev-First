import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const MAX_STATUS_FILES = 12;
const MAX_COMMITS = 5;
const MAX_SUBJECT_LENGTH = 120;

export interface GitContext {
  branch?: string;
  changedFiles: string[];
  commits: string[];
}

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: root,
      timeout: 1500,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    // A workspace does not need to be a Git repository.
    return undefined;
  }
}

/**
 * Read a small, read-only snapshot of repository state. This deliberately
 * excludes diffs and file contents: it is orientation context, not evidence
 * for a code change.
 */
export async function readGitContext(root: string): Promise<GitContext | undefined> {
  const [branch, status, log] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--short']),
    git(root, ['log', '-5', '--pretty=format:%h %s']),
  ]);
  if (branch === undefined && status === undefined && log === undefined) return undefined;

  const changedFiles = (status ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^.{1,2}\s+/, ''))
    .filter(Boolean)
    .slice(0, MAX_STATUS_FILES);
  const commits = (log ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().slice(0, MAX_SUBJECT_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_COMMITS);
  return {
    ...(branch ? { branch } : {}),
    changedFiles,
    commits,
  };
}

export function formatGitContext(context: GitContext | undefined): string {
  if (!context) return '';
  const lines = ['[Git context — read-only snapshot]'];
  if (context.branch) lines.push(`Branch: ${context.branch}`);
  if (context.changedFiles.length > 0) {
    lines.push(`Changed files (${context.changedFiles.length}${context.changedFiles.length === MAX_STATUS_FILES ? '+' : ''}): ${context.changedFiles.join(', ')}`);
  } else {
    lines.push('Working tree: clean');
  }
  if (context.commits.length > 0) {
    lines.push(`Recent commits: ${context.commits.join(' | ')}`);
  }
  lines.push('Use this only to understand repository state; inspect files before making claims.');
  return lines.join('\n');
}
