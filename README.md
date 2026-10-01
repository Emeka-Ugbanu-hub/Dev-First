# Dev-First

![Dev-First — Plan first. Build with confidence.](media/banner.png)

A plan-first AI coding agent for VS Code. Every request becomes a plan you approve — no code changes happen until you press **GO ON**.

## Gallery

### Plan and approval

![A Dev-First plan ready for approval](media/screenshots/plan.png)

### Scanner finding

![A scanner finding with its explanation](media/screenshots/scanning.png)

### Architecture map

![Architecture map drill-down](media/screenshots/architecture.png)

### Review changes

![Diff review bar for proposed code changes](media/screenshots/review.png)

## How it works

0. **Work where you already are.** Select code and use the lightbulb or right-click menu to **Explain**, **Fix**, **Improve**, or **Add to chat** (`Cmd+Alt+A`); add files from the Explorer or terminal output from the terminal menu. A status bar button opens the panel.
1. **Ask a question or describe what you want.** Trivial changes (single-step, low-risk) **run immediately** without a plan review — checkpoints and change review still apply. Questions are answered directly in chat, and file paths in answers are **clickable** (with optional `:line`). Larger requests produce an **ANSWER card** — a grounded explanation with a flow diagram and the key files (no GO ON). Change requests produce a **PLAN card**. Dev-First explores the codebase with read-only tools first either way.
2. **Discuss and refine.** Ask "why?", "what if?", "what are the alternatives?" — discussion stays discussion and does not force a plan. When you change what should be done, the plan updates. The card only shows the sections that matter: `WHAT`, `HOW`, `WHY`, `TRADEOFF` (which must name what the alternative does better and what it costs), `CONTEXT`, `PLAN`, plus a Mermaid flow diagram when there is a real flow. Plans are saved to `.dev-first/plans/` as markdown files you can open and keep. You can **edit the plan text directly** and **uncheck steps** to skip them before approving.
3. **Press GO ON.** The agent executes the approved plan with the full toolset: batch edits, multi-file patches, terminal commands (each approved by you), todos, browser, MCP tools.
4. **Review and learn.** Click any completed todo to **revert the workspace to that step** (per-step checkpoints), and undo a revert with **Redo**. When a run finishes with pending changes, a suggestion bar offers `/review`. The review panel groups changes by task (**This task** / **Earlier**) with per-file lines from the walkthrough (`auth/service.ts — added a Go function as middleware that talks to Redis`). Click a file to **open it with the change selected** — edit it, then accept or reject right there; expand a file to jump to individual hunks; use **Explain** for a plain-language explanation of any diff. Bulk actions are scoped per task, and edits you make by hand are detected — a reject that can't be re-located offers **revert whole file** or **keep** instead of guessing. Every run also creates a git checkpoint — use **⟲ revert to before this** to undo everything. When a run finishes you get a **walkthrough**: what changed, how it works, why this approach, and what to read next.

The planner physically cannot write files — write tools only exist during execution, after approval.

## Capabilities

| Area | What you get |
| --- | --- |
| Planning | Read-only exploration, refinement loop, conditional plan sections, Mermaid flow diagrams |
| Editing | `write_file`, `edit_file`, `apply_patch` (multi-file), diff review with Accept/Reject |
| Terminal | Command execution with per-command approval (granular auto-approve: safe commands only, all commands, or YOLO); 15s inactivity timeout with background handoff, 10-minute cap, ANSI/OSC stripping; command generation from plain English (`Cmd/Ctrl+Shift+G`), explain/fix from the terminal context menu; OS sandbox on by default (macOS `sandbox-exec` / Linux `bubblewrap`) with a one-time "run without sandbox" escape hatch |
| Intelligence | LSP diagnostics after every edit, symbol navigation tools (`find_symbol`, `find_references`, `document_symbols`, `go_to_definition`), per-model context windows (models.dev), model-family prompts, stale-read rewriting, preflight context compaction + forced-compact retry, three-segment context bar, mistake tracker with 3-strike guidance, empty-response retry, parallel read-only tools, prompt caching, diff apply fallback ladder (exact → fuzzy → drift → anchor), malformed-JSON repair, defensive file reads (line windows, head+tail truncation, streamed large files) |
| Reasoning | Model-specific reasoning controls appear only when the connected model advertises supported effort levels; thinking output appears in a collapsible row |
| Memory | Project memory persisted across sessions, injected into prompts, with `memory_recall` / `memory_save` tools |
| Processes | `background_process` tool: start dev servers/watchers with readiness detection, list/logs/stop |
| Review | Built-in `/review` command (uncommitted / staged / branch / commit), a multi-file **Diff view** button, **Summarize review** (structured scorecard) and **Review across files** (cross-file issues) actions |
| Research | `web_search`, `web_fetch`, and `semantic_search` with a **bundled local embedding model** — offline, private, no API key |
| Input | Hints in the placeholder, paste collapse (`[Pasted ~N lines]` chips), drag-and-drop images with an overlay, enhance-prompt wand (rewrites your draft, Cmd+Z restores), auto-approve shield toggle, ↑/↓ prompt history, drafts |
| Chat UI | Mermaid diagrams render inside messages, long code blocks collapse, blockquotes/task lists styled, scroll-to-bottom pill, image lightbox, markdown with syntax-highlighted code (copy button), expandable tool output (terminal output, exit codes, file reads, rich MCP rendering), error and completion cards, context usage bar with manual compact, slash-command menu, @file mentions, quote/reply, edit & rewind, queued messages, prompt history (↑/↓), draft persistence, session search (case/regex, match navigation), prompt rail, load-earlier pagination, optional completion sound |
| Autocomplete | Optional inline ghost-text completions via an FIM endpoint (`devFirst.autocomplete`, model via `devFirst.autocompleteModel`) |
| Workflow | `todo_write` task tracking, skills (`.dev-first/skills/*.md`), slash commands (`.dev-first/commands/*.md`), checkpoints/revert |
| Ecosystem | MCP servers (one-click setup), browser automation that auto-launches Chrome/Edge, git worktrees for parallel sessions (merge with conflict handoff to the agent, optional branch cleanup, `.worktreeinclude`), SCM commit-message generation |
| Notifications | Completion, error, and **waiting-on-you** notifications (plan approval, command Allow/Deny, questions) with sounds (macOS) and keep-awake while the agent runs |
| Scanning | Open-file linter: regex rules across all languages plus tree-sitter AST rules for JS/TS, Python, Java, Go, PHP (switch fallthrough, duplicate cases, unreachable code, infinite loops, nested ternaries, collapsible ifs, constant conditions, complexity/nesting/length/param metrics, unused locals/params, duplicated blocks, format mismatches, equals/hashCode, serialVersionUID, shared SimpleDateFormat, double-checked locking, wait/notify, floating promises, ReDoS, open redirects, insecure session cookies; plus flow heuristics: dead stores, null-literal deref, use-before-definition, infinite recursion, unreleased locks, collections modified while iterating, resource leaks (Java/Python/Go/JS), literal index-out-of-bounds, integer-overflow literals, class coupling; naming/import/member conventions, magic numbers, duplicated string literals, unused imports/private members, cookie/CSRF/clickjacking checks, path traversal/SSRF/NoSQL/log-injection, missing secret patterns, high-entropy strings, crypto/reflection/file-access hotspots; cross-file duplication index with clickable duplicate locations); instant squiggles + hover explanations; `// devfirst-ignore` suppression; no AI, no network |

## Setup

1. Install and open the Dev-First view in the activity bar.
2. **Connect a provider right in the panel** — pick a tile (OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, or Custom), paste a key if needed, and press **Connect**. The key is validated live; nothing is saved if it fails.
3. Pick a model from the fetched list (searchable) or type a model id.
4. Change the model anytime from the chip in the header.

Palette shortcuts still exist: **Dev-First: Set API Key** and **Dev-First: Select Model**.

### Provider presets

| Preset | Notes |
| --- | --- |
| OpenAI | GPT models |
| Anthropic | Claude models |
| Google Gemini | Gemini models |
| OpenRouter | One key, hundreds of models |
| Groq / DeepSeek | OpenAI-compatible endpoints |
| Ollama / LM Studio | Local models — **no key required** |
| Custom | Any OpenAI-compatible base URL |

Keys are stored per preset, so OpenRouter and OpenAI can both be connected without clashing.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Cmd/Ctrl+Enter` | Approve the plan (same as GO ON) |
| `Esc` | Stop the current run |
| `Cmd/Ctrl+Shift+G` | Generate a terminal command from a description |
| `Cmd/Ctrl+Alt+A` | Add selection to chat |
| `Cmd/Ctrl+Alt+E` | Explain selection |

Tool activity rows are clickable — expand any of them to see the actual output (command output with exit code, file reads, search results).

## Reasoning, memory, and processes

- **Reasoning**: choose from the effort levels advertised by the selected model in the composer. Values are saved per provider/model; the "Thinking…" row streams live and collapses when done.
- **Memory**: the agent can save durable facts (`memory_save`) and recall them later (`memory_recall`); memory is injected into every prompt. Disable with `devFirst.memory`. Stored per workspace in global storage.
- **Background processes**: the agent can start long-running processes with `background_process` (readiness by output pattern or port), then read logs and stop them — instead of blocking on `npm run dev`.
- **Review**: type `/review` (optionally `/review branch main`) for a read-only code review, or click **Diff view** in the review bar to open VS Code's multi-file diff.

## Autocomplete (optional)

Set `devFirst.autocomplete` to `true` to enable inline ghost-text completions.

- **Model** — `devFirst.autocompleteModel` left empty means *auto*: a FIM model is chosen for the connected provider (Codestral for OpenRouter, `qwen2.5-coder` for Ollama). Set it explicitly to override.
- **Chat fallback** — when no FIM model applies (OpenAI, Anthropic, Gemini, custom), Dev-First asks the connected chat model for the completion. It's throttled to one call per second, uses a small context (~1k chars), caps output at 128 tokens, and skips comments/strings, so token usage stays low. Disable with `devFirst.autocompleteFallback: false`.
- **First failure** shows a one-time notice with a shortcut to the settings.

## Sessions

The tab strip above the chat holds multiple sessions. **+** starts a new one; the history button opens a searchable list where you can rename, delete, or resume any past session. Every session is stored per workspace in global storage, and your old single-session state is migrated automatically.

## Images

Paste or drop images into the input (up to 4) and they are sent with your message to vision-capable models — OpenAI, Anthropic, and Gemini are all mapped natively.

## Selection context

Select code in the editor and a chip appears above the input (`app.ts:10–20`). The selection is attached to your message — both the planner and the executor see it. Remove the chip to send without it.

## Project files

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Project rules injected into planner + executor prompts |
| `.dev-first/rules.md` | Additional project rules |
| `.dev-first/skills/*.md` | Skills loadable with the `use_skill` tool |
| `.dev-first/commands/*.md` | Slash commands (`/name args`, `$ARGUMENTS` is replaced) |
| `.dev-first/mcp.json` | MCP servers: `{ "mcpServers": { "name": { "command": "...", "args": [] } } }` |
| `~/.dev-first/AGENTS.md`, `~/.dev-first/skills`, `~/.dev-first/mcp.json` | Global equivalents |

## Settings

Open the **gear icon** for the in-panel settings view: **Provider** (connection + reconnect flow), **Behavior** (safety, accuracy, context, autocomplete), **Display** (rendering, notifications), and **About**. Changes apply instantly with a brief "Saved" confirmation. The same options remain available in VS Code settings (linked from About).

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.preset` | `openai` | Provider preset (set from the panel) |
| `devFirst.provider` | `openai` | Underlying adapter |
| `devFirst.baseUrl` | provider default | Custom API base URL |
| `devFirst.model` | `gpt-4o` | Model id |
| `devFirst.maxSteps` | `60` | Max tool steps per execution |
| `devFirst.plannerMaxSteps` | `12` | Max exploration steps while planning |
| `devFirst.terminalTimeout` | `120` | Terminal timeout (seconds) |
| `devFirst.autoApproveTerminal` | `false` | Skip terminal approval prompts |
| `devFirst.checkDiagnostics` | `true` | Feed language-server diagnostics back after edits |
| `devFirst.autoCompact` | `true` | Summarize the conversation near the context limit |
| `devFirst.contextLimitTokens` | `128000` | Context window used for compaction decisions |
| `devFirst.semanticIndex` | `true` | Enable `semantic_search` |
| `devFirst.embeddingsProvider` | `local` | `local` = bundled MiniLM (offline) · `api` = provider embeddings |
| `devFirst.embeddingsModel` | `text-embedding-3-small` | Embeddings model when using `api` |
| `devFirst.sandbox` | `workspace-write` | Sandbox terminal command writes |
| `devFirst.browserPort` | `9222` | Chrome DevTools Protocol port for browser tools |
| `devFirst.browserAutoLaunch` | `true` | Auto-launch Chrome/Edge with a dedicated profile |

## Browser automation

Works out of the box: the first time a browser tool runs, Dev-First launches Chrome or Edge with a dedicated profile (your normal browser session is never touched). If you prefer your own browser, start it yourself:

```bash
google-chrome --remote-debugging-port=9222
# or: open -a "Google Chrome" --args --remote-debugging-port=9222
```

Tools: `browser_navigate`, `browser_evaluate` (run JS, click, read DOM), `browser_screenshot`.

## MCP servers

Run **Dev-First: Set Up MCP Servers** to add the recommended servers (filesystem, memory, sequential-thinking) to `.dev-first/mcp.json` in one step, or **Dev-First: Add MCP Server** for a custom command. Tools appear as `serverName_toolName` during execution.

## Semantic search

`semantic_search` works with no setup: the extension bundles the all-MiniLM-L6-v2 embedding model and runs it locally on CPU — nothing leaves your machine. Pre-build the index with **Dev-First: Build Semantic Index**, or let the first search trigger indexing.

## Parallel worktrees

Run **Dev-First: New Session in Worktree** to create a git worktree with a `dev-first/<name>` branch and open it in a new window. Each window runs its own independent Dev-First session. Remove them with **Dev-First: Remove Worktree**.

## Development

```bash
npm install
npm run build        # extension (esbuild) + webview (vite)
npm test             # unit tests (vitest)
npm run typecheck    # extension + webview typecheck
npm run smoke        # boot the built extension with a stubbed vscode API
npm run smoke:embed  # load the bundled embedding model and verify it
npm run package      # build + create the VSIX (vsce)
```

Press `F5` to launch the Extension Development Host.

Note: the packaged VSIX includes `onnxruntime-node` binaries for the platform it was built on. Build on Linux/Windows (or use `vsce package --target`) for other platforms.

## Acknowledgements

Model catalog metadata is sourced from [models.dev](https://models.dev/).
