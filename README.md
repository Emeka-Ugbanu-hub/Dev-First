# Dev-First

![Dev-First — Plan first. Build with confidence.](media/banner.png)

> **Dev-First is an open-source, plan-first coding agent for VS Code.** It helps developers understand their code, decide what should happen, and stay in control while AI carries out the work.

Dev-First was built around a simple developer need: see the work before it happens. Requests that need changes become a clear plan with the intended steps and files. You can ask questions, refine the plan, approve it, watch the execution, inspect the real diff, and learn how the result works. Small, low-risk requests can still be handled directly.

The goal is speed with understanding: less repetitive orchestration, safer changes, and a codebase that becomes easier to read as you work on it.

## How it works

0. **Work where you already are.** Select code and use the lightbulb or right-click menu to **Explain**, **Fix**, **Improve**, or **Add to chat** (`Cmd+Alt+A`); add files from the Explorer or terminal output from the terminal menu. A status bar button opens the panel.
1. **Ask a question or describe what you want.** Trivial changes (single-step, low-risk) **run immediately** without a plan review — checkpoints and change review still apply. Questions are answered directly in chat, and file paths in answers are **clickable** (with optional `:line`). Larger requests produce an **ANSWER card** — a grounded explanation with a flow diagram and the key files (no GO ON). Change requests produce a **PLAN card**. Dev-First explores the codebase with read-only tools first either way.
2. **Discuss and refine.** Ask "why?", "what if?", "what are the alternatives?" — discussion stays discussion and does not force a plan. When you change what should be done, the plan updates. The card only shows the sections that matter: `WHAT`, `HOW`, `WHY`, `TRADEOFF` (which must name what the alternative does better and what it costs), `CONTEXT`, `PLAN`, plus a Mermaid flow diagram when there is a real flow. Plans are saved to `.dev-first/plans/` as markdown files you can open and keep. You can **edit the plan text directly** and **uncheck steps** to skip them before approving.
3. **Press GO ON.** The agent executes the approved plan with the full toolset: compound edit tools first, raw edit tools as fallbacks, terminal commands (each approved by you), todos, browser, MCP tools.
4. **Review and learn.** Click any completed todo to **revert the workspace to that step** (per-step checkpoints), and undo a revert with **Redo**. When a run finishes with pending changes, a suggestion bar offers `/review`. The review panel groups changes by task (**This task** / **Earlier**) with per-file lines from the walkthrough (`auth/service.ts — added a Go function as middleware that talks to Redis`). Click a file to **open it with the change selected** — edit it, then accept or reject right there; expand a file to jump to individual hunks; use **Explain** for a plain-language explanation of any diff. Bulk actions are scoped per task, and edits you make by hand are detected — a reject that can't be re-located offers **revert whole file** or **keep** instead of guessing. Every run also creates a git checkpoint — use **⟲ revert to before this** to undo everything. When a run finishes you get a **walkthrough**: what changed, how it works, why this approach, and what to read next.

The planner physically cannot write files — write tools only exist during execution, after approval.

| Stage | What happens |
| --- | --- |
| Plan | A read-only planner explores with targeted reads and LSP tools, then submits an **ANSWER**, a **PLAN**, or runs a trivial change directly. |
| Approve | **GO ON** starts execution. Before that you can refine the discussion, edit the plan text, uncheck steps, or cancel the draft. |
| Execute | The executor prefers compound tools for coordinated edits and verification; raw edit tools remain fallbacks. |
| Verify | Adaptive L0–L3 verification escalates from diagnostics to related files, closest tests, and the resolved project command. Exactly one repair attempt is allowed. |
| Recover | A durable run journal plus crash-safe file snapshots survive restarts. The Recovery card offers Resume / Roll back / Discard — nothing runs automatically. |
| Review | Diff review, checkpoints, and a completion walkthrough close the loop. |

Context pipeline: **select** (recent messages and pinned context) → **project** (repo map, references, semantic search) → **compact** (profile-triggered summaries and deterministic pruning).

## What Dev-First gives you

### Plan before code

- Read-only exploration before edits.
- Plans with `WHAT`, `HOW`, `WHY`, `TRADEOFF`, context, ordered steps, expected files, and diagrams when useful.
- Editable plans, follow-up discussion, step checkboxes, and approval with **GO ON**.
- Direct answers and small actions without forcing a plan when one is not useful.

### Safe execution and verification

- Approval-gated writes and terminal commands.
- Compound tools for common edits, atomic writes, checkpoints, rollback, and diff review.
- Adaptive verification: diagnostics first, then related files, references, closest tests, and project checks when risk requires it.
- One bounded repair attempt instead of an unbounded fix loop.

### Understand and improve the codebase

- Evidence-backed architecture maps with drill-down into UI, logic, storage, integrations, runtime, and tooling.
- Symbols, imports, references, diagnostics, related-file lookup, and local semantic search.
- On-demand **Scan File** review with exact-line squiggles and findings for vulnerability, bug, secret, smell, architecture, maintainability, and scalability.
- Mermaid diagrams and plain-language explanations when they improve understanding.

### Review, learn, and recover

- Multi-file diff review, per-step checkpoints, revert/redo, and completion walkthroughs.
- Durable run journals, recovery cards, queued-message recovery, and safe resume, rollback, or discard after a restart.
- Context profiles, pinned essentials, archive rotation, relevance retrieval, deterministic summaries, and local embeddings.

### Research and everyday tools

- Cached `web_search` and `web_fetch` with retries, citations, and an untrusted web-content boundary.
- Browser automation, background processes, MCP servers, git worktrees, optional autocomplete, images, file mentions, slash commands, skills, memory, notifications, and sound controls.

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

Keys are stored per preset, so OpenRouter and OpenAI can both be connected without clashing. Scanner and architecture operations can use their own provider/model/effort overrides (`devFirst.scanPreset`, `devFirst.scanModel`, `devFirst.architecturePreset`, …) instead of the main connection.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Cmd/Ctrl+Enter` | Approve the plan (same as GO ON) |
| `Esc` | Stop the current run |
| `Cmd/Ctrl+Shift+G` | Generate a terminal command from a description (terminal focused) |
| `Cmd/Ctrl+Alt+A` | Add selection to chat |
| `Cmd/Ctrl+Alt+E` | Explain selection |

Tool activity rows are clickable — expand any of them to see the actual output (command output with exit code, file reads, search results).

## Commands

Everything below is available from the Command Palette (`Cmd/Ctrl+Shift+P`); the selection, file, terminal, and SCM actions also appear in their context menus.

| Command | What it does |
| --- | --- |
| `Dev-First: Open Chat` | Focus the Dev-First panel |
| `Dev-First: New Session` | Open a new session tab |
| `Dev-First: Set API Key` | Connect a provider (same flow as the panel) |
| `Dev-First: Select Model` | Pick a model from the fetched list |
| `Dev-First: Accept Change` / `Reject Change` | Accept or reject one pending file change |
| `Dev-First: Accept All Changes` / `Reject All Changes` | Bulk accept or reject pending changes |
| `Dev-First: Build Semantic Index` | Pre-build the local semantic index |
| `Dev-First: Clear Semantic Index` | Delete the semantic index |
| `Dev-First: New Session in Worktree` | Create a worktree + `dev-first/<name>` branch and open it in a new window |
| `Dev-First: Merge Worktree` | Merge a worktree branch back |
| `Dev-First: Remove Worktree` | Delete a worktree |
| `Dev-First: MCP Servers Status` | Show connected MCP servers |
| `Dev-First: Set Up MCP Servers` | Add the recommended MCP servers |
| `Dev-First: Add MCP Server` | Add a custom MCP server |
| `Dev-First: Explain Selection` | Explain the selected code |
| `Dev-First: Fix Selection` | Fix the selected code |
| `Dev-First: Fix Diagnostics` | Fix diagnostics in the selection |
| `Dev-First: Improve Selection` | Suggest improvements for the selection |
| `Dev-First: Add Selection to Chat` | Attach the selection to your message |
| `Dev-First: Add File to Chat` | Attach a file to your message |
| `Dev-First: Add Terminal Output to Chat` | Attach terminal output to your message |
| `Dev-First: Generate Terminal Command` | Turn a plain-English description into a command |
| `Dev-First: Explain Terminal Command` | Explain the current terminal command |
| `Dev-First: Fix Terminal Command` | Fix the current terminal command |
| `Dev-First: Generate Commit Message` | Write an SCM commit message |
| `Dev-First: Export Transcript` | Export the session transcript |
| `Dev-First: Explain This Codebase` | Produce a codebase overview |
| `Dev-First: Open Architecture` / `Refresh Architecture` | Open or rebuild the architecture map |
| `Dev-First: Scan File` | Run the on-demand AI review for the active file |

## Planning and approval

- **Approval standard.** A plan is both an execution specification and a grounded explanation. It names the affected subsystem, cites files it actually read (with roles and source lines), and uses the sections that matter: `WHAT`, `HOW` (optional flow diagram and code snippet), `WHY`, `CONTEXT`, `TRADEOFF` (what the alternative does better and what it costs), and ordered steps.
- **Expected files.** Every plan lists the files execution expects to **modify**, **add**, or **delete**, each with a short reason — separate from the files that were only read as context.
- **Refine or cancel.** Ask follow-up questions to change the plan, edit the plan text directly, or uncheck steps to skip them. Cancel/discard leaves the workspace untouched and drops the draft.
- **Plan files.** Approved plans are written to `.dev-first/plans/` as markdown you can open, diff, or keep.
- **Read-only planning.** The planner can read, search, inspect symbols, and run allowlisted read-only terminal checks — nothing more. Write and edit tools are only registered during execution.

## Compound tools

Compound tools bundle the edit, verification, and error handling that used to take several round trips. The executor prefers them; raw edit tools (`write_file`, `edit_file`, `apply_patch`) are still registered as fallbacks and say so in their descriptions: *"Fallback: use only when no compound tool fits."*

| Tool | Purpose |
| --- | --- |
| `apply_change_set` | Coordinated changes across related files, applied atomically with rollback on failure |
| `fix_in_file` | One-file change with checkpoint, exact-match validation, atomic write, and diagnostics |
| `fix_diagnostic` | Clear one diagnostic at a line and check for regressions |
| `rename_symbol` | Definition-and-reference rename (LSP first, textual fallback gated by `allowTextual`) |
| `add_import_and_use` | Add the import, apply the use-site edit, and verify diagnostics |
| `update_related_files` | Apply one patch template or exact instruction across every file that references a symbol |
| `refactor_symbol` | Extract or move a symbol with coordinated edits and verification |
| `inspect_file_context` | Compact file snapshot (content, symbols, imports, diagnostics) in one call; optional scoped repo map |
| `investigate_issue` | Read-only investigation and evidence gathering |
| `verify_change` | Targeted validation after an edit; diagnostics-only during planning, `auto` mode runs the resolved project command in execution |
| `bounded_investigation` | Bounded read-only exploration: whitelisted read-only ops, capped output, no edits, terminal, or tasks |

Compound edits preflight all targets before writing anything (and abort generated/read-only targets unless explicitly allowed), so a failed preflight never leaves a half-applied change set.

## Verification

Verification is deterministic and escalates by risk — no extra model call decides what to run.

| Level | Runs when | Checks |
| --- | --- | --- |
| L0 | No changes | Nothing |
| L1 | Every change | Write, language-server diagnostics, and a diff for edits/deletes |
| L2 | 2–4 files changed, symbols/imports touched, or all changes in one package root | Adds related-file diagnostics, references, closest tests (max 2), and a package-level typecheck |
| L3 | 5+ files, a risk path, multiple package roots, an explicit plan check, or a previous check failed | Adds the resolved project command (typecheck, test, lint, or build) through the normal terminal approval |

- **Risk paths** include auth/session/token code, secrets and `.env` files, database/migrations, API routes/controllers, and build or dependency configuration.
- **Closest tests** are capped at two, found via test-target resolution and adjacent test files.
- **Diagnostics** are cached by content hash, so unchanged files are not re-queried.
- **One repair attempt.** If an adaptive check fails, the agent gets a single repair chance; if it fails again, verification stops with the reason instead of looping.
- **Project command resolver.** Lockfiles pick the package manager (npm, pnpm, yarn, bun); cargo, go, and Python projects are detected too (pytest, pyright, mypy, ruff). Configure commands per kind with `devFirst.typecheckCommand`, `devFirst.testCommand`, `devFirst.lintCommand`, and `devFirst.buildCommand` — explicit settings always win over auto-detection. When detection is ambiguous, verification reports `needs_input` instead of guessing.
- **Toggle.** `devFirst.adaptiveVerify` (default on) controls automatic escalation after edits.

## Interruption recovery

If VS Code or the extension stops mid-run, Dev-First can resume safely without replaying anything blindly.

- **Run journal.** Runs are saved to `globalStorage/runs` at every boundary (run approved, tool call, step, approvals, stop/fail/complete) with atomic writes, a `.bak` copy, and retention of 20 runs / 7 days. Active runs are never pruned.
- **Recovery card.** On restart you get **Resume / Roll back / Discard**. Resume re-validates started operations and refuses when the workspace state is uncertain; Roll back restores snapshots (or the run checkpoint); Discard removes the journal and snapshots. **Nothing runs automatically.**
- **Queued messages** are restored with their statuses; they stay put until you send them.
- **Terminal approvals** come back as Approve/Deny with the command re-validated against the current workspace.
- **Questions** are restored with their original options, custom-answer field, and batch layout; your answer is injected into the run without asking again.
- **Partial streamed answers** are marked interrupted; you can Continue or Discard them.
- **File snapshots.** Every edit captures a crash-safe snapshot — git refs when the workspace is a repo, plus a non-git fallback store (2 MB per file, 200 files per run). Writes are atomic and preserve symlinks and file modes.
- **Restore conflicts.** Files changed by hand since a run are detected by hash; a rollback reports them and asks for an explicit **Restore anyway** instead of overwriting.
- **Finish gate.** Before declaring a run complete, local checks compare plan steps, todos, expected files, tool failures, new diagnostics, and required verification. A failed gate gets one compact correction, then one bounded continuation, then the run is marked incomplete.
- **Loop detection.** Canonical tool signatures plus a touched-file progress fingerprint catch repetition. No-progress runs warn at 2 and stop at 4; exact repeats warn at 3 and stop at 5. Polling tools are excluded and keep a separate budget.

## Context management

Dev-First adapts compaction to the model's context window instead of using one global threshold.

| Tier | Model window | Compact trigger | Prune threshold | Preserve | Reserve |
| --- | --- | --- | --- | --- | --- |
| `compact` | ≤ 32k | 45% | 35% | 8,000 tokens | 20% |
| `standard` | ≤ 200k | 60% | 50% | 20,000 tokens | 15% |
| `large` | > 200k | 62% | 50% | 24,000 tokens | 12% |

- **Profile.** `devFirst.contextProfile` is `auto` by default and derives the tier from the model; set `compact`, `standard`, or `large` to override. The context tooltip shows `tier · trigger · preserve · reserve`.
- **Reasoning reserve.** Reasoning models add up to 5% reserve, capped at 30% total, so thinking output never crowds out the conversation.
- **Recent floor.** At least the last 6 messages and 2 tool results are always kept, regardless of pressure.
- **Compaction and prune.** At the trigger, older turns are summarized; deterministic pruning drops stale tool outputs (keeping the newest 10, protected tools, and de-duplicating) down to the prune threshold. The `compress_context` tool lets the agent fold resolved earlier work on demand.
- **Full history, rotated.** Sessions keep full history: once a session file passes ~5 MB, older messages rotate to `session.archive.<id>.json` files, with a `<id>.context.json` metadata sidecar.
- **Pinned context.** The latest message, active plan, pending decisions, changed files, and diagnostics are always pinned, so compaction cannot lose what the run needs.
- **Relevance retrieval.** Archived history is retrieved with anchor-based, tiered ranking inside the profile's budget, with ambiguity summaries and a context header so the model knows what was retrieved and why.
- **Exact accounting.** The context bar reports exact usage against the model's window — no estimation.

## Reasoning, memory, and processes

- **Reasoning**: choose from the effort levels advertised by the selected model in the composer. Values are saved per provider/model; the "Thinking…" row streams live and collapses when done.
- **Memory**: the agent can save durable facts (`memory_save`) and recall them later (`memory_recall`); memory is injected into every prompt. Disable with `devFirst.memory`. Stored per workspace in global storage.
- **Background processes**: the agent can start long-running processes with `background_process` (readiness by output pattern or port), then read logs and stop them — instead of blocking on `npm run dev`.
- **Review**: type `/review` (optionally `/review branch main`) for a read-only code review, or click **Diff view** in the review bar to open VS Code's multi-file diff.

## Autocomplete (optional)

Set `devFirst.autocomplete` to `true` to enable inline ghost-text completions.

- **Model** — `devFirst.autocompleteModel` left empty means *auto*: a FIM model is chosen where a provider default exists (Codestral for OpenRouter); otherwise the connected chat model is used. Set it explicitly to override.
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
| `.dev-first/plans/*.md` | Saved plans for the current workspace |
| `~/.dev-first/AGENTS.md`, `~/.dev-first/skills`, `~/.dev-first/mcp.json` | Global equivalents |

## Scanner

The scanner is **on demand**: run **Dev-First: Scan File** from the editor title bar (eye icon) or the Command Palette. It combines local candidate signals with an AI review, adjudicates findings across files (including near-duplicate pairs), and caches verdicts so repeat scans stay fast. Findings appear as squiggles with category, severity, confidence, and a hover explanation — change the file and stale findings clear.

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.scanAiModel` | `""` | Model for the AI scan; empty uses the main chat model |
| `devFirst.scanIgnore` | built-in globs | Comma-separated globs to skip (`node_modules`, `dist`, lockfiles, …) |
| `devFirst.scanMaxFiles` | `2000` | Stop indexing after this many files |

## Web and documentation lookup

`web_fetch` retrieves documentation, changelogs, and issue pages with markdown negotiation (`Accept: text/markdown` preferred), retries and backoff on `429`/`5xx`, a Cloudflare mitigation retry, and a 24-hour cache. `discover_docs: true` adds one bounded probe for the host's `llms.txt`. `web_search` uses DuckDuckGo (free, no key) with a 1-hour cache. Fetched package-registry pages (npm, PyPI, crates.io) work through the same pipeline, `<pre><code>` blocks come back as fenced code, and web content is always marked untrusted with citation rules so the model treats it as reference data, never instructions.

## Settings

Open the **gear icon** for the in-panel settings view: **Provider** (connection + task models), **Behavior** (safety, behavior, accuracy, verification, context, input), **Display** (chat, notifications), and **About**. Changes apply instantly with a brief "Saved" confirmation. The same keys are available in VS Code settings (linked from About), along with a few advanced keys that predate the panel and are intentionally not shown there (execution step limits, terminal timeout, low-level provider adapter, embeddings model, browser port, legacy reasoning effort).

### Provider

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.preset` | `openai` | Provider preset: `openai`, `anthropic`, `gemini`, `openrouter`, `groq`, `deepseek`, `ollama`, `lmstudio`, `custom` (normally set from the panel) |
| `devFirst.model` | `gpt-4o` | Model id used for chat, planning, and execution |
| `devFirst.baseUrl` | provider default | Custom API base URL (e.g. OpenRouter, Ollama) |
| `devFirst.scanPreset` | `""` | Provider for scanner operations; empty inherits the main connection |
| `devFirst.scanModel` | `""` | Model for scanner operations; empty uses the scanner connection model |
| `devFirst.scanReasoningEffort` | `""` | Reasoning effort for the scanner model; empty inherits the main setting |
| `devFirst.architecturePreset` | `""` | Provider for architecture mapping; empty inherits the main connection |
| `devFirst.architectureModel` | `""` | Model for architecture mapping; empty uses the architecture connection model |
| `devFirst.architectureReasoningEffort` | `""` | Reasoning effort for the architecture model; empty inherits the main setting |

### Safety, behavior, and accuracy

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.sandbox` | `workspace-write` | OS sandbox for terminal writes (`off` or `workspace-write`); the approval card can bypass it once per command |
| `devFirst.autoApproveTerminal` | `false` | Skip the Allow/Deny card for terminal commands |
| `devFirst.autoApproveEdits` | `true` | Apply `write_file`, `edit_file`, and `apply_patch` without asking |
| `devFirst.autoApproveMcp` | `true` | Run MCP tool calls without asking |
| `devFirst.safeCommandsOnly` | `true` | With terminal auto-approve on, only read-only commands run automatically |
| `devFirst.yolo` | `false` | Auto-approve everything: edits, all commands, and MCP tools |
| `devFirst.headerTimeout` | `120` | Seconds to wait for model response headers; `0` disables |
| `devFirst.streamIdleTimeout` | `120` | Seconds between streaming chunks before aborting; `0` disables |
| `devFirst.checkDiagnostics` | `true` | Feed language-server diagnostics for touched files back after edits |
| `devFirst.parallelTools` | `true` | Run independent read-only tool calls in parallel |
| `devFirst.memory` | `true` | Save and recall durable project facts across sessions |
| `devFirst.semanticIndex` | `true` | Enable `semantic_search` with the bundled local embedding model |
| `devFirst.embeddingsProvider` | `local` | `local` = bundled MiniLM (offline) · `api` = provider embeddings |

### Verification

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.adaptiveVerify` | `true` | Escalate verification automatically after edits: diagnostics, related files, closest tests, then the project typecheck or test command |
| `devFirst.typecheckCommand` | `""` | Typecheck command for `verify_change`; empty auto-detects |
| `devFirst.testCommand` | `""` | Test command for `verify_change`; empty auto-detects |
| `devFirst.lintCommand` | `""` | Lint command for `verify_change`; empty auto-detects |
| `devFirst.buildCommand` | `""` | Build command for `verify_change`; empty auto-detects |

### Context and input

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.autoCompact` | `true` | Summarize the conversation when it approaches the context limit |
| `devFirst.contextLimitTokens` | `128000` | Fallback context window used only when the model is not in the model catalog |
| `devFirst.contextProfile` | `auto` | `auto` derives the tier from the model window, or force `compact`, `standard`, `large` |
| `devFirst.pasteFileLines` | `120` | Pasted text longer than this many lines is saved under `.dev-first/pastes` instead of filling the prompt |

### Autocomplete

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.autocomplete` | `false` | Enable inline ghost-text completions |
| `devFirst.autocompleteModel` | `""` | FIM model id; empty means auto per provider |
| `devFirst.autocompleteFallback` | `true` | Ask the connected chat model when no FIM model applies (throttled) |

### Scanning and attention

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.scanMaxFiles` | `2000` | Stop scanner indexing after this many files |
| `devFirst.scanIgnore` | built-in globs | Comma-separated globs to skip when scanning |
| `devFirst.scanAiModel` | `""` | Model for the AI scan; empty uses the main chat model |
| `devFirst.keepAwake` | `false` | Prevent sleep while a plan is running (macOS `caffeinate`) |

### Display and notifications

| Setting | Default | Description |
| --- | --- | --- |
| `devFirst.resources` | `true` | Show the Learn more button on plans and walkthroughs |
| `devFirst.mcpDisplay` | `markdown` | MCP tool output rendering: `markdown` or `plain` |
| `devFirst.architecture` | `true` | Show the Architecture button for codebase mapping |
| `devFirst.soundOnFinish` | `false` | Play a short tone when a run completes |
| `devFirst.notifyOnFinish` | `false` | VS Code notification when a task finishes (any result) |
| `devFirst.notifyOnComplete` | `true` | VS Code notification when a run finishes successfully |
| `devFirst.notifyOnError` | `true` | VS Code error notification when a run fails |
| `devFirst.notifySound` | `chime` | Notification sound: `off`, `chime`, or `beep` |
| `devFirst.notifyOnInput` | `true` | Notify when a plan awaits approval, a command needs Allow/Deny, or the agent asked a question |

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
