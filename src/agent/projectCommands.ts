import { promises as fs } from 'fs';
import * as path from 'path';

export type ProjectCommandKind = 'typecheck' | 'test' | 'lint' | 'build';
export type ProjectCommandSource = 'config' | 'manifest' | 'lockfile';

export interface ProjectCommandCandidate {
  kind: ProjectCommandKind;
  command: string;
  source: ProjectCommandSource;
  reason: string;
}

export interface ProjectCommandSelection {
  selected?: ProjectCommandCandidate;
  ambiguous: boolean;
}

export interface ProjectCommandResolution extends ProjectCommandSelection {
  candidates: ProjectCommandCandidate[];
}

export interface ProjectCommandConfig {
  typecheck?: string;
  test?: string;
  lint?: string;
  build?: string;
}

export const PROJECT_COMMAND_KINDS: ProjectCommandKind[] = ['typecheck', 'test', 'lint', 'build'];

const KIND_PREFERENCE: ProjectCommandKind[] = ['typecheck', 'test', 'lint', 'build'];

const NODE_SCRIPTS: Array<{ kind: ProjectCommandKind; names: string[] }> = [
  { kind: 'typecheck', names: ['typecheck', 'type-check', 'tsc'] },
  { kind: 'test', names: ['test'] },
  { kind: 'lint', names: ['lint'] },
  { kind: 'build', names: ['build'] },
];

export function runnerFromLockfiles(names: string[]): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const set = new Set(names);
  if (set.has('pnpm-workspace.yaml') || set.has('pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (set.has('yarn.lock')) {
    return 'yarn';
  }
  if (set.has('bun.lockb')) {
    return 'bun';
  }
  return 'npm';
}

export function nodeCandidates(packageJsonText: string, runner: string): ProjectCommandCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') {
    return [];
  }
  const table = scripts as Record<string, unknown>;
  const candidates: ProjectCommandCandidate[] = [];
  for (const entry of NODE_SCRIPTS) {
    const name = entry.names.find((candidate) => typeof table[candidate] === 'string' && table[candidate].trim());
    if (!name) {
      continue;
    }
    candidates.push({
      kind: entry.kind,
      command: `${runner} run ${name}`,
      source: 'manifest',
      reason: `package.json script "${name}" (runner: ${runner})`,
    });
  }
  return candidates;
}

export function cargoCandidates(cargoTomlText: string): ProjectCommandCandidate[] {
  if (!/\[(package|workspace)\]/m.test(cargoTomlText)) {
    return [];
  }
  return [
    { kind: 'typecheck', command: 'cargo check', source: 'manifest', reason: 'Cargo.toml: cargo check' },
    { kind: 'test', command: 'cargo test', source: 'manifest', reason: 'Cargo.toml: cargo test' },
    { kind: 'lint', command: 'cargo clippy', source: 'manifest', reason: 'Cargo.toml: cargo clippy' },
    { kind: 'build', command: 'cargo build', source: 'manifest', reason: 'Cargo.toml: cargo build' },
  ];
}

export function goCandidates(goModText: string): ProjectCommandCandidate[] {
  if (!/^\s*module\s+\S+/m.test(goModText)) {
    return [];
  }
  return [
    { kind: 'typecheck', command: 'go vet ./...', source: 'manifest', reason: 'go.mod: go vet ./...' },
    { kind: 'test', command: 'go test ./...', source: 'manifest', reason: 'go.mod: go test ./...' },
    { kind: 'build', command: 'go build ./...', source: 'manifest', reason: 'go.mod: go build ./...' },
  ];
}

export function pythonCandidates(pyprojectText: string, requirementsText: string): ProjectCommandCandidate[] {
  const candidates: ProjectCommandCandidate[] = [];
  if (/\bpytest\b/.test(pyprojectText) || /^\s*pytest\b/m.test(requirementsText)) {
    candidates.push({ kind: 'test', command: 'pytest', source: 'manifest', reason: 'pytest detected' });
  }
  if (/\bpyright\b/.test(pyprojectText) || /^\s*pyright\b/m.test(requirementsText)) {
    candidates.push({ kind: 'typecheck', command: 'pyright', source: 'manifest', reason: 'pyright detected' });
  }
  if (/\bmypy\b/.test(pyprojectText) || /^\s*mypy\b/m.test(requirementsText)) {
    candidates.push({ kind: 'typecheck', command: 'mypy', source: 'manifest', reason: 'mypy detected' });
  }
  if (/\bruff\b/.test(pyprojectText) || /^\s*ruff\b/m.test(requirementsText)) {
    candidates.push({ kind: 'lint', command: 'ruff check .', source: 'manifest', reason: 'ruff detected' });
  }
  return candidates;
}

export function selectProjectCommand(candidates: ProjectCommandCandidate[]): ProjectCommandSelection {
  for (const kind of KIND_PREFERENCE) {
    if (candidates.filter((candidate) => candidate.kind === kind).length > 1) {
      return { ambiguous: true };
    }
  }
  for (const kind of KIND_PREFERENCE) {
    const selected = candidates.find((candidate) => candidate.kind === kind);
    if (selected) {
      return { selected, ambiguous: false };
    }
  }
  return { ambiguous: false };
}

export function describeCandidate(candidate: ProjectCommandCandidate): string {
  return `${candidate.kind}: ${candidate.command} (${candidate.source} — ${candidate.reason})`;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return undefined;
  }
}

export async function resolveProjectCommands(
  root: string,
  configCommands: ProjectCommandConfig,
): Promise<ProjectCommandResolution> {
  const candidates: ProjectCommandCandidate[] = [];
  const configured = new Set<ProjectCommandKind>();
  for (const kind of PROJECT_COMMAND_KINDS) {
    const command = (configCommands[kind] ?? '').trim();
    if (command) {
      configured.add(kind);
      candidates.push({ kind, command, source: 'config', reason: 'configured in Dev-First settings' });
    }
  }
  let names: string[] = [];
  try {
    names = await fs.readdir(root);
  } catch {
    names = [];
  }
  const present = new Set(names);
  const add = (found: ProjectCommandCandidate[]) => {
    for (const candidate of found) {
      if (!configured.has(candidate.kind)) {
        candidates.push(candidate);
      }
    }
  };
  if (present.has('package.json')) {
    const text = await readIfExists(path.join(root, 'package.json'));
    if (text !== undefined) {
      add(nodeCandidates(text, runnerFromLockfiles(names)));
    }
  }
  if (present.has('Cargo.toml')) {
    const text = await readIfExists(path.join(root, 'Cargo.toml'));
    if (text !== undefined) {
      add(cargoCandidates(text));
    }
  }
  if (present.has('go.mod')) {
    const text = await readIfExists(path.join(root, 'go.mod'));
    if (text !== undefined) {
      add(goCandidates(text));
    }
  }
  if (present.has('pyproject.toml') || present.has('requirements.txt')) {
    const pyproject = present.has('pyproject.toml')
      ? (await readIfExists(path.join(root, 'pyproject.toml'))) ?? ''
      : '';
    const requirements = present.has('requirements.txt')
      ? (await readIfExists(path.join(root, 'requirements.txt'))) ?? ''
      : '';
    add(pythonCandidates(pyproject, requirements));
  }
  return { candidates, ...selectProjectCommand(candidates) };
}
