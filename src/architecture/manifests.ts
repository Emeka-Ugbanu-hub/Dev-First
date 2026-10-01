import { readdirSync, readFileSync, statSync } from 'fs';
import type { Dirent } from 'fs';
import { join, relative } from 'path';

export interface PackageRoot {
  root: string;
  name: string;
}

export interface PackageManifest {
  name?: string;
  workspaces: string[];
}

export const MANIFEST_SCAN_DEPTH = 3;

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  'coverage',
  'vendor',
]);

function normalizeRoot(value: string): string {
  const clean = value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  return clean || '.';
}

function baseName(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name))
    .map((entry) => join(dir, entry.name));
}

function tomlSections(raw: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  sections.set('', []);
  let current = '';
  for (const line of raw.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      current = header[1].trim();
      if (!sections.has(current)) {
        sections.set(current, []);
      }
      continue;
    }
    sections.get(current)?.push(line);
  }
  return sections;
}

function tomlString(lines: string[] | undefined, key: string): string | undefined {
  if (!lines) {
    return undefined;
  }
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) {
      const value = match[1].trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function tomlArray(lines: string[] | undefined, key: string): string[] {
  if (!lines) {
    return [];
  }
  const pattern = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`);
  const match = pattern.exec(lines.join('\n'));
  if (!match) {
    return [];
  }
  const values: string[] = [];
  const entry = /["']([^"']+)["']/g;
  let item: RegExpExecArray | null;
  while ((item = entry.exec(match[1])) !== null) {
    const value = item[1].trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
}

export function parsePackageJson(raw: string): PackageManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const workspaces: string[] = [];
  const rawWorkspaces = record.workspaces;
  if (Array.isArray(rawWorkspaces)) {
    for (const entry of rawWorkspaces) {
      if (typeof entry === 'string' && entry.trim()) {
        workspaces.push(entry.trim());
      }
    }
  } else if (rawWorkspaces && typeof rawWorkspaces === 'object') {
    const packages = (rawWorkspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      for (const entry of packages) {
        if (typeof entry === 'string' && entry.trim()) {
          workspaces.push(entry.trim());
        }
      }
    }
  }
  return { ...(name ? { name } : {}), workspaces };
}

export function parseCargoToml(raw: string): PackageManifest | undefined {
  const sections = tomlSections(raw);
  const name = tomlString(sections.get('package'), 'name');
  const workspaces = tomlArray(sections.get('workspace'), 'members');
  if (!name && workspaces.length === 0 && !sections.has('package') && !sections.has('workspace')) {
    return undefined;
  }
  return { ...(name ? { name } : {}), workspaces };
}

export function parseGoMod(raw: string): string | undefined {
  const match = /^\s*module\s+("?)([^"\s]+)\1/m.exec(raw);
  if (!match) {
    return undefined;
  }
  const path = match[2].replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1];
}

export function parsePyprojectToml(raw: string): string | undefined {
  const sections = tomlSections(raw);
  return (
    tomlString(sections.get('project'), 'name') ??
    tomlString(sections.get('tool.poetry'), 'name')
  );
}

function readManifest(dir: string): PackageManifest | undefined {
  const pkg = readText(join(dir, 'package.json'));
  if (pkg !== undefined) {
    return parsePackageJson(pkg) ?? { workspaces: [] };
  }
  const cargo = readText(join(dir, 'Cargo.toml'));
  if (cargo !== undefined) {
    return parseCargoToml(cargo) ?? { workspaces: [] };
  }
  const go = readText(join(dir, 'go.mod'));
  if (go !== undefined) {
    const name = parseGoMod(go);
    return { ...(name ? { name } : {}), workspaces: [] };
  }
  const pyproject = readText(join(dir, 'pyproject.toml'));
  if (pyproject !== undefined) {
    const name = parsePyprojectToml(pyproject);
    return { ...(name ? { name } : {}), workspaces: [] };
  }
  return undefined;
}

function expandWorkspace(root: string, pattern: string): string[] {
  const clean = pattern
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!clean || clean === '.') {
    return [root];
  }
  let dirs = [root];
  for (const segment of clean.split('/')) {
    if (segment === '**') {
      continue;
    }
    const next: string[] = [];
    for (const dir of dirs) {
      if (segment === '*') {
        next.push(...listDirectories(dir));
        continue;
      }
      const candidate = join(dir, segment);
      if (isDirectory(candidate)) {
        next.push(candidate);
      }
    }
    dirs = next;
  }
  return dirs;
}

export function findPackageRoots(
  root: string,
  maxDepth: number = MANIFEST_SCAN_DEPTH,
): PackageRoot[] {
  if (!root) {
    return [];
  }
  const found = new Map<string, string>();
  const workspaces = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    const manifest = readManifest(dir);
    if (manifest) {
      found.set(normalizeRoot(relative(root, dir)), manifest.name ?? baseName(dir));
      for (const workspace of manifest.workspaces) {
        workspaces.add(workspace);
      }
    }
    for (const child of listDirectories(dir)) {
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  for (const workspace of workspaces) {
    for (const dir of expandWorkspace(root, workspace)) {
      const key = normalizeRoot(relative(root, dir));
      if (found.has(key)) {
        continue;
      }
      const manifest = readManifest(dir);
      found.set(key, manifest?.name ?? baseName(dir));
    }
  }
  return [...found.entries()]
    .map(([dir, name]) => ({ root: dir, name }))
    .sort((a, b) => a.root.localeCompare(b.root));
}
