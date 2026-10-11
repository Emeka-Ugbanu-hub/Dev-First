import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cargoCandidates,
  goCandidates,
  nodeCandidates,
  pythonCandidates,
  resolveProjectCommands,
  runnerFromLockfiles,
  selectProjectCommand,
} from '../src/agent/projectCommands';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-first-commands-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<void> {
  const absolute = path.join(root, file);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf-8');
}

describe('runnerFromLockfiles', () => {
  it('maps lockfiles to package runners', () => {
    expect(runnerFromLockfiles([])).toBe('npm');
    expect(runnerFromLockfiles(['package-lock.json'])).toBe('npm');
    expect(runnerFromLockfiles(['yarn.lock'])).toBe('yarn');
    expect(runnerFromLockfiles(['bun.lockb'])).toBe('bun');
    expect(runnerFromLockfiles(['pnpm-lock.yaml'])).toBe('pnpm');
    expect(runnerFromLockfiles(['pnpm-workspace.yaml'])).toBe('pnpm');
  });

  it('prefers pnpm over yarn over bun', () => {
    expect(runnerFromLockfiles(['yarn.lock', 'pnpm-lock.yaml'])).toBe('pnpm');
    expect(runnerFromLockfiles(['bun.lockb', 'yarn.lock'])).toBe('yarn');
  });
});

describe('nodeCandidates', () => {
  it('maps script names to kinds with the detected runner', () => {
    const candidates = nodeCandidates(
      JSON.stringify({ scripts: { 'type-check': 'tsc', test: 'vitest', lint: 'eslint .', build: 'vite build' } }),
      'pnpm',
    );
    expect(candidates.map((candidate) => [candidate.kind, candidate.command])).toEqual([
      ['typecheck', 'pnpm run type-check'],
      ['test', 'pnpm run test'],
      ['lint', 'pnpm run lint'],
      ['build', 'pnpm run build'],
    ]);
    expect(candidates.every((candidate) => candidate.source === 'manifest')).toBe(true);
  });

  it('falls back through typecheck script aliases and uses bun runner commands', () => {
    const candidates = nodeCandidates(JSON.stringify({ scripts: { tsc: 'tsc --noEmit' } }), 'bun');
    expect(candidates).toEqual([
      {
        kind: 'typecheck',
        command: 'bun run tsc',
        source: 'manifest',
        reason: 'package.json script "tsc" (runner: bun)',
      },
    ]);
  });

  it('returns nothing for malformed, missing, or blank scripts', () => {
    expect(nodeCandidates('not json', 'npm')).toEqual([]);
    expect(nodeCandidates(JSON.stringify({ name: 'x' }), 'npm')).toEqual([]);
    expect(nodeCandidates(JSON.stringify({ scripts: { test: '   ' } }), 'npm')).toEqual([]);
  });
});

describe('manifest candidates', () => {
  it('detects cargo, go, and python commands', () => {
    expect(cargoCandidates('[package]\nname = "x"\nversion = "0.1.0"').map((candidate) => candidate.command)).toEqual([
      'cargo check',
      'cargo test',
      'cargo clippy',
      'cargo build',
    ]);
    expect(cargoCandidates('')).toEqual([]);
    expect(goCandidates('module example.com/x\n\ngo 1.22\n').map((candidate) => candidate.command)).toEqual([
      'go vet ./...',
      'go test ./...',
      'go build ./...',
    ]);
    expect(goCandidates('')).toEqual([]);
    expect(pythonCandidates('[tool.pytest.ini_options]\n[tool.ruff]\n', '').map((candidate) => [candidate.kind, candidate.command])).toEqual([
      ['test', 'pytest'],
      ['lint', 'ruff check .'],
    ]);
    expect(pythonCandidates('', 'pytest>=7\npyright>=1.1\n').map((candidate) => candidate.kind)).toEqual([
      'test',
      'typecheck',
    ]);
    expect(pythonCandidates('[tool.mypy]\n', '').map((candidate) => [candidate.kind, candidate.command])).toEqual([
      ['typecheck', 'mypy'],
    ]);
    expect(pythonCandidates('[project]\nname = "x"\n', 'numpy\n')).toEqual([]);
  });
});

describe('selectProjectCommand', () => {
  it('prefers typecheck, then test, then lint, then build', () => {
    const candidates = nodeCandidates(
      JSON.stringify({ scripts: { build: 'vite build', lint: 'eslint .', test: 'vitest', typecheck: 'tsc' } }),
      'npm',
    );
    expect(selectProjectCommand(candidates).selected?.command).toBe('npm run typecheck');
    expect(selectProjectCommand(candidates.filter((candidate) => candidate.kind !== 'typecheck')).selected?.command).toBe(
      'npm run test',
    );
    expect(
      selectProjectCommand(candidates.filter((candidate) => candidate.kind === 'lint' || candidate.kind === 'build'))
        .selected?.command,
    ).toBe('npm run lint');
    expect(selectProjectCommand(candidates.filter((candidate) => candidate.kind === 'build')).selected?.command).toBe(
      'npm run build',
    );
  });

  it('reports ambiguity when one kind has multiple candidates', () => {
    const candidates = [
      { kind: 'typecheck' as const, command: 'a', source: 'manifest' as const, reason: 'a' },
      { kind: 'typecheck' as const, command: 'b', source: 'manifest' as const, reason: 'b' },
      { kind: 'test' as const, command: 'c', source: 'manifest' as const, reason: 'c' },
    ];
    expect(selectProjectCommand(candidates)).toEqual({ ambiguous: true });
  });

  it('returns no selection for an empty candidate list', () => {
    expect(selectProjectCommand([])).toEqual({ ambiguous: false });
  });
});

describe('resolveProjectCommands', () => {
  it('detects node commands with the lockfile runner', async () => {
    await write('package.json', JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest' } }));
    await write('yarn.lock', '');
    const resolution = await resolveProjectCommands(root, {});
    expect(resolution.ambiguous).toBe(false);
    expect(resolution.selected).toMatchObject({ kind: 'typecheck', command: 'yarn run typecheck', source: 'manifest' });
    expect(resolution.candidates.map((candidate) => candidate.command)).toEqual([
      'yarn run typecheck',
      'yarn run test',
    ]);
  });

  it('lets configured commands win over detected ones', async () => {
    await write('package.json', JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
    await write('Cargo.toml', '[package]\nname = "x"\n');
    const resolution = await resolveProjectCommands(root, { typecheck: 'custom-check' });
    expect(resolution.ambiguous).toBe(false);
    expect(resolution.selected).toMatchObject({ kind: 'typecheck', command: 'custom-check', source: 'config' });
    expect(resolution.candidates.filter((candidate) => candidate.kind === 'typecheck')).toHaveLength(1);
    expect(resolution.candidates.some((candidate) => candidate.command === 'cargo check')).toBe(false);
  });

  it('flags ambiguity when two ecosystems provide the same kind', async () => {
    await write('package.json', JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
    await write('Cargo.toml', '[package]\nname = "x"\n');
    const resolution = await resolveProjectCommands(root, {});
    expect(resolution.ambiguous).toBe(true);
    expect(resolution.selected).toBeUndefined();
    expect(resolution.candidates.filter((candidate) => candidate.kind === 'typecheck')).toHaveLength(2);
  });

  it('flags ambiguity for two python typecheck tools', async () => {
    await write('requirements.txt', 'pyright\nmypy\n');
    const resolution = await resolveProjectCommands(root, {});
    expect(resolution.ambiguous).toBe(true);
    expect(resolution.selected).toBeUndefined();
  });

  it('detects cargo, go, and python where node is absent', async () => {
    await write('Cargo.toml', '[workspace]\nmembers = []\n');
    const cargo = await resolveProjectCommands(root, {});
    expect(cargo.selected).toMatchObject({ kind: 'typecheck', command: 'cargo check' });
    await fs.rm(path.join(root, 'Cargo.toml'));
    await write('go.mod', 'module example.com/x\n');
    const go = await resolveProjectCommands(root, {});
    expect(go.selected).toMatchObject({ kind: 'typecheck', command: 'go vet ./...' });
    await fs.rm(path.join(root, 'go.mod'));
    await write('pyproject.toml', '[tool.pytest.ini_options]\n');
    const python = await resolveProjectCommands(root, {});
    expect(python.selected).toMatchObject({ kind: 'test', command: 'pytest' });
  });

  it('returns an empty resolution when nothing is detected', async () => {
    const resolution = await resolveProjectCommands(root, {});
    expect(resolution).toEqual({ candidates: [], ambiguous: false });
  });

  it('ignores blank configured commands', async () => {
    await write('package.json', JSON.stringify({ scripts: { build: 'vite build' } }));
    const resolution = await resolveProjectCommands(root, { test: '   ', build: '' });
    expect(resolution.selected).toMatchObject({ kind: 'build', command: 'npm run build' });
    expect(resolution.candidates.every((candidate) => candidate.source === 'manifest')).toBe(true);
  });
});
