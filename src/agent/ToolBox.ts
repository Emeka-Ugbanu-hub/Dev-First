import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath, pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { DiffManager } from '../diff/DiffManager';
import { errorMessage } from '../util/errors';
import { toolCallArgs } from './tools';
import {
  ToolDef,
} from '../llm/types';
import {
  applyPatchTool,
  askUserTool,
  backgroundProcessTool,
  browserEvaluateTool,
  browserNavigateTool,
  browserScreenshotTool,
  documentSymbolsTool,
  editFileTool,
  findReferencesTool,
  findSymbolTool,
  goToDefinitionTool,
  goToImplementationTool,
  hoverTool,
  incomingCallsTool,
  listFilesTool,
  listProcessesTool,
  memoryRecallTool,
  memorySaveTool,
  outgoingCallsTool,
  readFileTool,
  runTerminalTool,
  searchTextTool,
  semanticSearchTool,
  taskTool,
  todoWriteTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
} from './tools';
import { applyHunks, fuzzyReplaceInContent, parsePatch, withFileLock, withFileLocks } from './patch';
import { parseToolArguments } from './jsonRepair';
import {
  MAX_READ_BYTES,
  budgetEndLine,
  findAgentsMd,
  formatBytes,
  formatNumberedLines,
  sniffFileKind,
  suggestSimilar,
  truncateLine,
} from './fileRead';
import { initOutputStore, spillOutput } from './outputStore';
import { runTerminalCommand } from './terminal';
import { collectFileDiagnostics, diagnosticLines, diagnosticsSection, formatDiagnostics } from './diagnostics';
import type { FileDiagnostic } from './diagnostics';
import {
  addImportCodeActionEdit,
  applyWorkspaceEdit,
  documentRenameEdit,
  documentSymbolLines,
  documentSymbols,
  findReferences,
  goToDefinition,
  goToImplementation,
  hoverAt,
  incomingCalls,
  outgoingCalls,
  referenceFilesAt,
  referenceLocationsAt,
  toZeroBased,
  workspaceSymbols,
} from './lspTools';
import {
  ChangeSetAction,
  ChangeSetEntry,
  UPDATE_CONFIRM_THRESHOLD,
  UPDATE_MAX_FILES,
  appendSnippet,
  boundedInvestigationTool,
  buildImportStatement,
  declarationCandidateCount,
  insertImport,
  isWorkspaceIdentifier,
  mutatingCompoundTools,
  parseRefactorRange,
  patchHunksFor,
  rangeText,
  readOnlyCompoundTools,
  removeRange,
  renameInContent,
  replaceRange,
  symbolAtLine,
  symbolNameFromEntry,
  textualRenameHazards,
  validateChangeSet,
  wordAtPosition,
} from './compoundTools';
import {
  FileReadCache,
  FileReadResult,
  StaleContentError,
  assertFresh,
  changeDiff,
  fileCacheKey,
  generatedBlockedMessage,
  isGeneratedPath,
  makeReadCache,
  occurrenceLines,
  readFileWithHash,
  replaceExactAll,
  replaceExactAt,
  validateWorkspacePath,
} from './compoundPrimitives';
import {
  INSTRUCTION_ASK,
  ParsedInstruction,
  parseInstruction,
  setQuotedString,
} from './instructionParser';
import {
  CompoundDiagnostic,
  CompoundEvidence,
  CompoundResult,
  CompoundResultPartial,
  ProposedChangeValidation,
  buildCompoundResult,
  compoundDiagnostics,
  compoundResult,
  parseCompoundResult,
} from './compoundResult';
import { discoverRelatedTargets, searchTargets } from './compoundPreflight';
import {
  IGNORED_DIRS,
  TEXT_EXTENSIONS,
  expandBraces,
  listWorkspaceFiles,
  rgListFiles,
  rgSearch,
} from '../util/fsWalk';
import type { RipgrepMatch } from '../util/fsWalk';
import { fetchUrl, webSearch } from './web';
import { loadSkill } from '../skills/SkillManager';
import { SemanticIndex } from '../indexing/SemanticIndex';
import { McpManager } from '../mcp/McpManager';
import { BrowserSession } from '../browser/BrowserSession';
import { SandboxMode } from './sandbox';
import { describeCandidate, resolveProjectCommands } from './projectCommands';
import type { ProjectCommandCandidate, ProjectCommandKind } from './projectCommands';
import { adjacentTests, isTestFile, testTargets } from '../scan/crossFile';
import {
  DiagnosticsCache,
  VerificationPolicyInput,
  VerifyChangeInfo,
  VerifyCheckKind,
  planCheckRequirementFromSteps,
  planVerification,
} from './verificationPolicy';
import { getConfig } from '../config';
import { QuestionItem, QuestionRequest, TerminalApprovalDecision, TodoItem } from '../shared/protocol';
import { randomId } from '../util/id';
import { sha1Of } from '../util/atomicWrite';
import { MemoryStore } from '../memory/MemoryStore';
import { BackgroundProcesses } from './BackgroundProcesses';
import { ApprovalMemory, ExternalDirectoryConsent } from './approvals';
import type { SubagentRequest } from './subagent';

const MAX_STREAM_BYTES = 50 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;
const SKIP_SPILL = new Set(['todo_write']);
const BOUNDED_DEFAULT_OPERATIONS = 6;
const BOUNDED_HARD_CAP = 8;
const BOUNDED_OP_BYTES = 8 * 1024;
const BOUNDED_TOTAL_BYTES = 24 * 1024;
const BOUNDED_ALLOWED_TOOLS = new Set([
  'read_file',
  'list_files',
  'search_text',
  'semantic_search',
  'find_references',
  'go_to_definition',
  'document_symbols',
  'find_symbol',
  'hover',
  'incoming_calls',
  'outgoing_calls',
  'inspect_file_context',
  'investigate_issue',
]);

const ADAPTIVE_COMPOUND_TOOLS = new Set([
  'apply_change_set',
  'fix_in_file',
  'fix_diagnostic',
  'add_import_and_use',
  'rename_symbol',
  'refactor_symbol',
  'update_related_files',
]);

const ADAPTIVE_SYMBOL_TOOLS = new Set([
  'rename_symbol',
  'add_import_and_use',
  'refactor_symbol',
  'update_related_files',
]);

const MAX_RELATED_DIAGNOSTIC_FILES = 10;
const MAX_CLOSEST_TESTS = 2;
const ADAPTIVE_PACKAGE_WALK_LIMIT = 300;
const ADAPTIVE_PACKAGE_ROOT_CAP = 50;
const PACKAGE_MANIFEST_FILES = new Set([
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pnpm-workspace.yaml',
]);

const useSkillSchema: ToolDef = {
  name: 'use_skill',
  description: 'Load a project skill by name.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
};

const TOOL_SCHEMAS = new Map<string, ToolDef>();
for (const definition of [
  readFileTool,
  listFilesTool,
  searchTextTool,
  semanticSearchTool,
  findSymbolTool,
  documentSymbolsTool,
  findReferencesTool,
  goToDefinitionTool,
  hoverTool,
  goToImplementationTool,
  incomingCallsTool,
  outgoingCallsTool,
  webFetchTool,
  webSearchTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  runTerminalTool,
  todoWriteTool,
  memoryRecallTool,
  memorySaveTool,
  backgroundProcessTool,
  listProcessesTool,
  askUserTool,
  browserNavigateTool,
  browserEvaluateTool,
  browserScreenshotTool,
  useSkillSchema,
  taskTool,
  ...mutatingCompoundTools,
  ...readOnlyCompoundTools(),
]) {
  TOOL_SCHEMAS.set(definition.name, definition);
}

export interface ToolExecutionContext {
  requestTerminalApproval(command: string, cwd: string): Promise<TerminalApprovalDecision>;
  requestExternalDirectoryApproval?(directory: string): Promise<boolean>;
  askUser?(request: QuestionRequest): Promise<string>;
  signal?: AbortSignal;
  planning?: boolean;
  planCheckRequirement?: VerifyCheckKind;
}

export interface ToolBoxOptions {
  root: string;
  diffManager: DiffManager;
  terminalTimeoutSeconds: number;
  autoApproveTerminal: boolean;
  autoApproveEdits: boolean;
  safeCommandsOnly: boolean;
  yolo: boolean;
  autoApproveMcp: boolean;
  checkDiagnostics: boolean;
  sandbox: SandboxMode;
  onTodos?: (todos: TodoItem[]) => void;
  semanticIndex?: SemanticIndex;
  mcp?: McpManager;
  browser?: BrowserSession;
  memory?: MemoryStore;
  backgroundProcesses?: BackgroundProcesses;
  runTask?: (request: SubagentRequest, signal?: AbortSignal) => Promise<string>;
  approvalMemory?: ApprovalMemory;
  externalDirectories?: ExternalDirectoryConsent;
  recentRunOperations?: (filePath: string) => string[];
  readCache?: FileReadCache;
  planCheckRequirement?: VerifyCheckKind;
}

export interface AdaptiveVerificationSnapshot {
  diagnosticsAvailable: boolean;
  newDiagnosticErrors: number;
  verificationRan: string[];
}

export class ToolBox {
  private readonly externalDirectories: ExternalDirectoryConsent;
  private readonly readCache: FileReadCache;
  private readonly adaptiveDiagnostics = new DiagnosticsCache();
  private readonly repairStates = new Map<string, { attempts: number; hash: string; checkId: string }>();
  private readonly verificationRan: string[] = [];
  private readonly diagnosticStats = new Map<string, { baseline: number; latest: number }>();
  private diagnosticsObserved = false;
  private packageRootsCache?: number;

  constructor(private readonly options: ToolBoxOptions) {
    this.externalDirectories = options.externalDirectories ?? new ExternalDirectoryConsent();
    this.readCache = options.readCache ?? makeReadCache();
    initOutputStore(options.root);
  }

  resetReadCache(): void {
    this.readCache.clear();
  }

  adaptiveVerificationSnapshot(): AdaptiveVerificationSnapshot {
    let newDiagnosticErrors = 0;
    for (const stat of this.diagnosticStats.values()) {
      newDiagnosticErrors += Math.max(0, stat.latest - stat.baseline);
    }
    return {
      diagnosticsAvailable: this.options.checkDiagnostics && this.diagnosticsObserved,
      newDiagnosticErrors,
      verificationRan: [...this.verificationRan],
    };
  }

  private recordVerification(check: string): void {
    if (!check || this.verificationRan.includes(check)) {
      return;
    }
    this.verificationRan.push(check);
  }

  private recordDiagnostics(paths: string[], items: FileDiagnostic[]): void {
    for (const absolute of new Set(paths)) {
      const errors = items.filter(
        (item) => item.absolute === absolute && item.severity === 'error',
      ).length;
      const stat = this.diagnosticStats.get(absolute);
      if (stat) {
        stat.latest = errors;
      } else {
        this.diagnosticStats.set(absolute, { baseline: errors, latest: errors });
      }
      if (items.some((item) => item.absolute === absolute)) {
        this.diagnosticsObserved = true;
      }
    }
  }

  private captureDiagnosticBaseline(absolute: string): void {
    if (this.diagnosticStats.has(absolute)) {
      return;
    }
    try {
      const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(absolute));
      const errors = diagnostics.filter((item) => item.severity === vscode.DiagnosticSeverity.Error).length;
      this.diagnosticStats.set(absolute, { baseline: errors, latest: errors });
      if (diagnostics.length > 0) {
        this.diagnosticsObserved = true;
      }
    } catch {
      return;
    }
  }

  async execute(name: string, argsJson: string, context: ToolExecutionContext): Promise<string> {
    try {
      const args = safeParse(argsJson);
      const problem = validateToolArguments(name, args);
      if (problem) {
        return `Error: invalid arguments for ${name} — ${problem}. Re-emit the call with valid JSON matching the schema.`;
      }
      const outcome = await this.dispatch(name, args, context);
      const text = await this.adaptiveVerification(name, args, context, outcome.text);
      if (outcome.spilled || SKIP_SPILL.has(name)) {
        return text;
      }
      return await spillOutput(text, name);
    } catch (error) {
      return `Error: ${errorMessage(error)}`;
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, any>,
    context: ToolExecutionContext,
  ): Promise<{ text: string; spilled?: boolean }> {
    switch (name) {
      case 'read_file':
        return { text: await this.readFile(args, context) };
      case 'list_files':
        return { text: await this.listFiles(args, context) };
      case 'search_text':
        return { text: await this.searchText(args, context) };
      case 'find_symbol':
        return { text: await workspaceSymbols(String(args.query ?? '')) };
      case 'document_symbols':
        return { text: await documentSymbols(await this.resolvePath(args.path, context)) };
      case 'find_references':
        return { text: await findReferences(await this.resolvePath(args.path, context), String(args.symbol ?? '')) };
      case 'go_to_definition':
        return { text: await goToDefinition(await this.resolvePath(args.path, context), String(args.symbol ?? '')) };
      case 'hover':
        return { text: await hoverAt(await this.resolvePath(args.path, context), args.line, args.character) };
      case 'go_to_implementation':
        return {
          text: await goToImplementation(await this.resolvePath(args.path, context), args.line, args.character),
        };
      case 'incoming_calls':
        return { text: await incomingCalls(await this.resolvePath(args.path, context), args.line, args.character) };
      case 'outgoing_calls':
        return { text: await outgoingCalls(await this.resolvePath(args.path, context), args.line, args.character) };
      case 'inspect_file_context':
        return { text: await this.inspectFileContext(args, context) };
      case 'investigate_issue':
        return { text: await this.investigateIssue(args, context) };
      case 'bounded_investigation':
        return { text: await this.boundedInvestigation(args, context) };
      case 'verify_change':
        return { text: await this.verifyChange(args, context) };
      case 'apply_change_set':
        return { text: await this.applyChangeSet(args, context) };
      case 'fix_in_file':
        return { text: await this.fixInFile(args, context) };
      case 'fix_diagnostic':
        return { text: await this.fixDiagnostic(args, context) };
      case 'add_import_and_use':
        return { text: await this.addImportAndUse(args, context) };
      case 'rename_symbol':
        return { text: await this.renameSymbol(args, context) };
      case 'update_related_files':
        return { text: await this.updateRelatedFiles(args, context) };
      case 'refactor_symbol':
        return { text: await this.refactorSymbol(args, context) };
      case 'task':
        return { text: await this.runTask(args, context) };
      case 'write_file':
        return { text: await this.writeFile(args, context) };
      case 'edit_file':
        return { text: await this.editFile(args, context) };
      case 'apply_patch':
        return { text: await this.applyPatch(args, context) };
      case 'run_terminal_command':
        return await this.runCommand(args, context);
      case 'todo_write':
        return { text: this.todoWrite(args) };
      case 'ask_user':
        return { text: await this.askUser(args, context) };
      case 'memory_recall':
        return {
          text: this.options.memory
            ? await this.options.memory.recall(typeof args.query === 'string' ? args.query : undefined)
            : 'Error: project memory is disabled.',
        };
      case 'memory_save':
        return {
          text: this.options.memory
            ? await this.options.memory.save(
                String(args.content ?? ''),
                typeof args.section === 'string' ? args.section : undefined,
              )
            : 'Error: project memory is disabled.',
        };
      case 'background_process':
        return { text: await this.backgroundProcess(args, context) };
      case 'list_processes':
        return { text: this.listProcesses() };
      case 'web_fetch':
        return {
          text: await fetchUrl(
            String(args.url ?? ''),
            Number(args.max_chars) || 30_000,
            context.signal,
            Number(args.timeout_seconds),
          ),
        };
      case 'web_search':
        return { text: await webSearch(String(args.query ?? ''), Number(args.max_results) || 5, context.signal) };
      case 'use_skill':
        return { text: await this.useSkill(args) };
      case 'semantic_search':
        return { text: await this.semanticSearch(args, context) };
      case 'browser_navigate':
        return { text: await this.browserNavigate(args) };
      case 'browser_evaluate':
        return { text: await this.browserEvaluate(args) };
      case 'browser_screenshot':
        return { text: await this.browserScreenshot() };
      default:
        if (this.options.mcp?.hasTool(name)) {
          if (!this.options.yolo && !this.options.autoApproveMcp) {
            const decision = await context.requestTerminalApproval(
              `MCP tool: ${name} ${JSON.stringify(args).slice(0, 200)}`,
              this.options.root,
            );
            if (decision === 'deny') {
              return { text: 'The developer denied this MCP tool call.' };
            }
          }
          return { text: await this.options.mcp.call(name, args) };
        }
        return { text: `Error: unknown tool "${name}".` };
    }
  }

  private async resolvePath(input: unknown, context?: ToolExecutionContext): Promise<string> {
    if (typeof input !== 'string' || !input.trim()) {
      throw new Error('A file path is required.');
    }
    const cleaned = input.trim().replace(/^[/\\]+/, '');
    const absolute = path.resolve(this.options.root, cleaned);
    const relative = path.relative(this.options.root, absolute);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return absolute;
    }
    const directory = path.dirname(absolute);
    if (this.externalDirectories.allows(directory)) {
      return absolute;
    }
    const allowed = context?.requestExternalDirectoryApproval
      ? await context.requestExternalDirectoryApproval(directory)
      : false;
    if (!allowed) {
      throw new Error(`Path "${input}" is outside the workspace.`);
    }
    this.externalDirectories.grant(directory);
    return absolute;
  }

  private async readFile(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const display = String(args.path);
    const absolute = await this.resolvePath(args.path, context);
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return await this.notFoundMessage(display, absolute);
      }
      throw error;
    }
    if (!stat.isFile()) {
      return `Error: ${display} is not a file.`;
    }
    this.captureDiagnosticBaseline(absolute);
    const kind = await sniffFileKind(absolute, stat.size);
    if (kind) {
      return `${display} ${kind} (${formatBytes(stat.size)}) and cannot be read as text.`;
    }
    if (stat.size > MAX_STREAM_BYTES) {
      return `Error: ${display} is larger than 50 MB. Use search_text or read a smaller file.`;
    }
    const text =
      stat.size > MAX_READ_BYTES
        ? await this.readFileStreaming(absolute, args)
        : await this.readFileWhole(absolute, display, args);
    const reminder = await this.agentsMdReminder(absolute);
    return reminder ? `${text}\n\n${reminder}` : text;
  }

  private async readFileWhole(absolute: string, display: string, args: Record<string, any>): Promise<string> {
    const content = await fs.readFile(absolute, 'utf-8');
    if (content.includes('\u0000')) {
      return `Error: ${display} appears to be a binary file.`;
    }
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const start = clampInt(args.start_line, 1, lines.length) ?? 1;
    const requestedEnd = clampInt(args.end_line, start, lines.length) ?? Math.min(lines.length, start + 1999);
    const end = budgetEndLine(lines, start, requestedEnd, MAX_READ_BYTES);
    const hasMore = end < lines.length;
    return formatNumberedLines(lines.slice(start - 1, end), start, hasMore);
  }

  private async readFileStreaming(absolute: string, args: Record<string, any>): Promise<string> {
    const start = clampInt(args.start_line, 1, Number.MAX_SAFE_INTEGER) ?? 1;
    const requestedEnd = clampInt(args.end_line, start, Number.MAX_SAFE_INTEGER) ?? start + 1999;
    const lines: string[] = [];
    let bytes = 0;
    let stopped = false;
    const stream = createReadStream(absolute, { encoding: 'utf-8' });
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of reader) {
        lineNumber++;
        if (lineNumber < start) {
          continue;
        }
        if (lineNumber > requestedEnd) {
          stopped = true;
          break;
        }
        const size = Buffer.byteLength(line, 'utf-8') + 1;
        if (lines.length > 0 && bytes + size > MAX_READ_BYTES) {
          stopped = true;
          break;
        }
        bytes += size;
        lines.push(line);
      }
    } finally {
      reader.close();
      stream.destroy();
    }
    return formatNumberedLines(lines, start, stopped);
  }

  private async notFoundMessage(display: string, absolute: string): Promise<string> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(path.dirname(absolute));
    } catch {}
    const candidates = suggestSimilar(entries, path.basename(absolute));
    if (candidates.length === 0) {
      return `Error: ${display} does not exist.`;
    }
    return `Error: ${display} does not exist. Did you mean: ${candidates.join(', ')}?`;
  }

  private async agentsMdReminder(absolute: string): Promise<string> {
    const content = await findAgentsMd(path.dirname(absolute), this.options.root);
    if (!content) {
      return '';
    }
    return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
  }

  private async listFiles(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const base = args.path ? await this.resolvePath(args.path, context) : this.options.root;
    const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : undefined;
    const matchers = glob ? expandBraces(glob).map(globToRegExp) : undefined;
    const matches = (relative: string) => !matchers || matchers.some((matcher) => matcher.test(relative));
    let files: string[];
    let truncated = false;
    const ripgrep = await rgListFiles(base, MAX_LIST_ENTRIES * 4);
    if (ripgrep) {
      const filtered = ripgrep.files.map((file) => file.split(path.sep).join('/')).filter(matches);
      truncated = ripgrep.truncated || filtered.length > MAX_LIST_ENTRIES;
      files = filtered.slice(0, MAX_LIST_ENTRIES);
    } else {
      files = await listWorkspaceFiles(base, { matcher: matches, maxEntries: MAX_LIST_ENTRIES, maxDepth: 8 });
      truncated = files.length >= MAX_LIST_ENTRIES;
    }
    if (files.length === 0) {
      return 'No matching files found.';
    }
    const relativeFiles = files.map((file) =>
      path.relative(this.options.root, path.join(base, file)).split(path.sep).join('/'),
    );
    const body = relativeFiles.join('\n');
    return truncated ? `${body}\n\n... [showing first ${MAX_LIST_ENTRIES} files; narrow with a path or glob]` : body;
  }

  private async searchText(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query) {
      return 'Error: query is required.';
    }
    const base = args.path ? await this.resolvePath(args.path, context) : this.options.root;
    const isRegex = Boolean(args.is_regex);
    const caseSensitive = Boolean(args.case_sensitive);
    const maxResults = clampInt(args.max_results, 1, MAX_SEARCH_RESULTS) ?? 50;
    if (isRegex) {
      try {
        new RegExp(query);
      } catch (error) {
        return `Error: invalid regular expression: ${errorMessage(error)}`;
      }
    }

    const ripgrep = await rgSearch({
      root: this.options.root,
      base,
      query,
      isRegex,
      caseSensitive,
      maxResults,
    });
    if (ripgrep !== undefined) {
      if (ripgrep.matches.length === 0) {
        return 'No matches found.';
      }
      const body = groupRipgrepMatches(ripgrep.matches, this.options.root);
      return ripgrep.truncated
        ? `${body}\n\n... [showing first ${ripgrep.matches.length} matches; narrow the query or path]`
        : body;
    }

    let pattern: RegExp;
    try {
      pattern = isRegex
        ? new RegExp(query, caseSensitive ? 'g' : 'gi')
        : new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
    } catch (error) {
      return `Error: invalid regular expression: ${errorMessage(error)}`;
    }

    const files = await listWorkspaceFiles(base, { maxEntries: 3000 });
    const matches: string[] = [];

    for (const relative of files) {
      if (matches.length >= maxResults) {
        break;
      }
      const absolute = path.join(base, relative);
      const ext = path.extname(relative).toLowerCase();
      if (ext && !TEXT_EXTENSIONS.has(ext)) {
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      if (stat.size > 1024 * 1024) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(absolute, 'utf-8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) {
        continue;
      }
      const displayPath = path.relative(this.options.root, absolute).split(path.sep).join('/');
      const lines = content.replace(/\r\n/g, '\n').split('\n');
      for (let index = 0; index < lines.length; index++) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[index])) {
          matches.push(`${displayPath}:${index + 1}: ${lines[index].trim().slice(0, 200)}`);
          if (matches.length >= maxResults) {
            break;
          }
        }
      }
    }

    if (matches.length === 0) {
      return 'No matches found.';
    }
    const fallbackBody = matches.join('\n');
    return matches.length >= maxResults
      ? `${fallbackBody}\n\n... [showing first ${matches.length} matches; narrow the query or path]`
      : fallbackBody;
  }

  private async writeFile(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const absolute = await this.resolvePath(args.path, context);
    if (!(await this.editApproved('write_file', String(args.path), context))) {
      return 'The developer denied this edit. Do not retry it unless asked.';
    }
    const content = typeof args.content === 'string' ? args.content : '';
    const result = await withFileLock(absolute, () => this.options.diffManager.applyChange(absolute, content));
    return result + (await this.diagnosticsFor([absolute]));
  }

  private async editFile(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const absolute = await this.resolvePath(args.path, context);
    if (!(await this.editApproved('edit_file', String(args.path), context))) {
      return 'The developer denied this edit. Do not retry it unless asked.';
    }
    const oldText = typeof args.old_text === 'string' ? args.old_text : '';
    const newText = typeof args.new_text === 'string' ? args.new_text : '';
    const replaceAll = Boolean(args.replace_all);
    const outcome = await withFileLock<{ error: string } | { applied: string; count: number }>(
      absolute,
      async () => {
        let content: string;
        try {
          content = await fs.readFile(absolute, 'utf-8');
        } catch {
          return { error: `Error: ${args.path} does not exist. Use write_file to create it.` };
        }
        const result = fuzzyReplaceInContent(content, oldText, newText, replaceAll);
        if (!result.ok) {
          return { error: `Error: ${result.error}` };
        }
        const applied = await this.options.diffManager.applyChange(absolute, result.content);
        return { applied, count: result.count ?? 0 };
      },
    );
    if ('error' in outcome) {
      return outcome.error;
    }
    return `${outcome.applied} (${outcome.count} replacement${outcome.count === 1 ? '' : 's'})${await this.diagnosticsFor([absolute])}`;
  }

  private async applyPatch(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const patchText = typeof args.patch === 'string' ? args.patch : '';
    if (!patchText.trim()) {
      return 'Error: patch is empty.';
    }
    const operations = parsePatch(patchText);
    if (operations.length === 0) {
      return 'Error: no operations found. Use *** Begin Patch / *** Add File / *** Update File / *** Delete File / *** End Patch.';
    }
    const resolved = await Promise.all(
      operations.map(async (operation) => ({
        operation,
        absolute: await this.resolvePath(operation.path, context),
      })),
    );
    const paths = operations.map((operation) => operation.path).join(', ');
    return withFileLocks(
      resolved.map((entry) => entry.absolute),
      async () => {
        const planned: Array<{ type: 'add' | 'update' | 'delete'; absolute: string; content: string }> = [];
        const virtual = new Map<string, string>();
        const touched: string[] = [];
        for (const { operation, absolute } of resolved) {
          if (operation.type === 'add') {
            const content = operation.content ?? '';
            virtual.set(absolute, content);
            planned.push({ type: 'add', absolute, content });
            touched.push(absolute);
            continue;
          }
          if (operation.type === 'delete') {
            const current = virtual.has(absolute) ? virtual.get(absolute) : await this.readTextIfExists(absolute);
            if (current === undefined) {
              return `Error: ${operation.path} does not exist (in a Delete section).`;
            }
            virtual.delete(absolute);
            planned.push({ type: 'delete', absolute, content: '' });
            continue;
          }
          const base = virtual.has(absolute) ? virtual.get(absolute)! : await this.readTextIfExists(absolute);
          if (base === undefined) {
            return `Error: ${operation.path} does not exist (in an Update section).`;
          }
          const applied = applyHunks(base, operation.hunks ?? []);
          if (!applied.ok) {
            return `Error in ${operation.path}: ${applied.error}`;
          }
          virtual.set(absolute, applied.content);
          planned.push({ type: 'update', absolute, content: applied.content });
          touched.push(absolute);
        }
        if (!(await this.editApproved('apply_patch', paths, context))) {
          return 'The developer denied this edit. Do not retry it unless asked.';
        }
        const results: string[] = [];
        for (const entry of planned) {
          if (entry.type === 'delete') {
            results.push(await this.options.diffManager.applyDeletion(entry.absolute));
          } else {
            results.push(await this.options.diffManager.applyChange(entry.absolute, entry.content));
          }
        }
        return results.join('\n') + (await this.diagnosticsFor(touched));
      },
    );
  }

  private async readTextIfExists(absolute: string): Promise<string | undefined> {
    try {
      return await fs.readFile(absolute, 'utf-8');
    } catch {
      return undefined;
    }
  }

  private async runCommand(
    args: Record<string, any>,
    context: ToolExecutionContext,
  ): Promise<{ text: string; spilled: boolean }> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) {
      return { text: 'Error: command is required.', spilled: false };
    }
    const planning = Boolean(context.planning);
    if (planning && !isSafeCommand(command)) {
      return {
        text: "Not allowed during planning. Approve the plan and I'll run this during execution (with command approval).",
        spilled: false,
      };
    }
    let sandbox: SandboxMode = this.options.sandbox;
    if (!planning && this.commandNeedsApproval(command)) {
      if (this.options.approvalMemory?.allows(command)) {
        sandbox = this.options.sandbox;
      } else {
        const decision = await context.requestTerminalApproval(command, this.options.root);
        if (decision === 'deny') {
          return { text: 'The developer denied this command. Do not retry it unless asked.', spilled: false };
        }
        this.options.approvalMemory?.remember(command);
        if (decision === 'allow-unsandboxed') {
          sandbox = 'off';
        }
      }
    }
    const timeout = clampInt(args.timeout_seconds, 1, 3600) ?? this.options.terminalTimeoutSeconds;
    const result = await runTerminalCommand(command, this.options.root, timeout, context.signal, sandbox, {
      background: this.options.backgroundProcesses,
    });
    if (!planning) {
      const kind = planCheckRequirementFromSteps([command]);
      if (kind) {
        this.recordVerification(`${kind}:${command}`);
      }
    }
    const parts: string[] = [];
    if (sandbox === 'off' && this.options.sandbox !== 'off') {
      parts.push('Note: the developer approved running this command without the sandbox.');
    }
    if (result.note) {
      parts.push(`Note: ${result.note}`);
    }
    if (result.timedOut) {
      parts.push(`Command timed out after ${timeout}s.`);
    }
    parts.push(`Exit code: ${result.exitCode ?? 'unknown'}`);
    if (result.spillPath) {
      parts.push(`Full output: ${result.spillPath}`);
    }
    parts.push(result.output.trim() || '(no output)');
    return { text: parts.join('\n'), spilled: Boolean(result.spillPath) };
  }

  private async editApproved(tool: string, path: string, context: ToolExecutionContext): Promise<boolean> {
    if (this.options.yolo || this.options.autoApproveEdits) {
      return true;
    }
    const decision = await context.requestTerminalApproval(`${tool}: ${path}`, this.options.root);
    return decision !== 'deny';
  }

  private commandNeedsApproval(command: string): boolean {
    if (this.options.yolo) {
      return false;
    }
    if (!this.options.autoApproveTerminal) {
      return true;
    }
    return this.options.safeCommandsOnly && !isSafeCommand(command);
  }

  private todoWrite(args: Record<string, any>): string {
    const raw = Array.isArray(args.todos) ? args.todos : [];
    const todos: TodoItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      const status =
        item.status === 'in_progress' || item.status === 'done' || item.status === 'cancelled'
          ? item.status
          : 'pending';
      if (text) {
        todos.push({ text, status });
      }
    }
    if (todos.length === 0) {
      return 'Error: provide at least one todo with a text and status.';
    }
    this.options.onTodos?.(todos);
    const done = todos.filter((todo) => todo.status === 'done').length;
    const cancelled = todos.filter((todo) => todo.status === 'cancelled').length;
    if (cancelled > 0) {
      return `Task list updated: ${done}/${todos.length} done, ${cancelled} cancelled.`;
    }
    return `Task list updated: ${done}/${todos.length} done.`;
  }

  private async askUser(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    if (!context.askUser) {
      return 'Error: asking the developer is not available in this context.';
    }
    const batch = this.parseQuestionBatch(args.questions);
    if (batch.length > 0) {
      const first = batch[0];
      const request: QuestionRequest = {
        id: randomId('q'),
        question: first.question,
        header: first.header,
        options: first.options,
        multiple: first.multiple,
        questions: batch,
      };
      const answer = await context.askUser(request);
      return answer.trim() || 'The developer dismissed the questions without answering.';
    }
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) {
      return 'Error: question is required.';
    }
    const options = Array.isArray(args.options)
      ? args.options
          .filter((option: any) => option && typeof option.label === 'string')
          .slice(0, 5)
          .map((option: any) => ({
            label: String(option.label),
            description: typeof option.description === 'string' ? option.description : undefined,
          }))
      : [];
    const request: QuestionRequest = {
      id: randomId('q'),
      question,
      header: typeof args.header === 'string' ? args.header.slice(0, 30) : undefined,
      options,
      multiple: Boolean(args.multiple),
    };
    const answer = await context.askUser(request);
    return answer.trim() || 'The developer dismissed the question without answering.';
  }

  private parseQuestionBatch(raw: unknown): QuestionItem[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const questions: QuestionItem[] = [];
    for (const entry of raw.slice(0, 8)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const question = typeof entry.question === 'string' ? entry.question.trim() : '';
      if (!question) {
        continue;
      }
      const options = Array.isArray(entry.options)
        ? entry.options
            .filter((option: any) => option && typeof option.label === 'string')
            .slice(0, 5)
            .map((option: any) => ({
              label: String(option.label),
              description: typeof option.description === 'string' ? option.description : undefined,
            }))
        : [];
      questions.push({
        question,
        ...(typeof entry.header === 'string' ? { header: entry.header.slice(0, 30) } : {}),
        options,
        multiple: Boolean(entry.multiple),
        custom: entry.custom === undefined ? true : Boolean(entry.custom),
      });
    }
    return questions;
  }

  private async backgroundProcess(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const processes = this.options.backgroundProcesses;
    if (!processes) {
      return 'Error: background processes are not available.';
    }
    const action = String(args.action ?? 'list');
    if (action === 'start') {
      const command = String(args.command ?? '').trim();
      if (!command) {
        return 'Error: command is required to start a process.';
      }
      if (this.commandNeedsApproval(command) && !this.options.approvalMemory?.allows(command)) {
        const decision = await context.requestTerminalApproval(`background: ${command}`, this.options.root);
        if (decision === 'deny') {
          return 'The developer denied starting this background process.';
        }
        this.options.approvalMemory?.remember(command);
      }
      return processes.start(String(args.name ?? ''), command, {
        readyPattern: typeof args.ready_pattern === 'string' ? args.ready_pattern : undefined,
        readyPort: typeof args.ready_port === 'number' ? args.ready_port : undefined,
        timeoutMs: typeof args.timeout_seconds === 'number' ? args.timeout_seconds * 1000 : undefined,
      });
    }
    const id = String(args.id ?? '');
    switch (action) {
      case 'list':
        return processes.list();
      case 'status':
        return processes.status(id);
      case 'logs':
        return processes.logs(id);
      case 'stop':
        return processes.stop(id);
      default:
        return `Error: unknown background action "${action}".`;
    }
  }

  private listProcesses(): string {
    const processes = this.options.backgroundProcesses;
    if (!processes) {
      return 'No background processes are tracked by Dev-First.';
    }
    return processes.tracked();
  }

  private async useSkill(args: Record<string, any>): Promise<string> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) {
      return 'Error: skill name is required.';
    }
    const skill = await loadSkill(this.options.root, name);
    if (!skill) {
      return `Error: skill "${name}" not found.`;
    }
    const files = skill.files.length > 0 ? skill.files.map((file) => `- ${file}`).join('\n') : '(no other files)';
    return `${skill.content.trimEnd()}\n\n<skill_files>\n${files}\n</skill_files>\nBase directory: ${skill.baseDir}`;
  }

  private async runTask(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    if (!this.options.runTask) {
      return 'Error: subagents are not available in this context.';
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) {
      return 'Error: a prompt is required for the subagent.';
    }
    const description = typeof args.description === 'string' ? args.description.trim() : 'Task';
    const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type.trim() : undefined;
    return this.options.runTask({ description, prompt, subagentType }, context.signal);
  }

  private async semanticSearch(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    if (!this.options.semanticIndex) {
      return 'Error: semantic search is not available. Enable devFirst.semanticIndex and use an embeddings-capable provider.';
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return 'Error: query is required.';
    }
    const limit = clampInt(args.max_results, 1, 20) ?? 8;
    const results = await this.options.semanticIndex.search(query, limit);
    if (results.length === 0) {
      return 'No relevant code found.';
    }
    return results
      .map((result) => {
        const snippet = result.text.length > 900 ? `${result.text.slice(0, 900)}\n...` : result.text;
        return `${result.path}:${result.start}-${result.end} (score ${result.score.toFixed(3)})\n${snippet}`;
      })
      .join('\n\n---\n\n');
  }

  private async browserNavigate(args: Record<string, any>): Promise<string> {
    if (!this.options.browser) {
      return 'Error: browser automation is not available.';
    }
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) {
      return 'Error: url is required.';
    }
    return this.options.browser.navigate(url);
  }

  private async browserEvaluate(args: Record<string, any>): Promise<string> {
    if (!this.options.browser) {
      return 'Error: browser automation is not available.';
    }
    const expression = typeof args.expression === 'string' ? args.expression : '';
    if (!expression.trim()) {
      return 'Error: expression is required.';
    }
    return this.options.browser.evaluate(expression);
  }

  private async browserScreenshot(): Promise<string> {
    if (!this.options.browser) {
      return 'Error: browser automation is not available.';
    }
    return this.options.browser.screenshot(path.join(this.options.root, '.dev-first', 'screenshots'));
  }

  private needsInput(message: string, partial: Partial<CompoundResultPartial> = {}): string {
    return compoundResult({
      ...partial,
      status: 'needs_input',
      message,
      files: partial.files ?? [],
      verification: partial.verification ?? { level: 'none', checks: [] },
      rollbackAvailable: partial.rollbackAvailable ?? false,
    });
  }

  private blocked(message: string, files: string[] = []): string {
    return compoundResult({
      status: 'blocked',
      files,
      message,
      verification: { level: 'none', checks: [] },
      rollbackAvailable: false,
    });
  }

  private failed(message: string, partial: Partial<CompoundResultPartial> = {}): string {
    return compoundResult({
      ...partial,
      status: 'failed',
      message,
      files: partial.files ?? [],
      verification: partial.verification ?? { level: 'none', checks: [] },
      rollbackAvailable: partial.rollbackAvailable ?? false,
    });
  }

  private resolveCompoundTarget(value: unknown): { relative: string; absolute: string } | undefined {
    const validation = validateWorkspacePath(this.options.root, value);
    if (!validation.ok) {
      return undefined;
    }
    return { relative: validation.relative, absolute: validation.absolute };
  }

  private resolveCompoundPaths(values: unknown, partial: Partial<CompoundResultPartial> = {}): string[] | string {
    if (!Array.isArray(values)) {
      return [];
    }
    const resolved: string[] = [];
    for (const value of values) {
      const target = this.resolveCompoundTarget(value);
      if (!target) {
        return this.needsInput(`"${String(value)}" must be a workspace-relative path without escapes.`, partial);
      }
      resolved.push(target.relative);
    }
    return resolved;
  }

  private async collectDiagnostics(paths: string[]): Promise<FileDiagnostic[]> {
    if (paths.length === 0) {
      return [];
    }
    return this.safeDiagnostics([...new Set(paths)]);
  }

  private diagnosticsEvidence(items: FileDiagnostic[]): CompoundEvidence {
    const lines = diagnosticLines(items).slice(0, 40);
    return { kind: 'diagnostics', summary: lines.join('\n') || '(none)' };
  }

  private addedErrorDiagnostics(before: FileDiagnostic[], after: FileDiagnostic[]): FileDiagnostic[] {
    return after.filter(
      (item) => item.severity === 'error' && !before.some((candidate) => sameDiagnostic(candidate, item)),
    );
  }

  private compoundFiles(relativePaths: string[]): string[] {
    return [...new Set(relativePaths)];
  }

  private async compoundWrite(
    relative: string,
    absolute: string,
    next: string,
    expectedHash: string,
  ): Promise<{ ok: true } | { ok: false; stale?: string; error?: string }> {
    let current: string;
    try {
      current = await fs.readFile(absolute, 'utf-8');
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    try {
      assertFresh(expectedHash, current, relative);
    } catch (error) {
      return { ok: false, stale: errorMessage(error) };
    }
    try {
      await withFileLock(absolute, () => this.options.diffManager.applyChange(absolute, next));
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    return { ok: true };
  }

  private async inspectFileContext(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const display = String(args.path ?? '');
    const target = this.resolveCompoundTarget(args.path);
    if (!target) {
      return this.needsInput('A workspace-relative file path is required.');
    }
    const [read, symbols, diagnostics] = await Promise.all([
      readFileWithHash(this.options.root, target.relative, this.readCache),
      documentSymbolLines(target.absolute, 30).catch(() => [] as string[]),
      this.collectDiagnostics([target.absolute]),
    ]);
    if (!read) {
      return this.failed(`Error: ${display} does not exist.`, { files: [] });
    }
    const evidence: CompoundEvidence[] = [];
    const allLines = read.text.replace(/\r\n/g, '\n').split('\n');
    const endLine = budgetEndLine(allLines, 1, Math.min(200, allLines.length), MAX_READ_BYTES);
    const lines = allLines.slice(0, endLine);
    evidence.push({
      kind: 'content',
      summary: `${lines.map((line, index) => `${index + 1} | ${truncateLine(line)}`).join('\n') || '(empty file)'}`,
      file: target.relative,
    });
    evidence.push({ kind: 'symbols', summary: symbols.join('\n') || '(none)', file: target.relative });
    evidence.push(this.diagnosticsEvidence(diagnostics));
    evidence.push({ kind: 'imports', summary: importLines(read.text, 20).join('\n') || '(none)' });
    if (args.includeReferences) {
      const symbol = symbols[0] ? symbolNameFromEntry(symbols[0]) : undefined;
      if (symbol) {
        let references = '';
        try {
          references = await findReferences(target.absolute, symbol);
        } catch {}
        evidence.push({
          kind: 'references',
          summary: capLines(references, 20),
          file: target.relative,
        });
      } else {
        evidence.push({ kind: 'references', summary: '(no symbol found to reference)' });
      }
    }
    return compoundResult({
      status: 'verified',
      files: [target.relative],
      diagnostics: compoundDiagnostics(diagnostics),
      evidence,
      verification: { level: 'none', checks: ['read-only'] },
      rollbackAvailable: false,
    });
  }

  private async investigateIssue(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const display = String(args.path ?? '');
    const target = this.resolveCompoundTarget(args.path);
    if (!target) {
      return this.needsInput('A workspace-relative file path is required.');
    }
    const line = clampInt(args.line, 1, Number.MAX_SAFE_INTEGER);
    const [read, diagnostics] = await Promise.all([
      readFileWithHash(this.options.root, target.relative, this.readCache),
      this.collectDiagnostics([target.absolute]),
    ]);
    if (!read) {
      return this.failed(`Error: ${display} does not exist.`, { files: [] });
    }
    const symbol = line ? symbolAtLine(read.text, line) : undefined;
    const nearby = line ? diagnostics.filter((item) => Math.abs(item.line - line) <= 5) : diagnostics;
    const evidence: CompoundEvidence[] = [{ kind: 'diagnostics', summary: diagnosticLines(nearby.slice(0, 20)).join('\n') || '(none)' }];
    if (symbol) {
      const [references, matches] = await Promise.all([
        findReferences(target.absolute, symbol).catch((error) => `Error: ${errorMessage(error)}`),
        this.searchText({ query: symbol, max_results: 10 }, context),
      ]);
      evidence.push({ kind: 'references', summary: capLines(references, 20), file: target.relative });
      evidence.push({ kind: 'symbol-search', summary: capLines(matches, 20) });
    } else {
      evidence.push({
        kind: 'references',
        summary: '(no symbol detected; pass line to enable reference lookup)',
      });
    }
    evidence.push({ kind: 'imports', summary: importLines(read.text, 20).join('\n') || '(none)' });
    const runLines = this.options.recentRunOperations?.(display) ?? [];
    evidence.push({
      kind: 'run-journal',
      summary: runLines.slice(0, 5).join('\n') || 'No active run operations for this file.',
    });
    return compoundResult({
      status: 'verified',
      files: [target.relative],
      diagnostics: compoundDiagnostics(diagnostics),
      evidence,
      verification: { level: 'none', checks: ['read-only'] },
      rollbackAvailable: false,
    });
  }

  private async verifyChange(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const rawPaths = Array.isArray(args.paths)
      ? args.paths.filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [];
    if (rawPaths.length === 0) {
      return this.needsInput('paths must be a non-empty array of workspace-relative file paths.');
    }
    const resolved: string[] = [];
    for (const entry of rawPaths) {
      const target = this.resolveCompoundTarget(entry);
      if (!target) {
        return this.needsInput(`"${entry}" must be a workspace-relative path without escapes.`);
      }
      resolved.push(target.absolute);
    }
    const unique = [...new Set(resolved)];
    const files = this.compoundFiles(resolved.map((absolute) => path.relative(this.options.root, absolute).split(path.sep).join('/')));
    const mode = context.planning || args.mode !== 'auto' ? 'diagnostics' : 'auto';
    const diagnostics = await this.safeDiagnostics(unique);
    const errors = diagnostics.filter((item) => item.severity === 'error');
    if (errors.length > 0) {
      return this.failed(`${errors.length} error diagnostic${errors.length === 1 ? '' : 's'} remain in the checked files.`, {
        files,
        diagnostics: compoundDiagnostics(diagnostics),
        evidence: [this.diagnosticsEvidence(diagnostics)],
        verification: { level: 'none', checks: ['diagnostics'] },
        rollbackAvailable: false,
      });
    }
    if (mode === 'auto') {
      const config = getConfig();
      const resolution = await resolveProjectCommands(this.options.root, {
        typecheck: config.typecheckCommand,
        test: config.testCommand,
        lint: config.lintCommand,
        build: config.buildCommand,
      });
      if (resolution.ambiguous) {
        const listing = resolution.candidates.map((candidate) => `- ${describeCandidate(candidate)}`).join('\n');
        return this.needsInput(
          `Multiple verification candidates were found:\n${listing}\nSet devFirst.typecheckCommand, devFirst.testCommand, devFirst.lintCommand, or devFirst.buildCommand to choose one; no check ran.`,
          {
            files,
            diagnostics: compoundDiagnostics(diagnostics),
            evidence: [this.diagnosticsEvidence(diagnostics)],
            verification: { level: 'partial', checks: ['diagnostics'] },
          },
        );
      }
      const selected = resolution.selected;
      if (!selected) {
        return this.needsInput(
          'No verification command was found from settings, project manifests, or lockfiles; no check ran. Set devFirst.typecheckCommand, devFirst.testCommand, devFirst.lintCommand, or devFirst.buildCommand to define one.',
          {
            files,
            diagnostics: compoundDiagnostics(diagnostics),
            evidence: [this.diagnosticsEvidence(diagnostics)],
            verification: { level: 'partial', checks: ['diagnostics'] },
          },
        );
      }
      const check = `${selected.kind}:${selected.command}`;
      const outcome = await this.runCommand({ command: selected.command }, context);
      const passed = /^Exit code: 0\b/m.test(outcome.text);
      if (passed) {
        return compoundResult({
          status: 'verified',
          files,
          diagnostics: compoundDiagnostics(diagnostics),
          evidence: [
            this.diagnosticsEvidence(diagnostics),
            { kind: 'command', summary: `${selected.kind} ${selected.command} (${selected.source}: ${selected.reason}) — passed` },
          ],
          message: `Verified with ${selected.kind}: ${selected.command} (${selected.source}: ${selected.reason}).`,
          verification: { level: 'full', checks: ['diagnostics', check] },
          rollbackAvailable: false,
        });
      }
      return this.failed(`${selected.command} failed.`, {
        files,
        diagnostics: compoundDiagnostics(diagnostics),
        evidence: [
          this.diagnosticsEvidence(diagnostics),
          { kind: 'command', summary: capLines(outcome.text, 30) },
        ],
        verification: { level: 'none', checks: ['diagnostics', check] },
      });
    }
    if (diagnostics.length === 0) {
      return this.needsInput(
        'No diagnostics were reported for the checked files and diagnostics-only mode cannot run a command; no check ran.',
        {
          files,
          evidence: [this.diagnosticsEvidence(diagnostics)],
          verification: { level: 'partial', checks: ['diagnostics'] },
        },
      );
    }
    return this.failed(`${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'} remain in the checked files.`, {
      files,
      diagnostics: compoundDiagnostics(diagnostics),
      evidence: [this.diagnosticsEvidence(diagnostics)],
      verification: { level: 'none', checks: ['diagnostics'] },
    });
  }

  private async boundedInvestigation(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const rawOps = Array.isArray(args.operations) ? args.operations : [];
    if (rawOps.length === 0) {
      return this.needsInput('operations must be a non-empty array of { tool, args }.');
    }
    const requested = clampInt(args.maxOperations, 1, BOUNDED_HARD_CAP) ?? BOUNDED_DEFAULT_OPERATIONS;
    const limit = Math.min(requested, BOUNDED_HARD_CAP);
    if (rawOps.length > limit) {
      return this.blocked(
        `bounded_investigation is limited to ${limit} operations per call (received ${rawOps.length}).`,
      );
    }
    const ops: Array<{ tool: string; args: Record<string, any> }> = [];
    for (let index = 0; index < rawOps.length; index++) {
      const op = rawOps[index];
      if (!op || typeof op !== 'object' || Array.isArray(op)) {
        return this.blocked(`operations[${index}] must be an object with tool and args.`);
      }
      const tool = typeof op.tool === 'string' ? op.tool.trim() : '';
      if (!tool) {
        return this.blocked(`operations[${index}].tool is required.`);
      }
      if (!BOUNDED_ALLOWED_TOOLS.has(tool)) {
        return this.blocked(
          `operations[${index}] uses "${tool}", which is not allowed in bounded_investigation. Allowed: ${[
            ...BOUNDED_ALLOWED_TOOLS,
          ].join(', ')}.`,
        );
      }
      const opArgs = op.args;
      if (!opArgs || typeof opArgs !== 'object' || Array.isArray(opArgs)) {
        return this.blocked(`operations[${index}].args must be an object.`);
      }
      const schema = TOOL_SCHEMAS.get(tool);
      const required = Array.isArray((schema?.parameters as { required?: unknown } | undefined)?.required)
        ? ((schema!.parameters as { required: unknown[] }).required.filter(
            (key): key is string => typeof key === 'string',
          ))
        : [];
      for (const key of required) {
        if (opArgs[key] === undefined || opArgs[key] === null) {
          return this.blocked(`operations[${index}] (${tool}) is missing required argument "${key}".`);
        }
      }
      ops.push({ tool, args: opArgs });
    }

    const controller = new AbortController();
    let resolveAborted: () => void = () => {};
    const aborted = new Promise<'aborted'>((resolve) => {
      resolveAborted = () => resolve('aborted');
    });
    controller.signal.addEventListener('abort', () => resolveAborted());

    type OpOutcome =
      | { kind: 'done'; tool: string; text: string; truncated: boolean }
      | { kind: 'skipped'; tool: string };
    let totalBytes = 0;
    let truncated = false;
    const outcomes = await Promise.all(
      ops.map(async (op): Promise<OpOutcome> => {
        if (controller.signal.aborted) {
          return { kind: 'skipped', tool: op.tool };
        }
        const running = this.dispatch(op.tool, op.args, context)
          .then((outcome) => outcome.text)
          .catch((error) => `Error: ${errorMessage(error)}`);
        running.catch(() => undefined);
        const raced = await Promise.race([running, aborted]);
        if (raced === 'aborted') {
          return { kind: 'skipped', tool: op.tool };
        }
        let text = raced;
        let opTruncated = false;
        if (Buffer.byteLength(text, 'utf-8') > BOUNDED_OP_BYTES) {
          text = truncateUtf8(text, BOUNDED_OP_BYTES);
          opTruncated = true;
          truncated = true;
        }
        totalBytes += Buffer.byteLength(text, 'utf-8');
        if (totalBytes > BOUNDED_TOTAL_BYTES) {
          truncated = true;
          controller.abort();
        }
        return { kind: 'done', tool: op.tool, text, truncated: opTruncated };
      }),
    );

    const evidence: CompoundEvidence[] = [];
    const skipped: string[] = [];
    const referencedFiles: string[] = [];
    const opPaths = ops.map((op) => this.boundedOperationPaths(op.args));
    for (const paths of opPaths) {
      referencedFiles.push(...paths);
    }
    for (let index = 0; index < outcomes.length; index++) {
      const outcome = outcomes[index];
      if (outcome.kind === 'skipped') {
        skipped.push(outcome.tool);
        continue;
      }
      evidence.push({
        kind: 'operation',
        summary: `[${outcome.tool}]${outcome.truncated ? ' (truncated)' : ''}\n${outcome.text}`,
        ...(opPaths[index]?.[0] ? { file: opPaths[index][0] } : {}),
      });
    }
    const proposedChangeSet: ProposedChangeValidation[] = [];
    const rawProposed = Array.isArray(args.proposedChanges) ? args.proposedChanges : [];
    for (const raw of rawProposed) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        proposedChangeSet.push({ path: '', oldText: '', newText: '', ok: false, reason: 'entry must be an object' });
        continue;
      }
      const pathValue = typeof raw.path === 'string' ? raw.path : '';
      const oldText = typeof raw.oldText === 'string' ? raw.oldText : '';
      const newText = typeof raw.newText === 'string' ? raw.newText : '';
      const validation = validateWorkspacePath(this.options.root, pathValue);
      if (!validation.ok) {
        proposedChangeSet.push({
          path: pathValue,
          oldText,
          newText,
          ok: false,
          reason: validation.error,
        });
        continue;
      }
      referencedFiles.push(validation.relative);
      const read = await readFileWithHash(this.options.root, validation.relative, this.readCache);
      if (!read) {
        proposedChangeSet.push({ path: validation.relative, oldText, newText, ok: false, reason: 'file not found' });
        continue;
      }
      const lines = occurrenceLines(read.text, oldText);
      if (lines.length === 0) {
        proposedChangeSet.push({ path: validation.relative, oldText, newText, ok: false, reason: 'oldText was not found' });
        continue;
      }
      if (lines.length > 1) {
        proposedChangeSet.push({
          path: validation.relative,
          oldText,
          newText,
          ok: false,
          line: lines[0],
          reason: `oldText matches ${lines.length} locations (lines ${lines.join(', ')}); it must occur exactly once`,
        });
        continue;
      }
      proposedChangeSet.push({ path: validation.relative, oldText, newText, ok: true, line: lines[0] });
    }
    const coverage = {
      operations: ops.length - skipped.length,
      files: this.compoundFiles(referencedFiles).length,
      skipped: skipped.length,
    };
    evidence.unshift({
      kind: 'coverage',
      summary: `ran ${coverage.operations}/${ops.length} read-only operation${ops.length === 1 ? '' : 's'}; ${coverage.files} file${coverage.files === 1 ? '' : 's'} referenced${
        skipped.length > 0 ? `; skipped: ${skipped.join(', ')}` : ''
      }${truncated ? '; output truncated' : ''}`,
    });
    const files = this.compoundFiles(referencedFiles);
    const partial: Omit<CompoundResultPartial, 'status'> = {
      files,
      evidence,
      ...(truncated ? { truncated: true } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(proposedChangeSet.length > 0 ? { proposedChangeSet } : {}),
      coverage,
      verification: { level: truncated || skipped.length > 0 ? 'partial' : 'full', checks: ['read-only'] },
      rollbackAvailable: false,
    };
    const proposedProblems = proposedChangeSet.filter((entry) => !entry.ok);
    if (proposedProblems.length > 0) {
      return this.needsInput(
        `proposedChanges has ${proposedProblems.length} problem${proposedProblems.length === 1 ? '' : 's'}: ${proposedProblems
          .map((entry) => `${entry.path || '(no path)'}: ${entry.reason ?? 'invalid'}`)
          .join('; ')}.`,
        partial,
      );
    }
    return compoundResult({ ...partial, status: 'verified' });
  }

  private boundedOperationPaths(opArgs: Record<string, any>): string[] {
    const paths: string[] = [];
    for (const key of ['path', 'targetPath'] as const) {
      const value = opArgs[key];
      if (typeof value === 'string' && value.trim()) {
        paths.push(value.trim());
      }
    }
    if (Array.isArray(opArgs.paths)) {
      for (const value of opArgs.paths) {
        if (typeof value === 'string' && value.trim()) {
          paths.push(value.trim());
        }
      }
    }
    return paths;
  }

  private async applyChangeSet(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const validation = validateChangeSet(args);
    if (!validation.ok) {
      return this.needsInput(`Error: ${validation.error}`);
    }
    const allowGenerated = Boolean(args.allowGenerated);
    const resolved: Array<{ entry: ChangeSetEntry; absolute: string; relative: string }> = [];
    for (const entry of validation.changes) {
      const target = this.resolveCompoundTarget(entry.path);
      if (!target) {
        return this.blocked(`"${entry.path}" must be a workspace-relative path without escapes.`);
      }
      if (isGeneratedPath(target.relative) && !allowGenerated) {
        return this.blocked(generatedBlockedMessage(target.relative), [target.relative]);
      }
      resolved.push({ entry, absolute: target.absolute, relative: target.relative });
    }
    const files = this.compoundFiles(resolved.map((item) => item.relative));
    if (!(await this.editApproved('apply_change_set', files.join(', '), context))) {
      return this.blocked('The developer denied this edit. Do not retry it unless asked.', files);
    }
    const originals = new Map<string, FileReadResult | undefined>();
    for (const { relative } of resolved) {
      originals.set(relative, await readFileWithHash(this.options.root, relative, this.readCache));
    }
    type Planned = { entry: ChangeSetEntry; absolute: string; relative: string; before?: string; after?: string };
    const planned: Planned[] = [];
    const preflightProblems: string[] = [];
    for (const { entry, absolute, relative } of resolved) {
      const original = originals.get(relative);
      if (entry.action === 'create') {
        planned.push({ entry, absolute, relative, after: entry.content ?? '' });
        continue;
      }
      if (!original) {
        preflightProblems.push(`${relative} does not exist; use action create`);
        continue;
      }
      if (entry.action === 'delete') {
        planned.push({ entry, absolute, relative, before: original.text });
        continue;
      }
      if (entry.patch) {
        const hunks = patchHunksFor(entry.patch);
        if (hunks.length === 0) {
          preflightProblems.push(`${relative}: patch has no hunks`);
          continue;
        }
        const outcome = applyHunks(original.text, hunks);
        if (!outcome.ok) {
          preflightProblems.push(`${relative}: ${outcome.error}`);
          continue;
        }
        planned.push({ entry, absolute, relative, before: original.text, after: outcome.content });
      } else {
        planned.push({ entry, absolute, relative, before: original.text, after: entry.content ?? '' });
      }
    }
    const plannedDiff = planned
      .map((item) => changeDiff(item.relative, item.before, item.after))
      .filter(Boolean)
      .join('\n');
    if (preflightProblems.length > 0) {
      return this.failed(`Change set preflight failed; nothing was written: ${preflightProblems.join('; ')}.`, {
        files,
        ...(plannedDiff ? { diff: plannedDiff } : {}),
        evidence: [{ kind: 'checkpoint', summary: 'no files written; preflight only' }],
        rollbackAvailable: false,
      });
    }
    const checkpoint = `captured ${planned.length} file${planned.length === 1 ? '' : 's'} before any write`;
    const stale = await this.staleTargets(
      planned.map((item) => ({ relative: item.relative, absolute: item.absolute, hash: originals.get(item.relative)?.hash })),
    );
    if (stale.length > 0) {
      return this.needsInput(`Concurrent edit detected in ${stale.join(', ')}; the change set was aborted.`, {
        files,
        ...(plannedDiff ? { diff: plannedDiff } : {}),
        evidence: [{ kind: 'checkpoint', summary: `${checkpoint}; no changes applied` }],
        rollbackAvailable: false,
      });
    }
    const before = await this.collectDiagnostics(planned.map((item) => item.absolute));
    const applied: string[] = [];
    for (const item of planned) {
      const changedNow = await this.staleTargets([
        { relative: item.relative, absolute: item.absolute, hash: originals.get(item.relative)?.hash },
      ]);
      if (changedNow.length > 0) {
        const rollback = await this.rollbackApplied(applied, planned, originals);
        return this.needsInput(`Concurrent edit detected in ${changedNow.join(', ')}; the change set was aborted.`, {
          files,
          ...(plannedDiff ? { diff: plannedDiff } : {}),
          evidence: [
            { kind: 'checkpoint', summary: rollback.rolledBack.length > 0 ? `rolled back ${rollback.rolledBack.join(', ')}` : `${checkpoint}; nothing applied` },
          ],
          rollbackAvailable: rollback.rolledBack.length > 0,
        });
      }
      try {
        if (item.entry.action === 'delete') {
          await withFileLock(item.absolute, () => this.options.diffManager.applyDeletion(item.absolute));
        } else {
          await withFileLock(item.absolute, () => this.options.diffManager.applyChange(item.absolute, item.after ?? ''));
        }
        applied.push(item.relative);
      } catch (error) {
        const rollback = await this.rollbackApplied(applied, planned, originals);
        const rollbackNote =
          rollback.failedRollback.length > 0
            ? `rollback failed for ${rollback.failedRollback.join(', ')}`
            : rollback.rolledBack.length > 0
              ? `rolled back ${rollback.rolledBack.join(', ')}`
              : 'nothing needed rollback';
        return this.failed(`Change set failed at ${item.relative} — ${errorMessage(error)}.`, {
          files,
          ...(plannedDiff ? { diff: plannedDiff } : {}),
          evidence: [{ kind: 'checkpoint', summary: `${checkpoint}; ${rollbackNote}` }],
          rollbackAvailable: rollback.failedRollback.length > 0,
        });
      }
    }
    const diagnostics = await this.collectDiagnostics(planned.map((item) => item.absolute));
    const addedErrors = this.addedErrorDiagnostics(before, diagnostics);
    const evidence: CompoundEvidence[] = [
      { kind: 'checkpoint', summary: checkpoint },
      ...planned.map((item) => ({ kind: 'change', summary: `- ${item.relative} [${item.entry.action}] ok`, file: item.relative })),
      this.diagnosticsEvidence(diagnostics),
    ];
    if (addedErrors.length > 0) {
      return this.needsInput(
        `Change set applied, but ${addedErrors.length} new error diagnostic${addedErrors.length === 1 ? '' : 's'} appeared.`,
        {
          files,
          ...(plannedDiff ? { diff: plannedDiff } : {}),
          diagnostics: compoundDiagnostics(diagnostics),
          evidence,
          verification: { level: 'partial', checks: ['preflight', 'stale-guard', 'diagnostics'] },
          rollbackAvailable: true,
        },
      );
    }
    return compoundResult({
      status: 'verified',
      files,
      ...(plannedDiff ? { diff: plannedDiff } : {}),
      diagnostics: compoundDiagnostics(diagnostics),
      evidence,
      verification: { level: 'full', checks: ['preflight', 'stale-guard', 'diagnostics'] },
      rollbackAvailable: true,
    });
  }

  private async staleTargets(
    entries: Array<{ relative: string; absolute: string; hash?: string }>,
  ): Promise<string[]> {
    const stale: string[] = [];
    for (const item of entries) {
      const current = await this.readTextIfExists(item.absolute);
      if (current === undefined) {
        if (item.hash !== undefined) {
          stale.push(item.relative);
        }
        continue;
      }
      if (item.hash === undefined || sha1Of(current) !== item.hash) {
        stale.push(item.relative);
      }
    }
    return stale;
  }

  private async rollbackApplied(
    applied: string[],
    planned: Array<{ entry: ChangeSetEntry; absolute: string; relative: string }>,
    originals: Map<string, FileReadResult | undefined>,
  ): Promise<{ rolledBack: string[]; failedRollback: string[] }> {
    const rolledBack: string[] = [];
    const failedRollback: string[] = [];
    for (const relative of [...applied].reverse()) {
      const item = planned.find((candidate) => candidate.relative === relative);
      if (!item) {
        continue;
      }
      const original = originals.get(relative);
      try {
        if (original === undefined) {
          if (await this.pathExists(item.absolute)) {
            await withFileLock(item.absolute, () => this.options.diffManager.applyDeletion(item.absolute));
          }
        } else {
          await withFileLock(item.absolute, () => this.options.diffManager.applyChange(item.absolute, original.text));
        }
        rolledBack.push(relative);
      } catch {
        failedRollback.push(relative);
      }
    }
    return { rolledBack, failedRollback };
  }

  private async fixInFile(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const display = String(args.path ?? '');
    const target = this.resolveCompoundTarget(args.path);
    if (!target) {
      return this.needsInput('A workspace-relative file path is required.');
    }
    if (isGeneratedPath(target.relative) && !args.allowGenerated) {
      return this.blocked(generatedBlockedMessage(target.relative), [target.relative]);
    }
    const read = await readFileWithHash(this.options.root, target.relative, this.readCache);
    if (!read) {
      return this.needsInput(`${display} does not exist. Create it with write_file first.`, {
        files: [target.relative],
      });
    }
    const verifyPaths = this.resolveCompoundPaths(args.verify, { files: [target.relative] });
    if (typeof verifyPaths === 'string') {
      return verifyPaths;
    }
    const patch = typeof args.patch === 'string' && args.patch.trim() ? args.patch : undefined;
    const content = typeof args.content === 'string' ? args.content : undefined;
    const hasInstruction = typeof args.instruction === 'string' && args.instruction.trim().length > 0;
    const hasOldText = typeof args.oldText === 'string';
    const sources = [hasInstruction, hasOldText, Boolean(patch), content !== undefined].filter(Boolean).length;
    if (sources === 0) {
      return this.needsInput('provide instruction, oldText, patch, or content.', {
        files: [target.relative],
      });
    }
    if (sources > 1) {
      return this.needsInput('provide exactly one of instruction, oldText, patch, or content.', {
        files: [target.relative],
      });
    }
    let next: string;
    const notes: string[] = [];
    const checks: string[] = [];
    if (hasInstruction) {
      const parsed = parseInstruction(String(args.instruction));
      if (parsed.kind === 'unknown') {
        return this.needsInput(parsed.ask, { files: [target.relative] });
      }
      if (parsed.kind === 'rename') {
        const renamed = renameInContent(read.text, parsed.oldName, parsed.newName);
        if (renamed.count === 0) {
          return this.needsInput(`No occurrences of "${parsed.oldName}" were found in ${target.relative}.`, {
            files: [target.relative],
          });
        }
        next = renamed.content;
        notes.push(`renamed ${parsed.oldName} to ${parsed.newName} (${renamed.count} occurrence${renamed.count === 1 ? '' : 's'})`);
        checks.push('instruction:rename');
      } else if (parsed.kind === 'set_string') {
        const outcome = setQuotedString(read.text, parsed.name, parsed.value);
        if (!outcome.ok) {
          const lines = outcome.lines?.length ? ` Lines: ${outcome.lines.join(', ')}.` : '';
          return this.needsInput(`${outcome.reason}${lines}`, { files: [target.relative] });
        }
        next = outcome.content;
        notes.push(`set the string ${parsed.name} to "${parsed.value}"`);
        checks.push('instruction:set-string');
      } else {
        const newText = parsed.kind === 'remove' ? '' : parsed.newText;
        const lines = occurrenceLines(read.text, parsed.oldText);
        if (lines.length === 0) {
          return this.needsInput(`"${parsed.oldText}" was not found in ${target.relative}.`, {
            files: [target.relative],
          });
        }
        if (lines.length > 1) {
          return this.needsInput(
            `"${parsed.oldText}" matches ${lines.length} locations (lines ${lines.join(', ')}); the instruction is ambiguous.`,
            { files: [target.relative] },
          );
        }
        next = replaceExactAt(read.text, parsed.oldText, newText, 1) ?? read.text;
        notes.push(parsed.kind === 'remove' ? `removed ${JSON.stringify(parsed.oldText)}` : 'applied the exact replacement');
        checks.push(`instruction:${parsed.kind}`);
      }
    } else if (hasOldText) {
      const oldText = String(args.oldText);
      if (!oldText) {
        return this.needsInput('oldText must not be empty.', { files: [target.relative] });
      }
      if (typeof args.newText !== 'string') {
        return this.needsInput('newText is required with oldText.', { files: [target.relative] });
      }
      const lines = occurrenceLines(read.text, oldText);
      if (lines.length === 0) {
        return this.needsInput(`oldText was not found in ${target.relative}.`, {
          files: [target.relative],
        });
      }
      if (args.all) {
        next = replaceExactAll(read.text, oldText, String(args.newText));
        notes.push(`replaced ${lines.length} occurrence${lines.length === 1 ? '' : 's'}`);
      } else if (lines.length > 1) {
        const occurrence = clampInt(args.occurrence, 1, lines.length);
        if (occurrence === undefined) {
          return this.needsInput(
            `oldText matches ${lines.length} locations (lines ${lines.join(', ')}). Pass occurrence or all.`,
            { files: [target.relative] },
          );
        }
        next = replaceExactAt(read.text, oldText, String(args.newText), occurrence) ?? read.text;
        notes.push(`replaced occurrence ${occurrence}`);
      } else {
        next = replaceExactAt(read.text, oldText, String(args.newText), 1) ?? read.text;
        notes.push('replaced the exact match');
      }
      checks.push('exact-match');
    } else if (patch) {
      const hunks = patchHunksFor(patch);
      if (hunks.length === 0) {
        return this.failed('patch has no hunks.', { files: [target.relative] });
      }
      const applied = applyHunks(read.text, hunks);
      if (!applied.ok) {
        return this.failed(applied.error, { files: [target.relative] });
      }
      next = applied.content;
      checks.push('patch');
    } else {
      next = content ?? '';
      checks.push('content');
    }
    const verifyAbsolutes: string[] = [];
    for (const relative of verifyPaths) {
      const resolved = this.resolveCompoundTarget(relative);
      if (resolved) {
        verifyAbsolutes.push(resolved.absolute);
      }
    }
    const touched = [target.relative, ...verifyPaths];
    if (next === read.text) {
      const diagnostics = await this.collectDiagnostics([target.absolute, ...verifyAbsolutes]);
      return compoundResult({
        status: 'verified',
        files: this.compoundFiles(touched),
        diagnostics: compoundDiagnostics(diagnostics),
        evidence: [{ kind: 'change', summary: 'no changes were necessary', file: target.relative }],
        verification: { level: 'full', checks: ['stale-guard', 'diagnostics'] },
        rollbackAvailable: true,
      });
    }
    if (!(await this.editApproved('fix_in_file', display, context))) {
      return this.blocked('The developer denied this edit. Do not retry it unless asked.', [target.relative]);
    }
    const before = await this.collectDiagnostics([target.absolute, ...verifyAbsolutes]);
    const write = await this.compoundWrite(target.relative, target.absolute, next, read.hash);
    if (!write.ok) {
      if (write.stale) {
        return this.needsInput(write.stale, { files: [target.relative] });
      }
      return this.failed(write.error ?? 'the write failed.', { files: [target.relative] });
    }
    const after = await this.collectDiagnostics([target.absolute, ...verifyAbsolutes]);
    const addedErrors = this.addedErrorDiagnostics(before, after);
    const diff = changeDiff(target.relative, read.text, next);
    const evidence: CompoundEvidence[] = [
      ...notes.map((summary) => ({ kind: 'change', summary, file: target.relative })),
      this.diagnosticsEvidence(after),
    ];
    if (addedErrors.length > 0) {
      return this.needsInput(
        `Change applied to ${target.relative}, but ${addedErrors.length} new error diagnostic${addedErrors.length === 1 ? '' : 's'} appeared.`,
        {
          files: this.compoundFiles(touched),
          diff,
          diagnostics: compoundDiagnostics(after),
          evidence,
          verification: { level: 'partial', checks: [...checks, 'stale-guard', 'diagnostics'] },
          rollbackAvailable: true,
        },
      );
    }
    return compoundResult({
      status: 'verified',
      files: this.compoundFiles(touched),
      diff,
      diagnostics: compoundDiagnostics(after),
      evidence,
      verification: { level: 'full', checks: [...checks, 'stale-guard', 'diagnostics'] },
      rollbackAvailable: true,
    });
  }

  private async fixDiagnostic(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const display = String(args.path ?? '');
    const target = this.resolveCompoundTarget(args.path);
    if (!target) {
      return this.needsInput('A workspace-relative file path is required.');
    }
    if (isGeneratedPath(target.relative) && !args.allowGenerated) {
      return this.blocked(generatedBlockedMessage(target.relative), [target.relative]);
    }
    const line = clampInt(args.line, 1, Number.MAX_SAFE_INTEGER);
    if (!line) {
      return this.needsInput('line is required (1-based number).', { files: [target.relative] });
    }
    const patch = typeof args.patch === 'string' && args.patch.trim() ? args.patch : undefined;
    const content = typeof args.content === 'string' ? args.content : undefined;
    if (!patch && content === undefined) {
      return this.needsInput('provide patch or content for the fix.', { files: [target.relative] });
    }
    const read = await readFileWithHash(this.options.root, target.relative, this.readCache);
    if (!read) {
      return this.needsInput(`${display} does not exist.`, { files: [target.relative] });
    }
    const before = await this.collectDiagnostics([target.absolute]);
    const targetDiagnostic = closestDiagnostic(before, line, 3);
    if (!targetDiagnostic) {
      return this.needsInput(`No diagnostic found at or near ${display}:${line}.`, {
        files: [target.relative],
        diagnostics: compoundDiagnostics(before),
        evidence: [this.diagnosticsEvidence(before)],
        verification: { level: 'partial', checks: ['diagnostics'] },
      });
    }
    let next: string;
    if (patch) {
      const hunks = patchHunksFor(patch);
      if (hunks.length === 0) {
        return this.failed('patch has no hunks.', { files: [target.relative] });
      }
      const applied = applyHunks(read.text, hunks);
      if (!applied.ok) {
        return this.failed(applied.error, { files: [target.relative] });
      }
      next = applied.content;
    } else {
      next = content ?? '';
    }
    if (!(await this.editApproved('fix_diagnostic', display, context))) {
      return this.blocked('The developer denied this edit. Do not retry it unless asked.', [target.relative]);
    }
    const write = await this.compoundWrite(target.relative, target.absolute, next, read.hash);
    if (!write.ok) {
      if (write.stale) {
        return this.needsInput(write.stale, { files: [target.relative] });
      }
      return this.failed(write.error ?? 'the write failed.', { files: [target.relative] });
    }
    const after = await this.collectDiagnostics([target.absolute]);
    const cleared = !after.some((item) => sameDiagnostic(item, targetDiagnostic));
    const addedErrors = this.addedErrorDiagnostics(before, after);
    const diff = changeDiff(target.relative, read.text, next);
    const evidence: CompoundEvidence[] = [
      {
        kind: 'diagnostic',
        summary: `target diagnostic at ${targetDiagnostic.path}:${targetDiagnostic.line} ${cleared ? 'cleared' : 'is still present'}${addedErrors.length > 0 ? `; ${addedErrors.length} new` : ''}`,
        file: target.relative,
        line: targetDiagnostic.line,
      },
      this.diagnosticsEvidence(after),
    ];
    if (!cleared || addedErrors.length > 0) {
      const message = !cleared
        ? `The diagnostic at ${targetDiagnostic.path}:${targetDiagnostic.line} is still present after the change.`
        : `${addedErrors.length} new error diagnostic${addedErrors.length === 1 ? '' : 's'} appeared.`;
      return this.needsInput(message, {
        files: [target.relative],
        diff,
        diagnostics: compoundDiagnostics(after),
        evidence,
        verification: { level: 'partial', checks: ['stale-guard', 'diagnostics'] },
        rollbackAvailable: true,
      });
    }
    return compoundResult({
      status: 'verified',
      files: [target.relative],
      diff,
      diagnostics: compoundDiagnostics(after),
      evidence,
      verification: { level: 'full', checks: ['stale-guard', 'diagnostics'] },
      rollbackAvailable: true,
    });
  }

  private async addImportAndUse(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const display = String(args.path ?? '');
    const target = this.resolveCompoundTarget(args.path);
    if (!target) {
      return this.needsInput('A workspace-relative file path is required.');
    }
    if (isGeneratedPath(target.relative) && !args.allowGenerated) {
      return this.blocked(generatedBlockedMessage(target.relative), [target.relative]);
    }
    const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
    if (!symbol) {
      return this.needsInput('symbol is required.', { files: [target.relative] });
    }
    const read = await readFileWithHash(this.options.root, target.relative, this.readCache);
    if (!read) {
      return this.needsInput(`${display} does not exist.`, { files: [target.relative] });
    }
    if (!(await this.editApproved('add_import_and_use', display, context))) {
      return this.blocked('The developer denied this edit. Do not retry it unless asked.', [target.relative]);
    }
    const before = await this.collectDiagnostics([target.absolute]);
    const notes: string[] = [];
    let previousText = read.text;
    let importAdded = false;
    let textualImport = false;
    const zeroBased = toZeroBased(args.line, args.character);
    if (zeroBased) {
      const action = await addImportCodeActionEdit(target.absolute, args.line, args.character, symbol);
      if (action.status === 'edit' && action.edit) {
        importAdded = await applyWorkspaceEdit(action.edit);
        if (importAdded) {
          notes.push('Inserted the import with a language-server code action.');
        } else {
          notes.push('The language-server code action could not be applied.');
        }
      } else if (action.status === 'unavailable' && action.message) {
        notes.push(action.message);
      }
    }
    if (!importAdded) {
      const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const alreadyImported = new RegExp(`\\bimport\\b[^\\n]*\\b${escaped}\\b`).test(previousText);
      if (alreadyImported) {
        notes.push(`"${symbol}" is already imported.`);
      } else {
        if (args.allowTextual !== true) {
          return this.needsInput(
            'No language server is available; re-call with allowTextual: true to add the import textually (partial verification).',
            { files: [target.relative] },
          );
        }
        const source = typeof args.source === 'string' ? args.source.trim() : '';
        if (!source) {
          return this.needsInput(
            'No code action inserted the import and no source was provided to insert it textually.',
            { files: [target.relative] },
          );
        }
        const statement = buildImportStatement(symbol, source, previousText);
        const next = insertImport(previousText, statement);
        const write = await this.compoundWrite(target.relative, target.absolute, next, read.hash);
        if (!write.ok) {
          if (write.stale) {
            return this.needsInput(write.stale, { files: [target.relative] });
          }
          return this.failed(write.error ?? 'the import write failed.', { files: [target.relative] });
        }
        previousText = next;
        importAdded = true;
        textualImport = true;
        notes.push(`Inserted: ${statement}`);
      }
    }
    const patch = typeof args.patch === 'string' && args.patch.trim() ? args.patch : undefined;
    const replacement = typeof args.content === 'string' ? args.content : undefined;
    if (patch || replacement !== undefined) {
      const current = (await readFileWithHash(this.options.root, target.relative, undefined)) ?? read;
      let next: string;
      if (patch) {
        const hunks = patchHunksFor(patch);
        if (hunks.length === 0) {
          return this.failed('patch has no hunks.', { files: [target.relative] });
        }
        const applied = applyHunks(current.text, hunks);
        if (!applied.ok) {
          return this.failed(applied.error, { files: [target.relative] });
        }
        next = applied.content;
      } else {
        next = replacement ?? '';
      }
      const write = await this.compoundWrite(target.relative, target.absolute, next, current.hash);
      if (!write.ok) {
        if (write.stale) {
          return this.needsInput(write.stale, { files: [target.relative] });
        }
        return this.failed(write.error ?? 'the use-site write failed.', { files: [target.relative] });
      }
      previousText = next;
      notes.push('Applied the use-site edit.');
    }
    const after = await this.collectDiagnostics([target.absolute]);
    const addedErrors = this.addedErrorDiagnostics(before, after);
    const diff = changeDiff(target.relative, read.text, previousText);
    const evidence: CompoundEvidence[] = [
      ...notes.map((summary) => ({ kind: 'change', summary, file: target.relative })),
      this.diagnosticsEvidence(after),
    ];
    const checks = textualImport ? ['textual', 'stale-guard', 'diagnostics'] : ['stale-guard', 'diagnostics'];
    if (addedErrors.length > 0) {
      return this.needsInput(
        `Import step finished, but ${addedErrors.length} new error diagnostic${addedErrors.length === 1 ? '' : 's'} appeared.`,
        {
          files: [target.relative],
          diff,
          diagnostics: compoundDiagnostics(after),
          evidence,
          verification: { level: 'partial', checks },
          rollbackAvailable: true,
        },
      );
    }
    return compoundResult({
      status: 'verified',
      files: [target.relative],
      diff,
      diagnostics: compoundDiagnostics(after),
      evidence,
      verification: { level: textualImport ? 'partial' : 'full', checks },
      rollbackAvailable: true,
    });
  }

  private async renameSymbol(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const display = String(args.path ?? '');
    const allowGenerated = Boolean(args.allowGenerated);
    const allowTextual = args.allowTextual === true;
    const hasInstruction = typeof args.instruction === 'string' && args.instruction.trim().length > 0;
    let newName = typeof args.newName === 'string' ? args.newName.trim() : '';
    let oldNameHint = '';
    if (hasInstruction) {
      const parsed = parseInstruction(String(args.instruction));
      if (parsed.kind !== 'rename') {
        return this.needsInput(
          parsed.kind === 'unknown' ? parsed.ask : 'rename_symbol only accepts a rename instruction.',
        );
      }
      newName = parsed.newName;
      oldNameHint = parsed.oldName;
    }
    if (!isWorkspaceIdentifier(newName)) {
      return this.needsInput('newName must be a valid identifier.');
    }
    const hasTarget = typeof args.path === 'string' && args.path.trim().length > 0;
    const target = hasTarget ? this.resolveCompoundTarget(args.path) : undefined;
    if (hasTarget && !target) {
      return this.blocked(`"${display}" must be a workspace-relative path without escapes.`);
    }
    if (target && isGeneratedPath(target.relative) && !allowGenerated) {
      return this.blocked(generatedBlockedMessage(target.relative), [target.relative]);
    }
    if (!target && !oldNameHint) {
      return this.needsInput('provide path/line/character with newName, or a rename instruction.');
    }
    const verifyPaths = this.resolveCompoundPaths(args.verify, {});
    if (typeof verifyPaths === 'string') {
      return verifyPaths;
    }
    if (!(await this.editApproved('rename_symbol', display || oldNameHint, context))) {
      return this.blocked('The developer denied this edit. Do not retry it unless asked.', target ? [target.relative] : []);
    }
    const changed = new Map<string, { count: number; absolute: string; before?: string; after?: string }>();
    const evidence: CompoundEvidence[] = [];
    let warning = '';
    let applied = false;
    let textualApplied = false;
    let textHash: string | undefined;
    const textualGate = (): string | undefined =>
      allowTextual
        ? undefined
        : this.needsInput(
            'No language server is available; re-call with allowTextual: true to rename textually (partial verification).',
          );
    if (target && args.line !== undefined && args.character !== undefined) {
      const read = await readFileWithHash(this.options.root, target.relative, this.readCache);
      if (!read) {
        return this.needsInput(`${display} does not exist.`, { files: [target.relative] });
      }
      textHash = read.hash;
      const outcome = await documentRenameEdit(target.absolute, args.line, args.character, newName);
      if (outcome.status === 'edit' && outcome.edit) {
        applied = await applyWorkspaceEdit(outcome.edit);
        if (applied) {
          try {
            for (const [uri, edits] of outcome.edit.entries()) {
              const relative = vscode.workspace.asRelativePath(uri);
              changed.set(relative, {
                count: (changed.get(relative)?.count ?? 0) + edits.length,
                absolute: uri.fsPath,
              });
            }
          } catch {}
        } else {
          warning = 'The language-server rename edit could not be applied; ';
        }
      } else if (outcome.message) {
        warning = `${outcome.message} `;
      }
      if (!applied) {
        const gate = textualGate();
        if (gate) {
          return gate;
        }
        const oldName = oldNameHint || wordAtPosition(read.text, args.line, args.character);
        if (!oldName) {
          return this.needsInput(`No symbol found at ${display}:${args.line}:${args.character}.`, {
            files: [target.relative],
          });
        }
        const textual = await this.textualRename(oldName, newName, allowGenerated);
        if (textual.ambiguous.length > 0) {
          return this.needsInput(
            `Textual rename of "${oldName}" is ambiguous: ${textual.ambiguous.join('; ')}. No changes were applied; rename with a language server or disambiguate the occurrences.`,
            { files: this.compoundFiles(textual.skipped) },
          );
        }
        if (textual.stale.length > 0) {
          await this.rollbackTextualRename(textual.applied);
          return this.needsInput(
            `Concurrent edit detected in ${textual.stale.join(', ')}; the rename was aborted.`,
            { files: this.compoundFiles(textual.applied.map((item) => item.relative)) },
          );
        }
        for (const [relative, entry] of textual.changed) {
          changed.set(relative, entry);
        }
        evidence.push(...textual.skipped.map((file) => ({ kind: 'skip', summary: `skipped generated file ${file}`, file })));
        const total = [...textual.changed.values()].reduce((sum, entry) => sum + entry.count, 0);
        if (changed.size > 0) {
          textualApplied = true;
          warning = `${warning}Note: a language server rename was unavailable; applied a word-boundary textual rename (${total} occurrence${total === 1 ? '' : 's'}).`;
        }
      }
    } else if (oldNameHint) {
      const gate = textualGate();
      if (gate) {
        return gate;
      }
      const textual = await this.textualRename(oldNameHint, newName, allowGenerated);
      if (textual.ambiguous.length > 0) {
        return this.needsInput(
          `Textual rename of "${oldNameHint}" is ambiguous: ${textual.ambiguous.join('; ')}. No changes were applied; rename with a language server or disambiguate the occurrences.`,
          { files: this.compoundFiles(textual.skipped) },
        );
      }
      if (textual.stale.length > 0) {
        await this.rollbackTextualRename(textual.applied);
        return this.needsInput(`Concurrent edit detected in ${textual.stale.join(', ')}; the rename was aborted.`, {
          files: this.compoundFiles(textual.applied.map((item) => item.relative)),
        });
      }
      for (const [relative, entry] of textual.changed) {
        changed.set(relative, entry);
      }
      evidence.push(...textual.skipped.map((file) => ({ kind: 'skip', summary: `skipped generated file ${file}`, file })));
      if (textual.changed.size > 0) {
        textualApplied = true;
      }
    }
    if (changed.size === 0) {
      const name = oldNameHint || (target ? display : newName);
      return this.needsInput(`No occurrences of "${name}" found to rename.`, {
        ...(target ? { files: [target.relative] } : {}),
      });
    }
    const changedEntries = [...changed.entries()];
    const absoluteTargets = changedEntries.map(([, entry]) => entry.absolute);
    const verifyAbsolutes: string[] = [];
    for (const relative of verifyPaths) {
      const resolved = this.resolveCompoundTarget(relative);
      if (resolved) {
        verifyAbsolutes.push(resolved.absolute);
      }
    }
    const diagnostics = await this.collectDiagnostics([...absoluteTargets, ...verifyAbsolutes]);
    const addedErrors = this.addedErrorDiagnostics([], diagnostics);
    const diff = changedEntries
      .filter(([, entry]) => entry.before !== undefined && entry.after !== undefined)
      .map(([relative, entry]) => changeDiff(relative, entry.before, entry.after))
      .filter(Boolean)
      .join('\n');
    if (warning) {
      evidence.push({ kind: 'warning', summary: warning.trim() });
    }
    const files = this.compoundFiles([
      ...changedEntries.map(([relative]) => relative),
      ...verifyPaths,
    ]);
    const checks = textualApplied ? ['textual', 'stale-guard', 'diagnostics'] : ['stale-guard', 'diagnostics'];
    if (addedErrors.length > 0) {
      return this.needsInput(
        `Renamed to ${newName}, but ${addedErrors.length} error diagnostic${addedErrors.length === 1 ? '' : 's'} appeared.`,
        {
          files,
          ...(diff ? { diff } : {}),
          diagnostics: compoundDiagnostics(diagnostics),
          evidence: [...evidence, this.diagnosticsEvidence(diagnostics)],
          verification: { level: 'partial', checks },
          rollbackAvailable: true,
        },
      );
    }
    return compoundResult({
      status: 'verified',
      files,
      ...(diff ? { diff } : {}),
      diagnostics: compoundDiagnostics(diagnostics),
      evidence: [...evidence, this.diagnosticsEvidence(diagnostics)],
      message: `Renamed symbol to ${newName}.${warning ? ` ${warning.trim()}` : ''}`,
      verification: { level: textualApplied ? 'partial' : 'full', checks },
      rollbackAvailable: true,
    });
  }

  private async textualRename(
    oldName: string,
    newName: string,
    allowGenerated: boolean,
  ): Promise<{
    changed: Map<string, { count: number; absolute: string; before: string; after: string }>;
    skipped: string[];
    stale: string[];
    applied: Array<{ relative: string; absolute: string; before: string }>;
    ambiguous: string[];
  }> {
    const changed = new Map<string, { count: number; absolute: string; before: string; after: string }>();
    const skipped: string[] = [];
    const stale: string[] = [];
    const applied: Array<{ relative: string; absolute: string; before: string }> = [];
    const ambiguous: string[] = [];
    const candidates = await searchTargets(this.options.root, oldName);
    const readable: Array<{ path: string; absolute: string }> = [];
    let declarations = 0;
    for (const candidate of candidates.slice(0, UPDATE_MAX_FILES)) {
      if (isGeneratedPath(candidate.path) && !allowGenerated) {
        skipped.push(candidate.path);
        continue;
      }
      const read = await readFileWithHash(this.options.root, candidate.path, this.readCache);
      if (!read) {
        continue;
      }
      for (const reason of textualRenameHazards(read.text, oldName)) {
        ambiguous.push(`${candidate.path}: ${reason}`);
      }
      declarations += declarationCandidateCount(read.text, oldName);
      readable.push(candidate);
    }
    if (declarations > 1) {
      ambiguous.push(`multiple declaration candidates for "${oldName}"`);
    }
    if (ambiguous.length > 0) {
      return { changed, skipped, stale, applied, ambiguous };
    }
    for (const candidate of readable) {
      const read = await readFileWithHash(this.options.root, candidate.path, this.readCache);
      if (!read) {
        continue;
      }
      const renamed = renameInContent(read.text, oldName, newName);
      if (renamed.count === 0) {
        continue;
      }
      const write = await this.compoundWrite(candidate.path, candidate.absolute, renamed.content, read.hash);
      if (!write.ok) {
        if (write.stale) {
          stale.push(...applied.map((item) => item.relative), candidate.path);
          return { changed, skipped, stale, applied, ambiguous };
        }
        continue;
      }
      changed.set(candidate.path, {
        count: renamed.count,
        absolute: candidate.absolute,
        before: read.text,
        after: renamed.content,
      });
      applied.push({ relative: candidate.path, absolute: candidate.absolute, before: read.text });
    }
    return { changed, skipped, stale, applied, ambiguous };
  }

  private async rollbackTextualRename(
    applied: Array<{ relative: string; absolute: string; before: string }>,
  ): Promise<void> {
    for (const item of [...applied].reverse()) {
      try {
        await withFileLock(item.absolute, () => this.options.diffManager.applyChange(item.absolute, item.before));
      } catch {}
    }
  }

  private async updateRelatedFiles(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const allowGenerated = Boolean(args.allowGenerated);
    const hasInstruction = typeof args.instruction === 'string' && args.instruction.trim().length > 0;
    let parsed: Extract<ParsedInstruction, { kind: 'rename' | 'replace' | 'remove' }> | undefined;
    let query = typeof args.symbol_or_pattern === 'string' ? args.symbol_or_pattern.trim() : '';
    if (hasInstruction) {
      const instruction = parseInstruction(String(args.instruction));
      if (instruction.kind === 'unknown') {
        return this.needsInput(instruction.ask);
      }
      if (instruction.kind === 'set_string') {
        return this.needsInput('update_related_files supports rename, replace, or remove instructions.');
      }
      parsed = instruction;
      if (!query) {
        query = instruction.kind === 'rename' ? instruction.oldName : instruction.oldText;
      }
    }
    if (!query) {
      return this.needsInput('symbol_or_pattern or instruction is required.');
    }
    const template = typeof args.patchTemplate === 'string' ? args.patchTemplate : '';
    if (!parsed && !template.trim()) {
      return this.needsInput('patchTemplate or instruction is required.');
    }
    let hunks = patchHunksFor(template);
    if (!parsed && template.trim() && hunks.length === 0) {
      return this.failed('patchTemplate has no hunks.');
    }
    const candidates = await discoverRelatedTargets(query);
    if (candidates.length === 0) {
      return this.needsInput(`No related files found for "${query}".`);
    }
    if (candidates.length > UPDATE_CONFIRM_THRESHOLD && args.confirm !== true) {
      const listing = candidates.slice(0, 30).map((candidate) => `- ${candidate.path}`).join('\n');
      const extra = candidates.length > 30 ? `\n... and ${candidates.length - 30} more` : '';
      return this.needsInput(
        `Found ${candidates.length} candidate files (more than ${UPDATE_CONFIRM_THRESHOLD}). Re-call with confirm: true to apply, or narrow the search.\n${listing}${extra}`,
        { files: candidates.map((candidate) => candidate.path) },
      );
    }
    const selected = candidates.slice(0, UPDATE_MAX_FILES);
    if (!(await this.editApproved('update_related_files', query, context))) {
      return this.blocked('The developer denied this edit. Do not retry it unless asked.', selected.map((candidate) => candidate.path));
    }
    const results: CompoundEvidence[] = [];
    const changed: Array<{ relative: string; absolute: string; before: string; after: string }> = [];
    const applied: Array<{ relative: string; absolute: string; before: string }> = [];
    const verifyPaths = this.resolveCompoundPaths(args.verify, {});
    if (typeof verifyPaths === 'string') {
      return verifyPaths;
    }
    for (const candidate of selected) {
      if (isGeneratedPath(candidate.path) && !allowGenerated) {
        results.push({ kind: 'skip', summary: `- ${candidate.path} skipped: generated or read-only`, file: candidate.path });
        continue;
      }
      const read = await readFileWithHash(this.options.root, candidate.path, this.readCache);
      if (!read) {
        results.push({ kind: 'skip', summary: `- ${candidate.path} skipped: file not found`, file: candidate.path });
        continue;
      }
      let next: string;
      if (parsed) {
        if (parsed.kind === 'rename') {
          const renamed = renameInContent(read.text, parsed.oldName, parsed.newName);
          if (renamed.count === 0) {
            results.push({ kind: 'skip', summary: `- ${candidate.path} skipped: no occurrences`, file: candidate.path });
            continue;
          }
          next = renamed.content;
        } else {
          const newText = parsed.kind === 'remove' ? '' : parsed.newText;
          if (!read.text.includes(parsed.oldText)) {
            results.push({ kind: 'skip', summary: `- ${candidate.path} skipped: text not found`, file: candidate.path });
            continue;
          }
          next = replaceExactAll(read.text, parsed.oldText, newText);
        }
      } else {
        const outcome = applyHunks(read.text, hunks);
        if (!outcome.ok) {
          results.push({ kind: 'error', summary: `- ${candidate.path} failed: ${outcome.error}`, file: candidate.path });
          continue;
        }
        next = outcome.content;
      }
      const write = await this.compoundWrite(candidate.path, candidate.absolute, next, read.hash);
      if (!write.ok) {
        if (write.stale) {
          const affected = [...applied.map((item) => item.relative), candidate.path];
          for (const item of [...applied].reverse()) {
            try {
              await withFileLock(item.absolute, () => this.options.diffManager.applyChange(item.absolute, item.before));
            } catch {}
          }
          return this.needsInput(`Concurrent edit detected in ${affected.join(', ')}; the updates were aborted.`, {
            files: this.compoundFiles(affected),
          });
        }
        results.push({ kind: 'error', summary: `- ${candidate.path} failed: ${write.error ?? 'write failed'}`, file: candidate.path });
        continue;
      }
      changed.push({ relative: candidate.path, absolute: candidate.absolute, before: read.text, after: next });
      applied.push({ relative: candidate.path, absolute: candidate.absolute, before: read.text });
      results.push({ kind: 'change', summary: `- ${candidate.path} ok`, file: candidate.path });
    }
    const failedCount = results.filter((item) => item.kind === 'error').length;
    const verifyAbsolutes: string[] = [];
    for (const relative of verifyPaths) {
      const resolved = this.resolveCompoundTarget(relative);
      if (resolved) {
        verifyAbsolutes.push(resolved.absolute);
      }
    }
    const diagnostics = await this.collectDiagnostics([
      ...changed.map((item) => item.absolute),
      ...verifyAbsolutes,
    ]);
    const addedErrors = this.addedErrorDiagnostics([], diagnostics);
    const diff = changed
      .map((item) => changeDiff(item.relative, item.before, item.after))
      .filter(Boolean)
      .join('\n');
    const applyNote =
      candidates.length > selected.length
        ? `\n(${candidates.length - selected.length} candidates beyond the ${UPDATE_MAX_FILES}-file limit were not applied.)`
        : '';
    const message = `Updated ${changed.length}/${selected.length} files for "${query}":\n${results
      .map((item) => item.summary)
      .join('\n')}${applyNote}`;
    const files = this.compoundFiles([...changed.map((item) => item.relative), ...verifyPaths]);
    if (changed.length === 0 && failedCount > 0) {
      return this.failed(message, {
        files,
        diagnostics: compoundDiagnostics(diagnostics),
        evidence: [...results, this.diagnosticsEvidence(diagnostics)],
      });
    }
    if (addedErrors.length > 0) {
      return this.needsInput(
        `${message}\n${addedErrors.length} error diagnostic${addedErrors.length === 1 ? '' : 's'} appeared.`,
        {
          files,
          ...(diff ? { diff } : {}),
          diagnostics: compoundDiagnostics(diagnostics),
          evidence: [...results, this.diagnosticsEvidence(diagnostics)],
          verification: { level: 'partial', checks: ['stale-guard', 'diagnostics'] },
          rollbackAvailable: true,
        },
      );
    }
    return compoundResult({
      status: 'verified',
      files,
      ...(diff ? { diff } : {}),
      diagnostics: compoundDiagnostics(diagnostics),
      evidence: [...results, this.diagnosticsEvidence(diagnostics)],
      message,
      verification: { level: 'full', checks: ['stale-guard', 'diagnostics'] },
      rollbackAvailable: true,
    });
  }

  private async refactorSymbol(args: Record<string, any>, context: ToolExecutionContext): Promise<string> {
    const display = String(args.path ?? '');
    const allowGenerated = Boolean(args.allowGenerated);
    const target = this.resolveCompoundTarget(args.path);
    if (!target) {
      return this.needsInput('A workspace-relative file path is required.');
    }
    if (isGeneratedPath(target.relative) && !allowGenerated) {
      return this.blocked(generatedBlockedMessage(target.relative), [target.relative]);
    }
    const operation = args.operation === 'extract' || args.operation === 'move' ? args.operation : undefined;
    if (!operation) {
      return this.needsInput('operation must be extract or move.', { files: [target.relative] });
    }
    const range = parseRefactorRange(args.range);
    if (!range) {
      return this.needsInput('range must provide 1-based startLine, startChar, endLine, endChar.', {
        files: [target.relative],
      });
    }
    const original = await readFileWithHash(this.options.root, target.relative, this.readCache);
    if (!original) {
      return this.needsInput(`${display} does not exist.`, { files: [target.relative] });
    }
    const eol = original.text.includes('\r\n') ? '\r\n' : '\n';
    if (operation === 'extract') {
      const extracted = typeof args.extractedCode === 'string' ? args.extractedCode.trim() : '';
      const call = typeof args.callCode === 'string' ? args.callCode : '';
      if (!extracted) {
        return this.needsInput('extract requires extractedCode.', { files: [target.relative] });
      }
      if (!call.trim()) {
        return this.needsInput('extract requires callCode to replace the range.', { files: [target.relative] });
      }
      const updated = appendSnippet(replaceRange(original.text, range, call), extracted, eol);
      if (!(await this.editApproved('refactor_symbol', display, context))) {
        return this.blocked('The developer denied this edit. Do not retry it unless asked.', [target.relative]);
      }
      const write = await this.compoundWrite(target.relative, target.absolute, updated, original.hash);
      if (!write.ok) {
        if (write.stale) {
          return this.needsInput(write.stale, { files: [target.relative] });
        }
        return this.failed(write.error ?? 'the write failed.', { files: [target.relative] });
      }
      const diagnostics = await this.collectDiagnostics([target.absolute]);
      const addedErrors = this.addedErrorDiagnostics([], diagnostics);
      const diff = changeDiff(target.relative, original.text, updated);
      const evidence: CompoundEvidence[] = [
        { kind: 'change', summary: `extracted ${String(args.name ?? 'symbol')}`, file: target.relative },
        this.diagnosticsEvidence(diagnostics),
      ];
      if (addedErrors.length > 0) {
        return this.needsInput(
          `Extracted ${String(args.name ?? 'symbol')}, but ${addedErrors.length} error diagnostic${addedErrors.length === 1 ? '' : 's'} appeared.`,
          {
            files: [target.relative],
            diff,
            diagnostics: compoundDiagnostics(diagnostics),
            evidence,
            verification: { level: 'partial', checks: ['stale-guard', 'diagnostics'] },
            rollbackAvailable: true,
          },
        );
      }
      return compoundResult({
        status: 'verified',
        files: [target.relative],
        diff,
        diagnostics: compoundDiagnostics(diagnostics),
        evidence,
        message: `Extracted ${String(args.name ?? 'symbol')} in ${display}.`,
        verification: { level: 'full', checks: ['stale-guard', 'diagnostics'] },
        rollbackAvailable: true,
      });
    }
    const targetPath = typeof args.targetPath === 'string' ? args.targetPath.trim() : '';
    if (!targetPath) {
      return this.needsInput('move requires targetPath.', { files: [target.relative] });
    }
    const moveTarget = this.resolveCompoundTarget(targetPath);
    if (!moveTarget) {
      return this.blocked(`"${targetPath}" must be a workspace-relative path without escapes.`);
    }
    if (isGeneratedPath(moveTarget.relative) && !allowGenerated) {
      return this.blocked(generatedBlockedMessage(moveTarget.relative), [moveTarget.relative]);
    }
    const targetOriginal = await readFileWithHash(this.options.root, moveTarget.relative, this.readCache);
    const removed = rangeText(original.text, range);
    if (!removed.trim()) {
      return this.needsInput('the range does not contain symbol text to move.', { files: [target.relative] });
    }
    if (!(await this.editApproved('refactor_symbol', `${display} -> ${targetPath}`, context))) {
      return this.blocked('The developer denied this edit. Do not retry it unless asked.', [
        target.relative,
        moveTarget.relative,
      ]);
    }
    const header = String(args.targetHeader ?? args.callCode ?? '').trim();
    const headerAndSymbol = [header, removed.trimEnd()].filter(Boolean).join('\n');
    const targetContent = targetOriginal
      ? `${targetOriginal.text.trimEnd()}\n\n${headerAndSymbol}\n`
      : `${headerAndSymbol}\n`;
    const sourceContent = removeRange(original.text, range);
    const sourceWrite = await this.compoundWrite(target.relative, target.absolute, sourceContent, original.hash);
    if (!sourceWrite.ok) {
      if (sourceWrite.stale) {
        return this.needsInput(sourceWrite.stale, { files: [target.relative] });
      }
      return this.failed(sourceWrite.error ?? 'the source write failed.', { files: [target.relative] });
    }
    if (targetOriginal) {
      const targetWrite = await this.compoundWrite(moveTarget.relative, moveTarget.absolute, targetContent, targetOriginal.hash);
      if (!targetWrite.ok) {
        let rolledBack = false;
        try {
          await withFileLock(target.absolute, () => this.options.diffManager.applyChange(target.absolute, original.text));
          rolledBack = true;
        } catch {}
        if (!targetWrite.stale && rolledBack) {
          return this.failed(`Move failed at ${targetPath} — ${targetWrite.error ?? 'write failed'}. The source change was rolled back.`, {
            files: [target.relative, moveTarget.relative],
          });
        }
        return this.failed(
          `Move failed at ${targetPath} — ${targetWrite.stale ?? targetWrite.error ?? 'write failed'}.${
            rolledBack ? ' The source change was rolled back.' : ' The source change could NOT be rolled back.'
          }`,
          {
            files: [target.relative, moveTarget.relative],
            diff: changeDiff(target.relative, original.text, sourceContent),
            evidence: [
              {
                kind: 'checkpoint',
                summary: rolledBack ? `rolled back ${target.relative}` : `rollback failed for ${target.relative}`,
              },
            ],
            rollbackAvailable: !rolledBack,
          },
        );
      }
    } else {
      try {
        await withFileLock(moveTarget.absolute, () => this.options.diffManager.applyChange(moveTarget.absolute, targetContent));
      } catch (error) {
        let rolledBack = false;
        try {
          await withFileLock(target.absolute, () => this.options.diffManager.applyChange(target.absolute, original.text));
          rolledBack = true;
        } catch {}
        return this.failed(`Move failed at ${targetPath} — ${errorMessage(error)}.${rolledBack ? ' The source change was rolled back.' : ' The source change could NOT be rolled back.'}`, {
          files: [target.relative, moveTarget.relative],
          diff: changeDiff(target.relative, original.text, sourceContent),
          evidence: [
            { kind: 'checkpoint', summary: rolledBack ? `rolled back ${target.relative}` : `rollback failed for ${target.relative}` },
          ],
          rollbackAvailable: !rolledBack,
        });
      }
    }
    const diagnostics = await this.collectDiagnostics([target.absolute, moveTarget.absolute]);
    const addedErrors = this.addedErrorDiagnostics([], diagnostics);
    const diff = [changeDiff(target.relative, original.text, sourceContent), changeDiff(moveTarget.relative, targetOriginal?.text, targetContent)]
      .filter(Boolean)
      .join('\n');
    const evidence: CompoundEvidence[] = [
      { kind: 'change', summary: `moved ${String(args.name ?? 'symbol')}`, file: moveTarget.relative },
      this.diagnosticsEvidence(diagnostics),
    ];
    if (addedErrors.length > 0) {
      return this.needsInput(
        `Moved ${String(args.name ?? 'symbol')}, but ${addedErrors.length} error diagnostic${addedErrors.length === 1 ? '' : 's'} appeared.`,
        {
          files: [target.relative, moveTarget.relative],
          diff,
          diagnostics: compoundDiagnostics(diagnostics),
          evidence,
          verification: { level: 'partial', checks: ['stale-guard', 'diagnostics'] },
          rollbackAvailable: true,
        },
      );
    }
    return compoundResult({
      status: 'verified',
      files: [target.relative, moveTarget.relative],
      diff,
      diagnostics: compoundDiagnostics(diagnostics),
      evidence,
      message: `Moved ${String(args.name ?? 'symbol')} from ${display} to ${targetPath}.`,
      verification: { level: 'full', checks: ['stale-guard', 'diagnostics'] },
      rollbackAvailable: true,
    });
  }

  private async applySingleFileChange(
    absolute: string,
    patch: string | undefined,
    content: string | undefined,
  ): Promise<{ ok: boolean; message: string }> {
    if (patch) {
      const current = await this.readTextIfExists(absolute);
      if (current === undefined) {
        return { ok: false, message: `${path.basename(absolute)} does not exist.` };
      }
      const hunks = patchHunksFor(patch);
      if (hunks.length === 0) {
        return { ok: false, message: 'patch has no hunks.' };
      }
      const applied = applyHunks(current, hunks);
      if (!applied.ok) {
        return { ok: false, message: applied.error };
      }
      const message = await withFileLock(absolute, () =>
        this.options.diffManager.applyChange(absolute, applied.content),
      );
      return { ok: true, message };
    }
    if (content === undefined) {
      return { ok: false, message: 'provide patch or content.' };
    }
    const message = await withFileLock(absolute, () => this.options.diffManager.applyChange(absolute, content));
    return { ok: true, message };
  }

  private async safeDiagnostics(paths: string[]): Promise<FileDiagnostic[]> {
    try {
      const items = await collectFileDiagnostics(paths);
      this.recordDiagnostics(paths, items);
      return items;
    } catch {
      return [];
    }
  }

  private async adaptiveVerification(
    name: string,
    args: Record<string, any>,
    context: ToolExecutionContext,
    text: string,
  ): Promise<string> {
    if (!ADAPTIVE_COMPOUND_TOOLS.has(name)) {
      return text;
    }
    try {
      return await this.adaptiveVerifyResult(name, args, context, text);
    } catch {
      return text;
    }
  }

  private async adaptiveVerifyResult(
    name: string,
    args: Record<string, any>,
    context: ToolExecutionContext,
    text: string,
  ): Promise<string> {
    const result = parseCompoundResult(text);
    if (!result) {
      return text;
    }
    if (!getConfig().adaptiveVerify) {
      return text;
    }
    const changes = this.verificationChanges(name, args, result);
    if (changes.length === 0) {
      return text;
    }
    const touched = this.touchedSymbolsOrImports(name, result);
    const pending = this.pendingRepairChecks(changes);
    const planRequiresCheck = context.planCheckRequirement ?? this.options.planCheckRequirement;
    const input: VerificationPolicyInput = {
      changes,
      touchedSymbolsOrImports: touched,
      diagnosticsErrors: (result.diagnostics ?? []).filter((item) => item.severity === 'error').length,
      priorCheckFailed: pending.size > 0,
      packageRootCount: await this.packageRootCount(),
      resolverConfident: true,
      ...(planRequiresCheck ? { planRequiresCheck } : {}),
    };
    let plan = planVerification(input);
    if (plan.level === 3 && plan.commandKind && pending.size === 0) {
      const resolution = await this.commandFor(plan.commandKind);
      if (!resolution.candidate) {
        plan = planVerification({ ...input, resolverConfident: false });
      }
    }
    if (result.status !== 'verified') {
      return compoundResult({
        ...result,
        policyLevel: plan.level,
        reasons: plan.reasons,
      });
    }
    if (plan.needsInput && pending.size === 0) {
      const note = `Adaptive verification needs a confident ${plan.commandKind} command; none was resolved and no command ran. Set devFirst.${plan.commandKind}Command or add a manifest script.`;
      return compoundResult({
        ...result,
        status: 'needs_input',
        message: result.message ? `${result.message}\n${note}` : note,
        verification: { level: 'partial', checks: this.mergeChecks(result.verification?.checks ?? [], plan.checks) },
        policyLevel: plan.level,
        reasons: plan.reasons,
        repairAllowed: false,
      });
    }
    const listedChecks = pending.size > 0 ? [...pending] : plan.checks;
    const outcome = await this.runVerificationChecks(name, args, context, changes, result, listedChecks, touched, plan.commandKind);
    const checks = this.mergeChecks(result.verification?.checks ?? [], listedChecks);
    const evidence = [
      ...(result.evidence ?? []),
      ...outcome.evidence,
      ...outcome.skipped.map((skip) => ({ kind: 'skip', summary: `${skip.check} skipped: ${skip.reason}` })),
    ];
    if (outcome.failure) {
      const key = `${outcome.failure.path}\u0000${outcome.failure.check}`;
      const prior = this.repairStates.get(key);
      const attempts = (prior?.attempts ?? 0) + 1;
      const hash = (await this.fileHash(outcome.failure.path)) ?? '';
      this.repairStates.set(key, { attempts, hash, checkId: outcome.failure.check });
      const repairAllowed = attempts < 2;
      return compoundResult({
        ...result,
        status: 'failed',
        message: repairAllowed ? outcome.failure.message : 'Repair attempt already used; stopping.',
        verification: { level: 'none', checks },
        evidence,
        policyLevel: plan.level,
        reasons: plan.reasons,
        repairAllowed,
      });
    }
    this.clearRepairStates(changes);
    const level =
      result.verification?.level === 'full' && outcome.skipped.length === 0 ? 'full' : 'partial';
    return compoundResult({
      ...result,
      verification: { level, checks },
      evidence,
      policyLevel: plan.level,
      reasons: plan.reasons,
      repairAllowed: false,
    });
  }

  private verificationChanges(name: string, args: Record<string, any>, result: CompoundResult): VerifyChangeInfo[] {
    if (name === 'apply_change_set' && Array.isArray(args.changes)) {
      const changes: VerifyChangeInfo[] = [];
      for (const entry of args.changes) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const validation = validateWorkspacePath(this.options.root, entry.path);
        if (!validation.ok) {
          continue;
        }
        const action = entry.action === 'create' || entry.action === 'delete' ? entry.action : 'edit';
        changes.push({ path: validation.relative, action });
      }
      return changes;
    }
    return (result.files ?? []).map((file) => ({ path: file, action: 'edit' as const }));
  }

  private touchedSymbolsOrImports(name: string, result: CompoundResult): boolean {
    if (ADAPTIVE_SYMBOL_TOOLS.has(name)) {
      return true;
    }
    return (result.diff ?? '')
      .split('\n')
      .some((line) => /^\+\s*(import\b|export\b|declare\b|.*\b(function|class|interface|type|enum|namespace|struct)\b)/.test(line));
  }

  private verificationPosition(
    name: string,
    args: Record<string, any>,
  ): { absolute: string; line: number; character: number } | undefined {
    if (!ADAPTIVE_SYMBOL_TOOLS.has(name)) {
      return undefined;
    }
    const target = this.resolveCompoundTarget(args.path);
    if (!target) {
      return undefined;
    }
    const zeroBased = toZeroBased(args.line, args.character);
    if (!zeroBased) {
      return undefined;
    }
    return { absolute: target.absolute, line: zeroBased.line, character: zeroBased.character };
  }

  private mergeChecks(existing: string[], added: string[]): string[] {
    const merged = [...existing];
    for (const check of added) {
      if (!merged.includes(check)) {
        merged.push(check);
      }
    }
    return merged;
  }

  private pendingRepairChecks(changes: VerifyChangeInfo[]): Set<string> {
    const pending = new Set<string>();
    for (const change of changes) {
      for (const [key, state] of this.repairStates) {
        if (key.startsWith(`${change.path}\u0000`)) {
          pending.add(state.checkId);
        }
      }
    }
    return pending;
  }

  private clearRepairStates(changes: VerifyChangeInfo[]): void {
    for (const change of changes) {
      for (const key of [...this.repairStates.keys()]) {
        if (key.startsWith(`${change.path}\u0000`)) {
          this.repairStates.delete(key);
        }
      }
    }
  }

  private async fileHash(relative: string): Promise<string | undefined> {
    const validation = validateWorkspacePath(this.options.root, relative);
    if (!validation.ok) {
      return undefined;
    }
    const text = await this.readTextIfExists(validation.absolute);
    return text === undefined ? undefined : sha1Of(text);
  }

  private async packageRootCount(): Promise<number> {
    if (this.packageRootsCache !== undefined) {
      return this.packageRootsCache;
    }
    const queue: Array<{ dir: string; depth: number }> = [{ dir: this.options.root, depth: 0 }];
    let count = 0;
    let scanned = 0;
    while (queue.length > 0 && scanned < ADAPTIVE_PACKAGE_WALK_LIMIT) {
      const current = queue.shift()!;
      scanned++;
      let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
      try {
        entries = await fs.readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((entry) => entry.isFile() && PACKAGE_MANIFEST_FILES.has(entry.name))) {
        count++;
      }
      if (current.depth >= 2) {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
    this.packageRootsCache = Math.min(count, ADAPTIVE_PACKAGE_ROOT_CAP);
    return this.packageRootsCache;
  }

  private async commandFor(
    kind: ProjectCommandKind,
  ): Promise<{ candidate?: ProjectCommandCandidate; ambiguous: boolean }> {
    const config = getConfig();
    const resolution = await resolveProjectCommands(this.options.root, {
      typecheck: config.typecheckCommand,
      test: config.testCommand,
      lint: config.lintCommand,
      build: config.buildCommand,
    });
    const matches = resolution.candidates.filter((candidate) => candidate.kind === kind);
    if (matches.length > 1) {
      return { ambiguous: true };
    }
    return { ambiguous: false, candidate: matches[0] };
  }

  private async cachedDiagnostics(paths: string[]): Promise<FileDiagnostic[]> {
    const collected: FileDiagnostic[] = [];
    const misses: Array<{ absolute: string; text: string }> = [];
    for (const absolute of [...new Set(paths)]) {
      const text = await this.readTextIfExists(absolute);
      if (text === undefined) {
        continue;
      }
      const cached = this.adaptiveDiagnostics.get(absolute, text);
      if (cached) {
        collected.push(...cached);
      } else {
        misses.push({ absolute, text });
      }
    }
    if (misses.length > 0) {
      const found = await this.safeDiagnostics(misses.map((miss) => miss.absolute));
      for (const miss of misses) {
        const own = found.filter((item) => item.absolute === miss.absolute);
        this.adaptiveDiagnostics.set(miss.absolute, miss.text, own);
        collected.push(...own);
      }
    }
    return collected;
  }

  private async closestTestTargets(changes: VerifyChangeInfo[]): Promise<string[]> {
    const candidates = new Set<string>();
    for (const change of changes) {
      const validation = validateWorkspacePath(this.options.root, change.path);
      if (!validation.ok) {
        continue;
      }
      const uri = pathToFileURL(validation.absolute).toString();
      for (const target of [...testTargets(uri), ...adjacentTests(uri)]) {
        if (isTestFile(target)) {
          candidates.add(target);
        }
      }
    }
    const found: string[] = [];
    for (const candidate of candidates) {
      if (found.length >= MAX_CLOSEST_TESTS) {
        break;
      }
      let absolute: string;
      try {
        absolute = fileURLToPath(candidate);
      } catch {
        continue;
      }
      const relative = path.relative(this.options.root, absolute).split(path.sep).join('/');
      const validation = validateWorkspacePath(this.options.root, relative);
      if (!validation.ok) {
        continue;
      }
      if (await this.pathExists(validation.absolute)) {
        found.push(validation.relative);
      }
    }
    return found;
  }

  private async runVerificationCommand(
    command: string,
    context: ToolExecutionContext,
  ): Promise<{ passed: boolean; text: string }> {
    const outcome = await this.runCommand({ command }, context);
    return { passed: /^Exit code: 0\b/m.test(outcome.text), text: outcome.text };
  }

  private async runVerificationChecks(
    name: string,
    args: Record<string, any>,
    context: ToolExecutionContext,
    changes: VerifyChangeInfo[],
    result: CompoundResult,
    checks: string[],
    touched: boolean,
    commandKind: VerifyCheckKind | undefined,
  ): Promise<{
    performed: string[];
    skipped: Array<{ check: string; reason: string }>;
    failure?: { check: string; path: string; message: string };
    evidence: CompoundEvidence[];
  }> {
    const performed: string[] = [];
    const skipped: Array<{ check: string; reason: string }> = [];
    const evidence: CompoundEvidence[] = [];
    let failure: { check: string; path: string; message: string } | undefined;
    const wants = (check: string): boolean => checks.includes(check);
    if (wants('write')) {
      performed.push('write');
    }
    if (wants('diff')) {
      if (result.diff) {
        performed.push('diff');
      } else {
        skipped.push({ check: 'diff', reason: 'no before content' });
      }
    }
    if (wants('diagnostics')) {
      performed.push('diagnostics');
    }
    const changedAbsolute = new Set<string>();
    for (const change of changes) {
      const validation = validateWorkspacePath(this.options.root, change.path);
      if (validation.ok) {
        changedAbsolute.add(validation.absolute);
      }
    }
    const position = this.verificationPosition(name, args);
    let related: string[] | undefined;
    if (wants('references')) {
      if (!touched) {
        skipped.push({ check: 'references', reason: 'no symbol or import change' });
      } else if (!position) {
        skipped.push({ check: 'references', reason: 'no symbol position' });
      } else {
        const locations = await referenceLocationsAt(position.absolute, position.line, position.character);
        related = [...new Set(locations.map((location) => location.absolute))];
        performed.push('references');
        evidence.push({
          kind: 'references',
          summary: `${locations.length} reference(s) across ${related.length} file(s)`,
        });
      }
    }
    if (wants('related-diagnostics')) {
      if (!related && touched && position) {
        const files = await referenceFilesAt(position.absolute, position.line, position.character);
        related = [];
        for (const file of files) {
          const validation = validateWorkspacePath(this.options.root, file);
          if (validation.ok) {
            related.push(validation.absolute);
          }
        }
      }
      const capped = (related ?? [])
        .filter((absolute) => !changedAbsolute.has(absolute))
        .slice(0, MAX_RELATED_DIAGNOSTIC_FILES);
      if (capped.length === 0) {
        skipped.push({ check: 'related-diagnostics', reason: 'no related files' });
      } else {
        const diagnostics = await this.cachedDiagnostics(capped);
        performed.push('related-diagnostics');
        evidence.push(this.diagnosticsEvidence(diagnostics));
      }
    }
    if (wants('closest-test')) {
      const tests = await this.closestTestTargets(changes);
      const testCommand = await this.commandFor('test');
      if (tests.length === 0) {
        skipped.push({ check: 'closest-test', reason: 'no adjacent tests' });
      } else if (!testCommand.candidate) {
        skipped.push({
          check: 'closest-test',
          reason: testCommand.ambiguous ? 'ambiguous test commands' : 'no test command',
        });
      } else {
        for (const test of tests) {
          const command = `${testCommand.candidate.command} ${test}`;
          const outcome = await this.runVerificationCommand(command, context);
          evidence.push({ kind: 'command', summary: `${command} — ${outcome.passed ? 'passed' : 'failed'}` });
          if (!outcome.passed) {
            failure = {
              check: 'closest-test',
              path: changes[0].path,
              message: `${command} failed:\n${capLines(outcome.text, 10)}`,
            };
            break;
          }
        }
        if (!failure) {
          performed.push('closest-test');
        }
      }
    }
    if (wants('package-typecheck')) {
      if (failure) {
        skipped.push({ check: 'package-typecheck', reason: 'stopped after failure' });
      } else {
        const resolution = await this.commandFor('typecheck');
        if (!resolution.candidate) {
          skipped.push({
            check: 'package-typecheck',
            reason: resolution.ambiguous ? 'ambiguous typecheck commands' : 'no typecheck command',
          });
        } else {
          const outcome = await this.runVerificationCommand(resolution.candidate.command, context);
          evidence.push({
            kind: 'command',
            summary: `typecheck ${resolution.candidate.command} — ${outcome.passed ? 'passed' : 'failed'}`,
          });
          if (outcome.passed) {
            performed.push('package-typecheck');
          } else {
            failure = {
              check: 'package-typecheck',
              path: changes[0].path,
              message: `${resolution.candidate.command} failed:\n${capLines(outcome.text, 10)}`,
            };
          }
        }
      }
    }
    if (wants('project-command')) {
      if (failure) {
        skipped.push({ check: 'project-command', reason: 'stopped after failure' });
      } else if (!commandKind) {
        skipped.push({ check: 'project-command', reason: 'no command kind' });
      } else {
        const resolution = await this.commandFor(commandKind);
        if (!resolution.candidate) {
          skipped.push({
            check: 'project-command',
            reason: resolution.ambiguous ? `ambiguous ${commandKind} commands` : `no ${commandKind} command`,
          });
        } else {
          const outcome = await this.runVerificationCommand(resolution.candidate.command, context);
          evidence.push({
            kind: 'command',
            summary: `${commandKind} ${resolution.candidate.command} — ${outcome.passed ? 'passed' : 'failed'}`,
          });
          if (outcome.passed) {
            performed.push('project-command');
          } else {
            failure = {
              check: 'project-command',
              path: changes[0].path,
              message: `${resolution.candidate.command} failed:\n${capLines(outcome.text, 10)}`,
            };
          }
        }
      }
    }
    for (const check of performed) {
      this.recordVerification(check);
    }
    return { performed, skipped, ...(failure ? { failure } : {}), evidence };
  }

  private async pathExists(absolute: string): Promise<boolean> {
    try {
      await fs.stat(absolute);
      return true;
    } catch {
      return false;
    }
  }

  private async diagnosticsFor(paths: string[]): Promise<string> {
    if (!this.options.checkDiagnostics || paths.length === 0) {
      return '';
    }
    const items = await this.safeDiagnostics(paths);
    return diagnosticsSection(formatDiagnostics(items));
  }
}

function importLines(content: string, max: number): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) =>
      /^\s*(import\b|from\s+\S+\s+import\b|const\s+[^=]+\s*=\s*require\(|require\()/.test(line),
    )
    .slice(0, max)
    .map((line) => truncateLine(line.trim(), 200));
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf-8');
  if (buffer.length <= maxBytes) {
    return text;
  }
  return `${buffer.subarray(0, maxBytes).toString('utf-8')}\n... [truncated]`;
}

function capLines(text: string, max: number): string {
  const lines = text.split('\n');
  if (lines.length <= max) {
    return text;
  }
  return `${lines.slice(0, max).join('\n')}\n... [${lines.length - max} more lines omitted]`;
}

function sameDiagnostic(a: FileDiagnostic, b: FileDiagnostic): boolean {
  return a.path === b.path && a.line === b.line && a.message === b.message;
}

function closestDiagnostic(items: FileDiagnostic[], line: number, tolerance: number): FileDiagnostic | undefined {
  let best: FileDiagnostic | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const distance = Math.abs(item.line - line);
    if (distance > tolerance || distance >= bestDistance) {
      continue;
    }
    best = item;
    bestDistance = distance;
  }
  return best;
}

function changeSummary(before: FileDiagnostic[], after: FileDiagnostic[]): string {
  const resolved = before.filter((item) => !after.some((candidate) => sameDiagnostic(candidate, item)));
  const added = after.filter((item) => !before.some((candidate) => sameDiagnostic(candidate, item)));
  return `\n\nSummary: ${resolved.length} resolved, ${added.length} new.`;
}

const SAFE_COMMANDS = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'find',
  'grep',
  'rg',
  'echo',
  'which',
  'whoami',
  'date',
  'du',
  'df',
  'ps',
  'lsof',
  'lsappinfo',
  'netstat',
]);

const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch']);
const SAFE_GIT_BRANCH_FLAGS = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '--all',
  '--remotes',
  '--list',
  '--verbose',
  '--show-current',
]);
const SAFE_NPM_SCRIPTS = new Set(['lint', 'typecheck']);
const FORBIDDEN_WORDS = new Set(['rm', 'sudo']);
const SHELL_SEPARATOR = /\s*(?:&&|\|\||;|\|)\s*/;

export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  if (/[<>]|\$\(|`/.test(trimmed)) {
    return false;
  }
  for (const segment of trimmed.split(SHELL_SEPARATOR)) {
    const tokens = segment.trim().split(/\s+/);
    if (!tokens[0]) {
      return false;
    }
    if (tokens.some((token) => FORBIDDEN_WORDS.has(token))) {
      return false;
    }
    const program = tokens[0];
    if (program === 'git') {
      const subcommand = tokens[1] ?? '';
      if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
        return false;
      }
      if (subcommand === 'branch' && tokens.slice(2).some((token) => !SAFE_GIT_BRANCH_FLAGS.has(token))) {
        return false;
      }
      continue;
    }
    if (program === 'npm') {
      if (tokens[1] === 'test') {
        continue;
      }
      if (tokens[1] === 'run' && SAFE_NPM_SCRIPTS.has(tokens[2] ?? '')) {
        continue;
      }
      return false;
    }
    if (program === 'node') {
      if (tokens[1] === '--version' || tokens[1] === '-v') {
        continue;
      }
      return false;
    }
    if (!SAFE_COMMANDS.has(program)) {
      return false;
    }
    if (
      program === 'find' &&
      tokens.some((token) => token === '-exec' || token === '-execdir' || token === '-delete' || token === '-ok')
    ) {
      return false;
    }
  }
  return true;
}

function safeParse(json: string): Record<string, any> {
  return parseToolArguments(json);
}

function validateToolArguments(name: string, args: Record<string, any>): string | undefined {
  const schema = TOOL_SCHEMAS.get(name);
  if (!schema) {
    return undefined;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'arguments must be a JSON object';
  }
  const parameters = schema.parameters as { properties?: Record<string, any>; required?: unknown };
  const problems: string[] = [];
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  for (const key of required) {
    if (typeof key !== 'string') {
      continue;
    }
    const value = args[key];
    if (value === undefined || value === null) {
      problems.push(`missing required field "${key}"`);
    }
  }
  const properties = parameters.properties ?? {};
  for (const [key, property] of Object.entries<any>(properties)) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    const expected = property?.type;
    if (typeof expected !== 'string') {
      continue;
    }
    const problem = typeProblem(value, expected);
    if (problem) {
      problems.push(`"${key}" ${problem}`);
    }
  }
  return problems.length > 0 ? problems.join('; ') : undefined;
}

function typeProblem(value: unknown, expected: string): string | undefined {
  switch (expected) {
    case 'string':
      return typeof value === 'string' ? undefined : `must be a string (got ${describeType(value)})`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? undefined
        : `must be a finite number (got ${describeType(value)})`;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `must be a boolean (got ${describeType(value)})`;
    case 'array':
      return Array.isArray(value) ? undefined : `must be an array (got ${describeType(value)})`;
    case 'object':
      return typeof value === 'object' && !Array.isArray(value)
        ? undefined
        : `must be an object (got ${describeType(value)})`;
    default:
      return undefined;
  }
}

function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function groupRipgrepMatches(matches: RipgrepMatch[], root: string): string {
  const byFile = new Map<string, RipgrepMatch[]>();
  for (const match of matches) {
    const absolute = path.isAbsolute(match.file) ? match.file : path.join(root, match.file);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const list = byFile.get(relative);
    if (list) {
      list.push(match);
    } else {
      byFile.set(relative, [match]);
    }
  }
  const lines: string[] = [];
  for (const [file, list] of byFile) {
    lines.push(`${file}:`);
    for (const match of list) {
      lines.push(`  ${match.line}: ${truncateLine(match.text.trim().slice(0, 200))}`);
    }
  }
  return lines.join('\n');
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export { toolCallArgs };
export { IGNORED_DIRS };
