import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ToolDef } from '../llm/types';
import { UPDATE_MAX_FILES } from './compoundTools';
import { referenceFilesAt, workspaceSymbolLocations } from './lspTools';
import { listWorkspaceFiles, rgSearch, TEXT_EXTENSIONS } from '../util/fsWalk';

export type ToolPreflight = (args: Record<string, any>) => Promise<string[]>;

export interface RelatedCandidate {
  path: string;
  absolute: string;
}

export function workspaceRootPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function resolveWorkspacePath(relative: string): string | undefined {
  const root = workspaceRootPath();
  if (!root) {
    return undefined;
  }
  return path.resolve(root, relative);
}

export async function preflightAddImportAndUse(args: Record<string, any>): Promise<string[]> {
  const relative = typeof args.path === 'string' ? args.path.trim() : '';
  return relative ? [relative] : [];
}

export async function preflightRenameSymbol(args: Record<string, any>): Promise<string[]> {
  const relative = typeof args.path === 'string' ? args.path.trim() : '';
  if (!relative) {
    return [];
  }
  const absolute = resolveWorkspacePath(relative);
  if (!absolute) {
    return [relative];
  }
  const files = await referenceFilesAt(absolute, args.line, args.character);
  return [...new Set([relative, ...files])];
}

export async function preflightUpdateRelatedFiles(args: Record<string, any>): Promise<string[]> {
  const query = typeof args.symbol_or_pattern === 'string' ? args.symbol_or_pattern.trim() : '';
  if (!query) {
    return [];
  }
  const candidates = await discoverRelatedTargets(query);
  return [...new Set(candidates.slice(0, UPDATE_MAX_FILES).map((candidate) => candidate.path))];
}

export async function preflightRefactorSymbol(args: Record<string, any>): Promise<string[]> {
  const targets: string[] = [];
  for (const key of ['path', 'targetPath']) {
    const value = typeof args[key] === 'string' ? args[key].trim() : '';
    if (value) {
      targets.push(value);
    }
  }
  return [...new Set(targets)];
}

const PREFLIGHTS: Record<string, ToolPreflight> = {
  add_import_and_use: preflightAddImportAndUse,
  rename_symbol: preflightRenameSymbol,
  update_related_files: preflightUpdateRelatedFiles,
  refactor_symbol: preflightRefactorSymbol,
};

export function attachToolPreflights(tools: ToolDef[]): ToolDef[] {
  return tools.map((tool) => (PREFLIGHTS[tool.name] ? { ...tool, preflight: PREFLIGHTS[tool.name] } : tool));
}

export async function discoverRelatedTargets(query: string): Promise<RelatedCandidate[]> {
  const root = workspaceRootPath();
  if (!root) {
    return [];
  }
  if (/^[A-Za-z_$][\w$]*$/.test(query)) {
    try {
      const definitions = await workspaceSymbolLocations(query);
      const definition = definitions.find((candidate) => candidate.name === query) ?? definitions[0];
      if (definition) {
        const files = await referenceFilesAt(definition.absolute, definition.line, definition.character);
        const candidates = files
          .map((file) => ({ path: file, absolute: path.resolve(root, file) }))
          .filter((candidate) => !candidate.path.startsWith('..'));
        if (candidates.length > 0) {
          return candidates;
        }
      }
    } catch {}
  }
  return searchTargets(root, query);
}

export async function searchTargets(root: string, query: string): Promise<RelatedCandidate[]> {
  const ripgrep = await rgSearch({
    root,
    base: root,
    query,
    isRegex: false,
    caseSensitive: false,
    maxResults: 200,
  });
  if (ripgrep !== undefined) {
    const seen = new Set<string>();
    const candidates: RelatedCandidate[] = [];
    for (const match of ripgrep.matches) {
      const absolute = path.isAbsolute(match.file) ? match.file : path.join(root, match.file);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (seen.has(relative)) {
        continue;
      }
      seen.add(relative);
      candidates.push({ path: relative, absolute });
    }
    return candidates;
  }
  const files = await listWorkspaceFiles(root, { maxEntries: 3000, extensions: TEXT_EXTENSIONS });
  const candidates: RelatedCandidate[] = [];
  for (const relative of files) {
    if (candidates.length >= 200) {
      break;
    }
    const absolute = path.join(root, relative);
    let content: string;
    try {
      content = await fs.readFile(absolute, 'utf-8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) {
      continue;
    }
    if (content.includes(query)) {
      candidates.push({ path: relative, absolute });
    }
  }
  return candidates;
}

