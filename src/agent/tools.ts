import { ToolCall, ToolDef } from '../llm/types';
import { parseJsonLoose } from '../util/json';

export const readFileTool: ToolDef = {
  name: 'read_file',
  description:
    'Read a text file from the workspace. Returns numbered lines. For large files, read in ranges using start_line and end_line.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path, e.g. src/app.ts' },
      start_line: { type: 'number', description: '1-based first line to read (optional).' },
      end_line: { type: 'number', description: '1-based last line to read (optional).' },
    },
    required: ['path'],
  },
};

export const listFilesTool: ToolDef = {
  name: 'list_files',
  description:
    'List files in the workspace. Optionally scope with a path and filter with a glob pattern like **/*.ts. Common ignore directories (node_modules, .git, dist, ...) are skipped.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list, relative to the workspace root (optional).' },
      glob: { type: 'string', description: 'Glob filter, e.g. **/*.ts or src/**/*.test.ts (optional).' },
    },
  },
};

export const searchTextTool: ToolDef = {
  name: 'search_text',
  description:
    'Search file contents for a text query (or a regular expression when is_regex is true). Returns matching lines with file:line prefixes.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text or regex to search for.' },
      path: { type: 'string', description: 'Directory to search in, relative to the workspace root (optional).' },
      is_regex: { type: 'boolean', description: 'Treat query as a regular expression (optional, default false).' },
      case_sensitive: { type: 'boolean', description: 'Case-sensitive matching (optional, default false).' },
      max_results: { type: 'number', description: 'Maximum matches to return (optional, default 50).' },
    },
    required: ['query'],
  },
};

export const semanticSearchTool: ToolDef = {
  name: 'semantic_search',
  description:
    'Search the codebase by meaning using embeddings. Use it for conceptual queries like "where is authentication handled" or "how are errors logged". Returns the most relevant code chunks with file paths and line ranges.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What you are looking for, in natural language.' },
      max_results: { type: 'number', description: 'Maximum chunks to return (optional, default 8).' },
    },
    required: ['query'],
  },
};

export const findSymbolTool: ToolDef = {
  name: 'find_symbol',
  description:
    'Search the workspace for symbols (functions, classes, methods, variables) by name. Returns file, line, kind, and container. Faster and more accurate than text search for code navigation.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Symbol name or partial name.' },
    },
    required: ['query'],
  },
};

export const documentSymbolsTool: ToolDef = {
  name: 'document_symbols',
  description:
    'List the symbol tree (functions, classes, methods, fields) of a file with line numbers. Use it to understand a file structure without reading the whole file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
    },
    required: ['path'],
  },
};

export const findReferencesTool: ToolDef = {
  name: 'find_references',
  description:
    'Find all references to a symbol in the workspace (language-server powered). Provide the file where the symbol is defined or used, and the symbol name.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path containing the symbol.' },
      symbol: { type: 'string', description: 'Exact symbol name.' },
    },
    required: ['path', 'symbol'],
  },
};

export const goToDefinitionTool: ToolDef = {
  name: 'go_to_definition',
  description:
    'Find where a symbol is defined (language-server powered). Provide a file where the symbol appears and the symbol name.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path containing the symbol.' },
      symbol: { type: 'string', description: 'Exact symbol name.' },
    },
    required: ['path', 'symbol'],
  },
};

export const hoverTool: ToolDef = {
  name: 'hover',
  description:
    'Show the language-server hover text (type, docs, signature) at a position in a file. Line and character are 1-based.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      line: { type: 'number', description: '1-based line number.' },
      character: { type: 'number', description: '1-based character (column) number.' },
    },
    required: ['path', 'line', 'character'],
  },
};

export const goToImplementationTool: ToolDef = {
  name: 'go_to_implementation',
  description:
    'Find the implementations of an interface, abstract method, or overridden member (language-server powered). Line and character are 1-based.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path containing the symbol.' },
      line: { type: 'number', description: '1-based line number.' },
      character: { type: 'number', description: '1-based character (column) number.' },
    },
    required: ['path', 'line', 'character'],
  },
};

export const incomingCallsTool: ToolDef = {
  name: 'incoming_calls',
  description:
    'List the callers of the function or method at a position (language-server call hierarchy). Line and character are 1-based.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      line: { type: 'number', description: '1-based line number.' },
      character: { type: 'number', description: '1-based character (column) number.' },
    },
    required: ['path', 'line', 'character'],
  },
};

export const outgoingCallsTool: ToolDef = {
  name: 'outgoing_calls',
  description:
    'List the functions or methods called by the function at a position (language-server call hierarchy). Line and character are 1-based.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path.' },
      line: { type: 'number', description: '1-based line number.' },
      character: { type: 'number', description: '1-based character (column) number.' },
    },
    required: ['path', 'line', 'character'],
  },
};

export const webFetchTool: ToolDef = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return its text content (HTML stripped). Use it to read documentation, API references, changelogs, or issue pages.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (https://...).' },
      max_chars: { type: 'number', description: 'Maximum characters to return (optional, default 30000).' },
      timeout_seconds: {
        type: 'number',
        description: 'Request timeout in seconds (optional, default 30, max 120).',
      },
    },
    required: ['url'],
  },
};

export const webSearchTool: ToolDef = {
  name: 'web_search',
  description:
    'Search the web and return the top results with titles, URLs and snippets. Use it to find documentation or solutions, then fetch promising URLs with web_fetch.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      max_results: { type: 'number', description: 'Maximum results (optional, default 5).' },
    },
    required: ['query'],
  },
};

export const writeFileTool: ToolDef = {
  name: 'write_file',
  description:
    'Create a new file or replace the entire contents of an existing file. Prefer edit_file for small changes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      content: { type: 'string', description: 'Full file contents to write.' },
    },
    required: ['path', 'content'],
  },
};

export const editFileTool: ToolDef = {
  name: 'edit_file',
  description:
    'Replace old_text with new_text in a file. old_text must match the file exactly, including whitespace and indentation. Include enough surrounding lines to be unique. Use replace_all to change every occurrence.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      old_text: { type: 'string', description: 'Exact text to replace.' },
      new_text: { type: 'string', description: 'Replacement text (empty string deletes the old text).' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (optional, default false).' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
};

export const applyPatchTool: ToolDef = {
  name: 'apply_patch',
  description:
    'Apply a multi-file patch using the *** Begin Patch format. Sections: "*** Add File: path" (lines prefixed +), "*** Update File: path" (hunks starting with @@; context lines prefixed with a space, removals with -, additions with +), "*** Delete File: path". End with "*** End Patch". Best for batch edits across several files.',
  parameters: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'The full patch text.' },
    },
    required: ['patch'],
  },
};

export const runTerminalTool: ToolDef = {
  name: 'run_terminal_command',
  description:
    'Run a shell command in the workspace root and return its combined output. Use for builds, tests, git, package installs. The developer approves each command.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run.' },
      timeout_seconds: { type: 'number', description: 'Optional timeout override in seconds.' },
    },
    required: ['command'],
  },
};

export const todoWriteTool: ToolDef = {
  name: 'todo_write',
  description:
    'Create or update the task list for the current work. Call it when you start a multi-step task and again after each step completes. Send the FULL list every time (it replaces the previous one). While work remains, keep exactly one task in_progress and the rest pending. Mark a task completed (status done) only after you have verified the result; mark dropped work cancelled instead of deleting it.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list.',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Task description.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['todos'],
  },
};

export const memoryRecallTool: ToolDef = {
  name: 'memory_recall',
  description:
    'Search the saved project memory: conventions, commands, gotchas, and decisions learned in past sessions. Use it when you need project-specific context you were not told in this session.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional search terms. Omit to read the full memory.' },
    },
  },
};

export const memorySaveTool: ToolDef = {
  name: 'memory_save',
  description:
    'Save a durable fact to project memory so future sessions know it: build/test commands, architecture decisions, gotchas, conventions. Save one concise fact at a time.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact to remember, one or two sentences.' },
      section: { type: 'string', description: 'Section name, e.g. Commands, Conventions, Gotchas (optional).' },
    },
    required: ['content'],
  },
};

export const backgroundProcessTool: ToolDef = {
  name: 'background_process',
  description:
    'Start and manage long-running processes (dev servers, watchers). Actions: start (with optional ready_pattern or ready_port), list, status, logs, stop. Never background processes with shell "&" — use this tool instead.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'list', 'status', 'logs', 'stop'] },
      id: { type: 'string', description: 'Process id or name (for status/logs/stop).' },
      name: { type: 'string', description: 'Short name for the process (for start).' },
      command: { type: 'string', description: 'Command to run (for start).' },
      ready_pattern: { type: 'string', description: 'Regex that appears in output when ready (optional).' },
      ready_port: { type: 'number', description: 'TCP port that opens when ready (optional).' },
      timeout_seconds: { type: 'number', description: 'Readiness timeout in seconds (optional, default 30).' },
    },
    required: ['action'],
  },
};

export const listProcessesTool: ToolDef = {
  name: 'list_processes',
  description:
    'List the background processes Dev-First started (dev servers, watchers, long-running commands) with name, command, start time, status, and port/readiness info. Use it to answer "is it running?" for processes Dev-First manages.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const askUserTool: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the developer one or more clarifying questions when you are blocked on a decision that only they can make. Each question offers 2-5 concrete options plus an optional custom answer. Batch related questions into a single `questions` call so they are asked on one card. Do not use it for questions you can answer by reading the code.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, one or two sentences (single-question form).' },
      header: { type: 'string', description: 'Short label (max 30 chars).' },
      options: {
        type: 'array',
        description: 'Answer options (2-5).',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Option label.' },
            description: { type: 'string', description: 'Optional explanation.' },
          },
          required: ['label'],
        },
      },
      multiple: { type: 'boolean', description: 'Allow selecting more than one option.' },
      questions: {
        type: 'array',
        description: 'Batch form: 1-4 questions asked as one card with 1/N navigation.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question, one or two sentences.' },
            header: { type: 'string', description: 'Short label (max 30 chars).' },
            options: {
              type: 'array',
              description: 'Answer options (2-5).',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Option label.' },
                  description: { type: 'string', description: 'Optional explanation.' },
                },
                required: ['label'],
              },
            },
            multiple: { type: 'boolean', description: 'Allow selecting more than one option.' },
            custom: { type: 'boolean', description: 'Allow a custom typed answer (optional, default true).' },
          },
          required: ['question'],
        },
      },
    },
  },
};

export const taskTool: ToolDef = {
  name: 'task',
  description:
    'Launch a read-only subagent that explores the codebase in a fresh context and reports back its findings. The subagent can read files, list files, search text, and run semantic search. Use it for broad exploration whose raw output you do not want in this conversation. Give it a full, self-contained prompt.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short label for the task (3-6 words).' },
      prompt: {
        type: 'string',
        description: 'The full task for the subagent: what to find, where to look, and what to report back.',
      },
      subagent_type: {
        type: 'string',
        enum: ['explore'],
        description: "Subagent type (optional, default 'explore', read-only).",
      },
    },
    required: ['description', 'prompt'],
  },
};

export const browserNavigateTool: ToolDef = {
  name: 'browser_navigate',
  description:
    'Open a URL in the connected browser (a Chrome instance started with --remote-debugging-port). Use it to test web UIs you are building.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open, e.g. http://localhost:3000' },
    },
    required: ['url'],
  },
};

export const browserEvaluateTool: ToolDef = {
  name: 'browser_evaluate',
  description:
    'Run JavaScript in the current browser page and return the result. Use it to inspect the DOM, read text, or interact (e.g. document.querySelector("#login").click()).',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'JavaScript expression to evaluate in the page.' },
    },
    required: ['expression'],
  },
};

export const browserScreenshotTool: ToolDef = {
  name: 'browser_screenshot',
  description:
    'Capture a screenshot of the current browser page and save it in the workspace. Returns the file path so the developer can open it.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const finishTool: ToolDef = {
  name: 'finish',
  description:
    'Call this when the entire plan is complete and verified. Provide a walkthrough so the developer understands what happened: a short paragraph or relevant bullets chosen to fit the result. Use section headings (What changed / How it works / Why this approach / Read next) only when useful.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'WALKTHROUGH: a short paragraph or relevant bullets chosen to fit the result. Section headings (What changed / How it works / Why this approach / Read next) only when useful. Markdown is fine.',
      },
      files: {
        type: 'array',
        description:
          'One entry per changed file, so the review panel can explain each diff. Plain language, no code.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            summary: {
              type: 'string',
              description:
                'One plain-language line, e.g. "added a Go function as middleware that talks to Redis".',
            },
          },
          required: ['path', 'summary'],
        },
      },
    },
    required: ['summary'],
  },
};

export function parseFinishFiles(args: Record<string, any>): Array<{ path: string; summary: string }> | undefined {
  if (!Array.isArray(args.files)) {
    return undefined;
  }
  const files = args.files
    .map((entry: any) => {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
        return undefined;
      }
      const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
      return { path: entry.path.trim(), summary };
    })
    .filter((entry): entry is { path: string; summary: string } => Boolean(entry?.path));
  return files.length > 0 ? files : undefined;
}

export const submitPlanTool: ToolDef = {
  name: 'submit_plan',
  description:
    'Submit a plan or a revised plan for a change request. Use this ONLY when the developer asked for a change. Do NOT use this tool for questions — answer those in plain chat text.',
  parameters: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['plan'],
        description: 'Always "plan" — use this tool only when the developer asked for a change.',
      },
      what: {
        type: 'string',
        description: 'The user-visible or code-level result of the change.',
      },
      how: {
        type: 'string',
        description:
          'How the verified code flow will work: where it enters, which real files/functions participate, what each owns, and how control or data moves between them.',
      },
      flow: {
        type: 'string',
        description:
          'Optional verified Mermaid diagram (graph TD or graph LR) when seeing a multi-component flow, boundary, or state transition is clearer than reading HOW. Omit when prose is clearer.',
      },
      why: {
        type: 'string',
        description:
          'Why this change belongs in these modules or layers. Include when ownership, layering, or the chosen approach is not obvious.',
      },
      tradeoff: {
        type: 'string',
        description:
          'Only when a real alternative existed. Name the alternative and say why it was not chosen.',
      },
      concept: {
        type: 'string',
        description:
          'One line naming the engineering concept behind a meaningful decision, e.g. "separation of concerns — UI collects input, the service owns the operation". Omit for trivial tasks.',
      },
      convention: {
        type: 'string',
        description:
          'Only when this plan follows or violates a convention from the project memory "## Conventions" section: one line naming the convention and whether this plan follows it. Omit otherwise.',
      },
      risks: {
        type: 'array',
        items: { type: 'string' },
        description: '1-2 short bullets of what could go wrong with this approach. Only with a meaningful decision.',
      },
      whyNot: {
        type: 'string',
        description: 'One line: why not the obvious alternative. Only with a meaningful decision.',
      },
      leaveAsIs: {
        type: 'string',
        description:
          'One line naming an obvious improvement that is NOT worth doing now and briefly why to leave it. Omit when nothing like that applies.',
      },
      context: {
        type: 'array',
        description:
          'Files actually read to support the plan. Give each a one-line role and source lines when known, so the developer can inspect the evidence.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative file path.' },
            role: { type: 'string', description: 'One line: what this file does in this context.' },
            startLine: { type: 'number', description: 'One-based first supporting line, when known.' },
            endLine: { type: 'number', description: 'One-based last supporting line, when known.' },
          },
          required: ['path', 'role'],
        },
      },
      trivial: {
        type: 'boolean',
        description:
          'Set true ONLY when this is a single, unambiguous, low-risk change with no alternatives — it runs immediately without a plan card or approval. When true, omit why/tradeoff/context.',
      },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete, ordered changes that implement the explanation. Name files and functions.',
      },
    },
  },
};

export const dismissPlanTool: ToolDef = {
  name: 'dismiss_plan',
  description:
    'Discard the current draft plan without changing anything. Use this ONLY when the developer asks to cancel, discard, or forget the draft plan. Do not call submit_plan and do not answer about the plan.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const setReasoningTool: ToolDef = {
  name: 'set_reasoning',
  description:
    'Change the reasoning effort for subsequent calls in this run. Only call it when the task clearly warrants it.',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'string', description: "The reasoning level to use — one of the model's valid levels." },
    },
    required: ['level'],
  },
};

export const compressContextTool: ToolDef = {
  name: 'compress_context',
  description:
    'Fold resolved earlier conversation into a summary to save context. Recent work and the pending request are always preserved. Call only when an earlier chunk of work is finished. At most once per turn.',
  parameters: {
    type: 'object',
    properties: {
      focus: {
        type: 'string',
        description: 'What the summary must preserve, e.g. decisions, files, or open questions (optional).',
      },
    },
  },
};

export interface PlannerToolSetOptions {
  reasoningSwitch?: boolean;
  compressContext?: boolean;
}

export function plannerToolSet(tools: ToolDef[], options: PlannerToolSetOptions = {}): ToolDef[] {
  const result = [...tools, submitPlanTool, dismissPlanTool];
  if (options.reasoningSwitch !== false) {
    result.push(setReasoningTool);
  }
  if (options.compressContext !== false) {
    result.push(compressContextTool);
  }
  return result;
}

export function plannerTools(options: ToolRegistryOptions = {}): ToolDef[] {
  return [...readOnlyTools(options), runTerminalTool];
}

export function useSkillTool(names: string[]): ToolDef {
  return {
    name: 'use_skill',
    description: `Load the full instructions of a project skill by name. Use when a skill matches the task. Available skills: ${names.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name.', enum: names },
      },
      required: ['name'],
    },
  };
}

export interface ToolRegistryOptions {
  skills?: string[];
  semanticSearch?: boolean;
  memory?: boolean;
  mcpTools?: ToolDef[];
  reasoningSwitch?: boolean;
  compressContext?: boolean;
  task?: boolean;
}

export function readOnlyTools(options: ToolRegistryOptions = {}): ToolDef[] {
  const tools: ToolDef[] = [
    readFileTool,
    listFilesTool,
    searchTextTool,
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
    listProcessesTool,
    askUserTool,
  ];
  if (options.semanticSearch) {
    tools.push(semanticSearchTool);
  }
  if (options.memory) {
    tools.push(memoryRecallTool);
  }
  if (options.skills?.length) {
    tools.push(useSkillTool(options.skills));
  }
  return tools;
}

export function executionTools(options: ToolRegistryOptions = {}): ToolDef[] {
  const tools: ToolDef[] = [
    ...readOnlyTools(options),
    writeFileTool,
    editFileTool,
    applyPatchTool,
    runTerminalTool,
    todoWriteTool,
    ...(options.reasoningSwitch === false ? [] : [setReasoningTool]),
    ...(options.compressContext === false ? [] : [compressContextTool]),
    backgroundProcessTool,
    browserNavigateTool,
    browserEvaluateTool,
    browserScreenshotTool,
  ];
  if (options.memory) {
    tools.push(memorySaveTool);
  }
  if (options.task) {
    tools.push(taskTool);
  }
  if (options.mcpTools?.length) {
    tools.push(...options.mcpTools);
  }
  tools.push(finishTool);
  return tools;
}

export function subagentTools(options: { semanticSearch?: boolean } = {}): ToolDef[] {
  const tools: ToolDef[] = [readFileTool, listFilesTool, searchTextTool];
  if (options.semanticSearch) {
    tools.push(semanticSearchTool);
  }
  return tools;
}

export function toolCallArgs(call: ToolCall): Record<string, any> {
  const parsed = parseJsonLoose(call.arguments);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, any>;
  }
  return {};
}

export function describeToolCall(call: ToolCall): string {
  const args = toolCallArgs(call);
  switch (call.name) {
    case 'read_file':
      return `Read ${shortPath(args.path)}${args.start_line ? `:${args.start_line}` : ''}`;
    case 'list_files':
      return `List ${shortPath(args.path) || 'workspace'}`;
    case 'search_text':
      return `Search "${truncate(String(args.query ?? ''), 40)}"`;
    case 'semantic_search':
      return `Semantic search "${truncate(String(args.query ?? ''), 40)}"`;
    case 'find_symbol':
      return `Find symbol "${truncate(String(args.query ?? ''), 30)}"`;
    case 'document_symbols':
      return `Symbols ${shortPath(args.path)}`;
    case 'find_references':
      return `References to ${truncate(String(args.symbol ?? ''), 30)}`;
    case 'go_to_definition':
      return `Definition of ${truncate(String(args.symbol ?? ''), 30)}`;
    case 'hover':
      return `Hover ${shortPath(args.path)}:${args.line ?? ''}`;
    case 'go_to_implementation':
      return `Implementations at ${shortPath(args.path)}:${args.line ?? ''}`;
    case 'incoming_calls':
      return `Callers at ${shortPath(args.path)}:${args.line ?? ''}`;
    case 'outgoing_calls':
      return `Callees at ${shortPath(args.path)}:${args.line ?? ''}`;
    case 'task':
      return `Task: ${truncate(String(args.description ?? ''), 40)}`;
    case 'web_fetch':
      return `Fetch ${truncate(String(args.url ?? ''), 60)}`;
    case 'web_search':
      return `Web search "${truncate(String(args.query ?? ''), 40)}"`;
    case 'write_file':
      return `Write ${shortPath(args.path)}`;
    case 'edit_file':
      return `Edit ${shortPath(args.path)}`;
    case 'apply_patch':
      return `Apply patch (${countPatchFiles(String(args.patch ?? ''))} file${countPatchFiles(String(args.patch ?? '')) === 1 ? '' : 's'})`;
    case 'run_terminal_command':
      return `Run: ${truncate(String(args.command ?? ''), 60)}`;
    case 'todo_write':
      return `Update tasks (${Array.isArray(args.todos) ? args.todos.length : 0})`;
    case 'set_reasoning':
      return `Reasoning ${truncate(String(args.level ?? ''), 20)}`;
    case 'compress_context':
      return args.focus ? `Compress context (${truncate(String(args.focus), 30)})` : 'Compress earlier context';
    case 'ask_user':
      return `Ask: ${truncate(String(args.question ?? ''), 50)}`;
    case 'memory_recall':
      return `Recall memory${args.query ? ` "${truncate(String(args.query), 30)}"` : ''}`;
    case 'memory_save':
      return `Remember: ${truncate(String(args.content ?? ''), 40)}`;
    case 'background_process':
      return `${String(args.action ?? 'process')} ${truncate(String(args.name ?? args.id ?? ''), 30)}`;
    case 'list_processes':
      return 'List background processes';
    case 'use_skill':
      return `Use skill ${truncate(String(args.name ?? ''), 30)}`;
    case 'browser_navigate':
      return `Open ${truncate(String(args.url ?? ''), 50)}`;
    case 'browser_evaluate':
      return `Browser eval ${truncate(String(args.expression ?? ''), 40)}`;
    case 'browser_screenshot':
      return 'Screenshot page';
    case 'finish':
      return 'Finish';
    case 'submit_plan':
      return 'Submit plan';
    case 'dismiss_plan':
      return 'Discard plan';
    default:
      return call.name;
  }
}

export interface ActivityMeta {
  detail?: string;
  detailKind?: 'terminal' | 'text';
  exitCode?: number;
  filePath?: string;
}

export function activityMeta(call: ToolCall, result: string): ActivityMeta {
  const args = toolCallArgs(call);
  const detail = result.length > 4000 ? `${result.slice(0, 4000)}\n... [output truncated]` : result;
  if (call.name === 'run_terminal_command') {
    const match = /^Exit code: (-?\d+)/m.exec(result);
    return { detail, detailKind: 'terminal', exitCode: match ? Number(match[1]) : undefined };
  }
  return {
    detail,
    detailKind: 'text',
    ...(call.name === 'read_file' && typeof args.path === 'string' ? { filePath: args.path } : {}),
  };
}

export function toolIcon(name: string): string {
  switch (name) {
    case 'read_file':
      return 'file';
    case 'list_files':
      return 'files';
    case 'search_text':
      return 'search';
    case 'semantic_search':
      return 'search-fuzzy';
    case 'find_symbol':
      return 'symbol-method';
    case 'document_symbols':
      return 'list-tree';
    case 'find_references':
      return 'references';
    case 'go_to_definition':
      return 'symbol-method';
    case 'hover':
      return 'info';
    case 'go_to_implementation':
      return 'symbol-interface';
    case 'incoming_calls':
      return 'call-incoming';
    case 'outgoing_calls':
      return 'call-outgoing';
    case 'task':
      return 'robot';
    case 'web_fetch':
    case 'web_search':
      return 'globe';
    case 'write_file':
      return 'new-file';
    case 'edit_file':
      return 'edit';
    case 'apply_patch':
      return 'diff';
    case 'run_terminal_command':
      return 'terminal';
    case 'todo_write':
      return 'checklist';
    case 'set_reasoning':
      return 'settings-gear';
    case 'compress_context':
      return 'archive';
    case 'ask_user':
      return 'question';
    case 'memory_recall':
      return 'book';
    case 'memory_save':
      return 'save';
    case 'background_process':
      return 'server-process';
    case 'list_processes':
      return 'server-process';
    case 'use_skill':
      return 'book';
    case 'browser_navigate':
    case 'browser_evaluate':
    case 'browser_screenshot':
      return 'browser';
    case 'finish':
    case 'submit_plan':
      return 'check';
    case 'dismiss_plan':
      return 'trash';
    default:
      return 'plug';
  }
}

function countPatchFiles(patch: string): number {
  const matches = patch.match(/^\*\*\* (?:Add|Update|Delete) File:/gm);
  return matches?.length ?? 0;
}

function shortPath(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    return '';
  }
  const parts = value.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : value;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
