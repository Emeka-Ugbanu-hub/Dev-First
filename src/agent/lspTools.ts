import * as vscode from 'vscode';
import { promises as fs } from 'fs';

const MAX_RESULTS = 60;

export async function documentSymbolLines(absolutePath: string, max = MAX_RESULTS): Promise<string[]> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    'vscode.executeDocumentSymbolProvider',
    vscode.Uri.file(absolutePath),
  );
  if (!symbols?.length) {
    return [];
  }
  const lines: string[] = [];
  const walk = (items: vscode.DocumentSymbol[], depth: number) => {
    for (const symbol of items) {
      if (lines.length >= max) {
        return;
      }
      lines.push(
        `${'  '.repeat(depth)}${vscode.SymbolKind[symbol.kind]} ${symbol.name} (line ${symbol.range.start.line + 1})`,
      );
      if (symbol.children?.length) {
        walk(symbol.children, depth + 1);
      }
    }
  };
  walk(symbols, 0);
  return lines;
}

export async function documentSymbols(absolutePath: string): Promise<string> {
  const lines = await documentSymbolLines(absolutePath);
  if (lines.length === 0) {
    return 'No symbols found for this file.';
  }
  return lines.join('\n');
}

export interface SymbolLocation {
  name: string;
  kind: string;
  path: string;
  absolute: string;
  line: number;
  character: number;
}

export async function workspaceSymbolLocations(query: string): Promise<SymbolLocation[]> {
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider',
    query,
  );
  if (!symbols?.length) {
    return [];
  }
  return symbols.slice(0, MAX_RESULTS).map((symbol) => ({
    name: symbol.name,
    kind: vscode.SymbolKind[symbol.kind],
    path: vscode.workspace.asRelativePath(symbol.location.uri),
    absolute: symbol.location.uri.fsPath,
    line: symbol.location.range.start.line + 1,
    character: symbol.location.range.start.character + 1,
  }));
}

export interface ReferenceLocation {
  path: string;
  absolute: string;
  line: number;
  character: number;
}

export async function referenceLocationsAt(
  absolutePath: string,
  line: unknown,
  character: unknown,
): Promise<ReferenceLocation[]> {
  const position = positionFrom(line, character);
  if (typeof position === 'string') {
    return [];
  }
  let locations: vscode.Location[] | undefined;
  try {
    locations = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      vscode.Uri.file(absolutePath),
      position,
    );
  } catch {
    return [];
  }
  if (!locations?.length) {
    return [];
  }
  return locations.slice(0, MAX_RESULTS).map((location) => ({
    path: vscode.workspace.asRelativePath(location.uri),
    absolute: location.uri.fsPath,
    line: location.range.start.line + 1,
    character: location.range.start.character + 1,
  }));
}

export async function referenceFilesAt(
  absolutePath: string,
  line: unknown,
  character: unknown,
): Promise<string[]> {
  const locations = await referenceLocationsAt(absolutePath, line, character);
  return [...new Set(locations.map((location) => location.path))];
}

export interface EditProviderResult {
  status: 'edit' | 'unavailable' | 'none';
  edit?: vscode.WorkspaceEdit;
  message?: string;
}

export async function documentRenameEdit(
  absolutePath: string,
  line: unknown,
  character: unknown,
  newName: string,
): Promise<EditProviderResult> {
  const position = positionFrom(line, character);
  if (typeof position === 'string') {
    return { status: 'unavailable', message: position };
  }
  const problem = await providerProblem('vscode.executeDocumentRenameProvider', absolutePath);
  if (problem) {
    return { status: 'unavailable', message: problem };
  }
  let edit: vscode.WorkspaceEdit | null | undefined;
  try {
    edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | null>(
      'vscode.executeDocumentRenameProvider',
      vscode.Uri.file(absolutePath),
      position,
      newName,
    );
  } catch {
    return { status: 'unavailable', message: 'The language server rename provider failed.' };
  }
  if (!edit) {
    return { status: 'none' };
  }
  return { status: 'edit', edit };
}

export async function addImportCodeActionEdit(
  absolutePath: string,
  line: unknown,
  character: unknown,
  symbol: string,
): Promise<EditProviderResult> {
  const position = positionFrom(line, character);
  if (typeof position === 'string') {
    return { status: 'unavailable', message: position };
  }
  const problem = await providerProblem('vscode.executeCodeActionProvider', absolutePath);
  if (problem) {
    return { status: 'unavailable', message: problem };
  }
  let actions: Array<vscode.CodeAction | vscode.Command> | undefined;
  try {
    actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
      'vscode.executeCodeActionProvider',
      vscode.Uri.file(absolutePath),
      new vscode.Range(position, position),
      vscode.CodeActionKind.QuickFix,
    );
  } catch {
    return { status: 'unavailable', message: 'The language server code action provider failed.' };
  }
  if (!actions?.length) {
    return { status: 'none' };
  }
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`\\b(import|${escaped})\\b`, 'i');
  for (const action of actions) {
    if (!('edit' in action) || !action.edit) {
      continue;
    }
    if (!matcher.test(action.title)) {
      continue;
    }
    return { status: 'edit', edit: action.edit };
  }
  return { status: 'none' };
}

export async function applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
  try {
    return await vscode.workspace.applyEdit(edit);
  } catch {
    return false;
  }
}

export async function workspaceSymbols(query: string): Promise<string> {
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider',
    query,
  );
  if (!symbols?.length) {
    return 'No matching symbols found.';
  }
  return symbols
    .slice(0, MAX_RESULTS)
    .map((symbol) => {
      const relative = vscode.workspace.asRelativePath(symbol.location.uri);
      const line = symbol.location.range.start.line + 1;
      const container = symbol.containerName ? ` (in ${symbol.containerName})` : '';
      return `${relative}:${line} — ${vscode.SymbolKind[symbol.kind]} ${symbol.name}${container}`;
    })
    .join('\n');
}

export async function findReferences(absolutePath: string, symbol: string): Promise<string> {
  const position = await findSymbolPosition(absolutePath, symbol);
  if (!position) {
    return `Error: symbol "${symbol}" was not found in the file.`;
  }
  const locations = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeReferenceProvider',
    vscode.Uri.file(absolutePath),
    position,
  );
  if (!locations?.length) {
    return `No references found for "${symbol}".`;
  }
  return locations
    .slice(0, MAX_RESULTS)
    .map((location) => {
      const relative = vscode.workspace.asRelativePath(location.uri);
      return `${relative}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
    })
    .join('\n');
}

export async function goToDefinition(absolutePath: string, symbol: string): Promise<string> {
  const position = await findSymbolPosition(absolutePath, symbol);
  if (!position) {
    return `Error: symbol "${symbol}" was not found in the file.`;
  }
  const locations = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    vscode.Uri.file(absolutePath),
    position,
  );
  if (!locations?.length) {
    return `No definition found for "${symbol}".`;
  }
  return locations
    .slice(0, 10)
    .map((location) => {
      const relative = vscode.workspace.asRelativePath(location.uri);
      return `${relative}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
    })
    .join('\n');
}

export function toZeroBased(line: unknown, character: unknown): { line: number; character: number } | undefined {
  const lineNumber = typeof line === 'number' ? line : typeof line === 'string' ? Number(line) : NaN;
  const characterNumber = typeof character === 'number' ? character : typeof character === 'string' ? Number(character) : NaN;
  if (!Number.isFinite(lineNumber) || !Number.isFinite(characterNumber)) {
    return undefined;
  }
  return { line: Math.max(0, Math.floor(lineNumber) - 1), character: Math.max(0, Math.floor(characterNumber) - 1) };
}

async function providerProblem(command: string, absolutePath: string): Promise<string | undefined> {
  const commands = vscode.commands as { getCommands?: (filterInternal?: boolean) => Thenable<string[]> };
  if (typeof commands.getCommands !== 'function') {
    return undefined;
  }
  let available: string[];
  try {
    available = await commands.getCommands(true);
  } catch {
    return undefined;
  }
  if (available.includes(command)) {
    return undefined;
  }
  return `Error: no language server is available for ${vscode.workspace.asRelativePath(vscode.Uri.file(absolutePath))} (missing ${command}). Open the file with its language extension installed.`;
}

function positionFrom(line: unknown, character: unknown): vscode.Position | string {
  const zeroBased = toZeroBased(line, character);
  if (!zeroBased) {
    return 'Error: line and character are required (1-based numbers).';
  }
  return new vscode.Position(zeroBased.line, zeroBased.character);
}

function hoverText(contents: vscode.Hover['contents']): string {
  const entries = Array.isArray(contents) ? contents : [contents];
  const parts: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      parts.push(entry);
    } else if (entry && typeof entry === 'object' && 'value' in entry) {
      parts.push(String((entry as { value: unknown }).value));
    }
  }
  return parts.join('\n').trim();
}

function formatLocations(
  locations: Array<vscode.Location | vscode.LocationLink> | undefined,
  empty: string,
): string {
  if (!locations?.length) {
    return empty;
  }
  return locations
    .slice(0, MAX_RESULTS)
    .map((location) => {
      const uri = 'targetUri' in location ? location.targetUri : location.uri;
      const range = 'targetRange' in location ? location.targetRange : location.range;
      const relative = vscode.workspace.asRelativePath(uri);
      return `${relative}:${range.start.line + 1}:${range.start.character + 1}`;
    })
    .join('\n');
}

export async function hoverAt(absolutePath: string, line: unknown, character: unknown): Promise<string> {
  const position = positionFrom(line, character);
  if (typeof position === 'string') {
    return position;
  }
  const problem = await providerProblem('vscode.executeHoverProvider', absolutePath);
  if (problem) {
    return problem;
  }
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    vscode.Uri.file(absolutePath),
    position,
  );
  if (!hovers?.length) {
    return 'No hover information at this position.';
  }
  const body = hovers.map((hover) => hoverText(hover.contents)).filter(Boolean).join('\n\n');
  return body || 'No hover information at this position.';
}

export async function goToImplementation(absolutePath: string, line: unknown, character: unknown): Promise<string> {
  const position = positionFrom(line, character);
  if (typeof position === 'string') {
    return position;
  }
  const problem = await providerProblem('vscode.executeImplementationProvider', absolutePath);
  if (problem) {
    return problem;
  }
  const locations = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
    'vscode.executeImplementationProvider',
    vscode.Uri.file(absolutePath),
    position,
  );
  return formatLocations(locations, 'No implementations found at this position.');
}

async function callHierarchyRoot(
  absolutePath: string,
  line: unknown,
  character: unknown,
): Promise<vscode.CallHierarchyItem[] | string> {
  const position = positionFrom(line, character);
  if (typeof position === 'string') {
    return position;
  }
  const problem = await providerProblem('vscode.prepareCallHierarchy', absolutePath);
  if (problem) {
    return problem;
  }
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    'vscode.prepareCallHierarchy',
    vscode.Uri.file(absolutePath),
    position,
  );
  if (!items?.length) {
    return 'No call hierarchy entry found at this position.';
  }
  return items;
}

export async function incomingCalls(absolutePath: string, line: unknown, character: unknown): Promise<string> {
  const items = await callHierarchyRoot(absolutePath, line, character);
  if (typeof items === 'string') {
    return items;
  }
  const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
    'vscode.provideIncomingCalls',
    items[0],
  );
  if (!calls?.length) {
    return `No incoming calls for "${items[0].name}".`;
  }
  return calls
    .slice(0, MAX_RESULTS)
    .map((call) => {
      const relative = vscode.workspace.asRelativePath(call.from.uri);
      return `${relative}:${call.from.range.start.line + 1}:${call.from.range.start.character + 1} — ${call.from.name}`;
    })
    .join('\n');
}

export async function outgoingCalls(absolutePath: string, line: unknown, character: unknown): Promise<string> {
  const items = await callHierarchyRoot(absolutePath, line, character);
  if (typeof items === 'string') {
    return items;
  }
  const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
    'vscode.provideOutgoingCalls',
    items[0],
  );
  if (!calls?.length) {
    return `No outgoing calls for "${items[0].name}".`;
  }
  return calls
    .slice(0, MAX_RESULTS)
    .map((call) => {
      const relative = vscode.workspace.asRelativePath(call.to.uri);
      return `${relative}:${call.to.range.start.line + 1}:${call.to.range.start.character + 1} — ${call.to.name}`;
    })
    .join('\n');
}

async function findSymbolPosition(absolutePath: string, symbol: string): Promise<vscode.Position | undefined> {
  let content: string;
  try {
    content = await fs.readFile(absolutePath, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`);
  for (let index = 0; index < lines.length; index++) {
    const match = regex.exec(lines[index]);
    if (match) {
      return new vscode.Position(index, match.index);
    }
  }
  return undefined;
}
