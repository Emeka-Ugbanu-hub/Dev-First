import * as path from 'path';
import { ToolDef } from '../llm/types';
import { PatchHunk, parsePatch } from './patch';

export const MAX_CHANGE_SET_FILES = 50;
export const UPDATE_CONFIRM_THRESHOLD = 10;
export const UPDATE_MAX_FILES = 20;

export type ChangeSetAction = 'edit' | 'create' | 'delete';

export interface ChangeSetEntry {
  path: string;
  action: ChangeSetAction;
  patch?: string;
  content?: string;
}

export interface ChangeSetValidation {
  ok: boolean;
  changes: ChangeSetEntry[];
  error?: string;
}

export function isWorkspaceRelativePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed)) {
    return false;
  }
  const normalized = path.normalize(trimmed).split(path.sep).join('/');
  return Boolean(normalized) && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

export function validateChangeSet(args: Record<string, any>): ChangeSetValidation {
  const raw = args.changes;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, changes: [], error: 'changes must be a non-empty array of { path, action, patch?, content? }.' };
  }
  if (raw.length > MAX_CHANGE_SET_FILES) {
    return { ok: false, changes: [], error: `changes is limited to ${MAX_CHANGE_SET_FILES} entries per call.` };
  }
  const changes: ChangeSetEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, changes: [], error: `changes[${index}] must be an object.` };
    }
    const relative = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!isWorkspaceRelativePath(relative)) {
      return {
        ok: false,
        changes: [],
        error: `changes[${index}].path must be a workspace-relative path without escapes.`,
      };
    }
    if (seen.has(relative)) {
      return { ok: false, changes: [], error: `changes[${index}].path duplicates "${relative}".` };
    }
    seen.add(relative);
    if (entry.action !== 'edit' && entry.action !== 'create' && entry.action !== 'delete') {
      return { ok: false, changes: [], error: `changes[${index}].action must be edit, create, or delete.` };
    }
    const patch = typeof entry.patch === 'string' && entry.patch.trim() ? entry.patch : undefined;
    const content = typeof entry.content === 'string' ? entry.content : undefined;
    if (entry.action === 'edit' && !patch && content === undefined) {
      return { ok: false, changes: [], error: `changes[${index}] (edit) requires patch or content.` };
    }
    if (entry.action === 'edit' && patch && content !== undefined) {
      return { ok: false, changes: [], error: `changes[${index}] (edit) must use either patch or content, not both.` };
    }
    if (entry.action === 'create' && content === undefined) {
      return { ok: false, changes: [], error: `changes[${index}] (create) requires content.` };
    }
    changes.push({ path: relative, action: entry.action, ...(patch ? { patch } : {}), ...(content !== undefined ? { content } : {}) });
  }
  return { ok: true, changes };
}

export function detectVerifyCommand(packageJsonText: string): { script: string; command: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') {
    return undefined;
  }
  const table = scripts as Record<string, unknown>;
  for (const name of ['typecheck', 'test', 'build']) {
    if (typeof table[name] === 'string' && table[name].trim()) {
      return { script: name, command: `npm run ${name}` };
    }
  }
  return undefined;
}

export function parseHunks(text: string): PatchHunk[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current && current.lines.length > 0) {
        hunks.push(current);
      }
      current = { lines: [] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current && current.lines.length > 0) {
    hunks.push(current);
  }
  return hunks;
}

export function patchHunksFor(text: string): PatchHunk[] {
  if (text.includes('*** ')) {
    return parsePatch(text)
      .filter((operation) => operation.type === 'update' && operation.hunks?.length)
      .flatMap((operation) => operation.hunks ?? []);
  }
  return parseHunks(text);
}

export function isWorkspaceIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value.trim());
}

export function symbolNameFromEntry(entry: string): string | undefined {
  const match = /^\s*\w+\s+(.+?)\s+\(line\s+\d+\)$/.exec(entry);
  return match?.[1];
}

export function symbolAtLine(content: string, line: number): string | undefined {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const target = lines[Math.max(0, Math.min(lines.length - 1, line - 1))];
  if (!target) {
    return undefined;
  }
  const matches = target.match(/[A-Za-z_$][\w$]*/g);
  if (!matches?.length) {
    return undefined;
  }
  const keywords = new Set(['const', 'let', 'var', 'function', 'class', 'return', 'import', 'from', 'export', 'if', 'else', 'for', 'while', 'new', 'await', 'async', 'type', 'interface', 'default']);
  return matches.find((match) => !keywords.has(match)) ?? matches[0];
}

export function wordAtPosition(content: string, line: number, character: number): string | undefined {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const target = lines[Math.max(0, Math.min(lines.length - 1, line - 1))];
  if (!target) {
    return undefined;
  }
  const column = Math.max(0, Math.min(target.length, character - 1));
  const regex = /[A-Za-z_$][\w$]*/g;
  let match: RegExpExecArray | null;
  let nearest: string | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  while ((match = regex.exec(target)) !== null) {
    if (column >= match.index && column <= match.index + match[0].length) {
      return match[0];
    }
    const distance = Math.min(Math.abs(column - match.index), Math.abs(column - (match.index + match[0].length)));
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = match[0];
    }
  }
  return nearestDistance <= 2 ? nearest : undefined;
}

export function renameInContent(content: string, name: string, newName: string): { content: string; count: number } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'g');
  const count = content.match(regex)?.length ?? 0;
  return { content: content.replace(regex, newName), count };
}

export function buildImportStatement(symbol: string, source: string, existingContent: string): string {
  const doubleQuoted = (existingContent.match(/from\s+"/g)?.length ?? 0) > (existingContent.match(/from\s+'/g)?.length ?? 0);
  const quote = doubleQuoted ? '"' : "'";
  return `import { ${symbol} } from ${quote}${source}${quote};`;
}

export function insertImport(content: string, statement: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let insertAt = 0;
  if (lines[0]?.startsWith('#!')) {
    insertAt = 1;
  }
  let lastImport = -1;
  for (let index = insertAt; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*$/.test(line) && lastImport < 0) {
      continue;
    }
    if (/^\s*import\b/.test(line) || /^\s*from\s+\S+\s+import\b/.test(line)) {
      lastImport = index;
      continue;
    }
    break;
  }
  const index = lastImport >= 0 ? lastImport + 1 : insertAt;
  lines.splice(index, 0, statement);
  return lines.join('\n').replace(/\n/g, eol);
}

export interface RefactorRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export function parseRefactorRange(raw: unknown): RefactorRange | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const startLine = Number(value.startLine);
  const startChar = Number(value.startChar);
  const endLine = Number(value.endLine);
  const endChar = Number(value.endChar);
  if (![startLine, startChar, endLine, endChar].every((number) => Number.isFinite(number) && number >= 1)) {
    return undefined;
  }
  if (endLine < startLine || (endLine === startLine && endChar < startChar)) {
    return undefined;
  }
  return {
    startLine: Math.floor(startLine),
    startChar: Math.floor(startChar),
    endLine: Math.floor(endLine),
    endChar: Math.floor(endChar),
  };
}

export function rangeText(content: string, range: RefactorRange): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(0, range.startLine - 1);
  const end = Math.min(lines.length - 1, range.endLine - 1);
  if (start > end) {
    return '';
  }
  if (start === end) {
    return lines[start].slice(Math.max(0, range.startChar - 1), Math.max(0, range.endChar - 1));
  }
  const parts = [lines[start].slice(Math.max(0, range.startChar - 1))];
  for (let index = start + 1; index < end; index++) {
    parts.push(lines[index]);
  }
  parts.push(lines[end].slice(0, Math.max(0, range.endChar - 1)));
  return parts.join('\n');
}

export function replaceRange(content: string, range: RefactorRange, replacement: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(0, range.startLine - 1);
  const end = Math.min(lines.length - 1, range.endLine - 1);
  if (start > end) {
    return content;
  }
  const startChar = Math.max(0, range.startChar - 1);
  const endChar = Math.max(0, range.endChar - 1);
  const updated = `${lines[start].slice(0, startChar)}${replacement}${lines[end].slice(endChar)}`;
  const replacementLines = updated.split('\n');
  lines.splice(start, end - start + 1, ...replacementLines);
  return lines.join(eol === '\r\n' ? '\n' : eol).replace(/\n/g, eol);
}

export function removeRange(content: string, range: RefactorRange): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(0, range.startLine - 1);
  const end = Math.min(lines.length - 1, range.endLine - 1);
  if (start > end) {
    return content;
  }
  const startChar = Math.max(0, range.startChar - 1);
  const endChar = Math.max(0, range.endChar - 1);
  const wholeLines = startChar === 0 && endChar >= lines[end].length;
  if (wholeLines) {
    lines.splice(start, end - start + 1);
    if (start < lines.length && lines[start] === '' && start > 0) {
      lines.splice(start, 1);
    }
  } else {
    const merged = `${lines[start].slice(0, startChar)}${lines[end].slice(endChar)}`;
    lines.splice(start, end - start + 1, merged);
  }
  return lines.join(eol === '\r\n' ? '\n' : eol).replace(/\n/g, eol);
}

export function appendSnippet(content: string, snippet: string, eol: string = '\n'): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const trimmed = snippet.trimEnd();
  if (!trimmed) {
    return content;
  }
  const base = normalized.endsWith('\n') ? normalized : `${normalized}\n`;
  const separator = base.endsWith('\n\n') ? '' : '\n';
  return `${base}${separator}${trimmed}\n`.replace(/\n/g, eol);
}

export const inspectFileContextTool: ToolDef = {
  name: 'inspect_file_context',
  description:
    'Compact file snapshot: content, symbols, imports, and current diagnostics in one call.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      includeReferences: { type: 'boolean', description: 'Also include a capped reference summary (optional).' },
    },
    required: ['path'],
  },
};

export const investigateIssueTool: ToolDef = {
  name: 'investigate_issue',
  description: 'Read-only investigation and evidence gathering.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      line: { type: 'number', description: '1-based line to investigate (optional).' },
    },
    required: ['path'],
  },
};

export function verifyChangeTools(): { planner: ToolDef; executor: ToolDef } {
  const planner: ToolDef = {
    name: 'verify_change',
    description:
      'Check diagnostics for the given files only; in planning this is read-only and never runs commands.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Workspace-relative file paths to check.',
          items: { type: 'string' },
        },
        mode: {
          type: 'string',
          enum: ['diagnostics'],
          description: 'Always diagnostics during planning.',
        },
      },
      required: ['paths'],
    },
  };
  const executor: ToolDef = {
    name: 'verify_change',
    description: 'Targeted validation after an edit.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Workspace-relative file paths to check.',
          items: { type: 'string' },
        },
        mode: {
          type: 'string',
          enum: ['diagnostics', 'auto'],
          description:
            "diagnostics checks language-server diagnostics only; auto (default) also runs the package.json verification script, preferring typecheck, then test, then build.",
        },
      },
      required: ['paths'],
    },
  };
  return { planner, executor };
}

export const applyChangeSetTool: ToolDef = {
  name: 'apply_change_set',
  description: 'Coordinated changes across related files.',
  parameters: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'Ordered changes to apply atomically with rollback on failure.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            action: { type: 'string', enum: ['edit', 'create', 'delete'] },
            patch: { type: 'string', description: 'Hunks for an edit (@@ blocks, same semantics as apply_patch).' },
            content: { type: 'string', description: 'Full file contents for create, or replacement for edit.' },
          },
          required: ['path', 'action'],
        },
      },
    },
    required: ['changes'],
  },
};

export const fixInFileTool: ToolDef = {
  name: 'fix_in_file',
  description: 'One-file change with checkpoint, exact-match validation, atomic write, and diagnostics.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      patch: { type: 'string', description: 'Hunks to apply (@@ blocks, same semantics as apply_patch).' },
      content: { type: 'string', description: 'Full replacement contents (alternative to patch).' },
    },
    required: ['path'],
  },
};

export const fixDiagnosticTool: ToolDef = {
  name: 'fix_diagnostic',
  description: 'Clear one diagnostic at a line and check for regressions.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      line: { type: 'number', description: '1-based line of the diagnostic.' },
      patch: { type: 'string', description: 'Minimal hunks that fix the diagnostic.' },
      content: { type: 'string', description: 'Full replacement contents (alternative to patch).' },
    },
    required: ['path', 'line'],
  },
};

export const addImportAndUseTool: ToolDef = {
  name: 'add_import_and_use',
  description: 'Add the import, apply the use-site edit, and verify diagnostics.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      symbol: { type: 'string', description: 'The symbol to import.' },
      source: { type: 'string', description: 'Module specifier to import from (optional).' },
      patch: { type: 'string', description: 'Use-site hunks to apply (@@ blocks).' },
      content: { type: 'string', description: 'Full replacement contents for the use site (alternative to patch).' },
      line: { type: 'number', description: '1-based line of the use site, for a language-server code action (optional).' },
      character: { type: 'number', description: '1-based column of the use site (optional).' },
    },
    required: ['path', 'symbol'],
  },
};

export const renameSymbolTool: ToolDef = {
  name: 'rename_symbol',
  description: 'Definition-and-reference rename.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path containing the symbol.' },
      line: { type: 'number', description: '1-based line of the symbol.' },
      character: { type: 'number', description: '1-based column of the symbol.' },
      newName: { type: 'string', description: 'The new symbol name.' },
    },
    required: ['path', 'line', 'character', 'newName'],
  },
};

export const updateRelatedFilesTool: ToolDef = {
  name: 'update_related_files',
  description: 'Apply one patch template across every file that references a symbol.',
  parameters: {
    type: 'object',
    properties: {
      symbol_or_pattern: {
        type: 'string',
        description: 'A symbol name (references are used) or a text pattern to search for.',
      },
      patchTemplate: {
        type: 'string',
        description: 'Hunks applied to each discovered file (@@ blocks, same semantics as apply_patch).',
      },
      confirm: {
        type: 'boolean',
        description: 'Required when more than 10 candidate files are found (optional).',
      },
    },
    required: ['symbol_or_pattern', 'patchTemplate'],
  },
};

export const refactorSymbolTool: ToolDef = {
  name: 'refactor_symbol',
  description: 'Extract or move a symbol with coordinated edits and verification.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path containing the symbol.' },
      operation: { type: 'string', enum: ['extract', 'move'] },
      name: { type: 'string', description: 'Symbol name being refactored.' },
      extractedCode: { type: 'string', description: 'Function text to insert (extract).' },
      callCode: { type: 'string', description: 'Replacement call code (extract) or header lines for the target (move).' },
      range: {
        type: 'object',
        description: '1-based range of the code being extracted or moved.',
        properties: {
          startLine: { type: 'number' },
          startChar: { type: 'number' },
          endLine: { type: 'number' },
          endChar: { type: 'number' },
        },
        required: ['startLine', 'startChar', 'endLine', 'endChar'],
      },
      targetPath: { type: 'string', description: 'Workspace-relative destination file (move).' },
      targetHeader: { type: 'string', description: 'Import/export lines to place at the top of the target (move, optional).' },
    },
    required: ['path', 'operation', 'name', 'range'],
  },
};

export const mutatingCompoundTools: ToolDef[] = [
  applyChangeSetTool,
  fixInFileTool,
  fixDiagnosticTool,
  renameSymbolTool,
  addImportAndUseTool,
  updateRelatedFilesTool,
  refactorSymbolTool,
];

export function readOnlyCompoundTools(): ToolDef[] {
  return [investigateIssueTool, verifyChangeTools().executor, inspectFileContextTool];
}
