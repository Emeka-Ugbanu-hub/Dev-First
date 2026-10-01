import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export type SandboxMode = 'off' | 'workspace-write';

export interface SandboxCommand {
  file: string;
  args: string[];
}

export interface SandboxResult {
  command?: SandboxCommand;
  note?: string;
}

export function writableDirs(workspace: string): string[] {
  const home = os.homedir();
  return [
    workspace,
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
    '/private/var/folders',
    path.join(home, '.dev-first'),
    path.join(home, '.npm'),
    path.join(home, '.cache'),
    path.join(home, '.cargo'),
    path.join(home, '.rustup'),
    path.join(home, '.gradle'),
    path.join(home, '.m2'),
    path.join(home, '.bun'),
    path.join(home, '.deno'),
    path.join(home, '.local'),
    path.join(home, '.config'),
    path.join(home, '.pnpm-store'),
    path.join(home, 'go'),
    path.join(home, 'Library', 'Caches'),
    path.join(home, 'Library', 'pnpm'),
  ];
}

export function buildSeatbeltProfile(writable: string[]): string {
  const allowRules = writable
    .map((dir) => `(allow file-write* (subpath "${escapeSeatbelt(dir)}"))`)
    .join('');
  const deviceRules = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/fd']
    .map((device) => `(allow file-write* (literal "${device}"))`)
    .join('');
  return `(version 1)(allow default)(deny file-write*)${allowRules}${deviceRules}`;
}

export function sandboxCommand(command: string, workspace: string, mode: SandboxMode): SandboxResult {
  if (mode === 'off') {
    return {};
  }

  if (process.platform === 'darwin') {
    if (!commandExists('sandbox-exec')) {
      return { note: 'sandbox-exec is not available on this system; the command ran without a sandbox.' };
    }
    const profile = buildSeatbeltProfile(writableDirs(workspace));
    return { command: { file: 'sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', command] } };
  }

  if (process.platform === 'linux') {
    if (!commandExists('bwrap')) {
      return { note: 'bubblewrap (bwrap) is not installed; the command ran without a sandbox.' };
    }
    return {
      command: {
        file: 'bwrap',
        args: [
          '--ro-bind',
          '/',
          '/',
          '--bind',
          workspace,
          workspace,
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '/bin/sh',
          '-c',
          command,
        ],
      },
    };
  }

  return { note: `Sandboxing is not supported on ${process.platform}; the command ran without a sandbox.` };
}

function commandExists(name: string): boolean {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function escapeSeatbelt(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
