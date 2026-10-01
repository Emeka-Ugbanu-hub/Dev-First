import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
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
import { collectDiagnostics, diagnosticsSection } from './diagnostics';
import { documentSymbols, findReferences, goToDefinition, goToImplementation, hoverAt, incomingCalls, outgoingCalls, workspaceSymbols } from './lspTools';
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
import { QuestionItem, QuestionRequest, TerminalApprovalDecision, TodoItem } from '../shared/protocol';
import { randomId } from '../util/id';
import { MemoryStore } from '../memory/MemoryStore';
import { BackgroundProcesses } from './BackgroundProcesses';
import { ApprovalMemory, ExternalDirectoryConsent } from './approvals';
import type { SubagentRequest } from './subagent';

const MAX_STREAM_BYTES = 50 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;
const SKIP_SPILL = new Set(['todo_write']);

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
]) {
  TOOL_SCHEMAS.set(definition.name, definition);
}

export interface ToolExecutionContext {
  requestTerminalApproval(command: string, cwd: string): Promise<TerminalApprovalDecision>;
  requestExternalDirectoryApproval?(directory: string): Promise<boolean>;
  askUser?(request: QuestionRequest): Promise<string>;
  signal?: AbortSignal;
  planning?: boolean;
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
}

export class ToolBox {
  private readonly externalDirectories: ExternalDirectoryConsent;

  constructor(private readonly options: ToolBoxOptions) {
    this.externalDirectories = options.externalDirectories ?? new ExternalDirectoryConsent();
    initOutputStore(options.root);
  }

  async execute(name: string, argsJson: string, context: ToolExecutionContext): Promise<string> {
    try {
      const args = safeParse(argsJson);
      const problem = validateToolArguments(name, args);
      if (problem) {
        return `Error: invalid arguments for ${name} — ${problem}. Re-emit the call with valid JSON matching the schema.`;
      }
      const outcome = await this.dispatch(name, args, context);
      if (outcome.spilled || SKIP_SPILL.has(name)) {
        return outcome.text;
      }
      return await spillOutput(outcome.text, name);
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

  private async diagnosticsFor(paths: string[]): Promise<string> {
    if (!this.options.checkDiagnostics || paths.length === 0) {
      return '';
    }
    const diagnostics = await collectDiagnostics(paths);
    return diagnosticsSection(diagnostics);
  }
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
