# Changelog

All notable changes to Dev-First are documented here. This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/).

## 0.1.0

Initial release: a plan-first AI coding agent for VS Code where every change request becomes a plan you approve before a line changes.

### Added

#### Planning and execution

- Approval-gated plan workflow: read-only planner exploration, `WHAT` / `HOW` / `WHY` / `CONTEXT` / `TRADEOFF` sections, optional Mermaid flow diagrams and code snippets, ordered steps, and plans saved to `.dev-first/plans/`.
- Grounded plans that name the affected subsystem and cite the files actually read, with an `EXPECTED FILES` section marking each file as modify, add, or delete with a reason.
- Plan refine/cancel routes: continued discussion, direct plan-text editing, unchecked steps to skip, and draft dismissal without touching the workspace.
- Compound executor tools: `apply_change_set`, `fix_in_file`, `fix_diagnostic`, `rename_symbol`, `add_import_and_use`, `update_related_files`, and `refactor_symbol` (extract/move), each with preflight, atomic writes, rollback, and diagnostics.
- Read-only compound tools in planner and executor: `inspect_file_context`, `investigate_issue`, and `verify_change` (diagnostics-only while planning), plus `bounded_investigation` with a whitelisted read-only operation list and output budget.
- Raw edit tools (`write_file`, `edit_file`, `apply_patch`) retained as explicit fallbacks marked "use only when no compound tool fits".
- Scoped repo map returned by `inspect_file_context` with `includeMap`: tiered token budget, assembled cache, coverage/unresolved line, and an orientation-only contract.

#### Verification

- Adaptive L0–L3 verification policy driven by deterministic risk and scope signals: related diagnostics, references, closest tests (max 2), package typecheck, and the resolved project command.
- Risk detection for auth/session/token paths, secrets and `.env` files, database/migrations, API routes/controllers, build and dependency configuration, 5+ changed files, cross-package changes, explicit plan checks, and prior failures.
- Project command resolver for npm/pnpm/yarn/bun (lockfile detection), cargo, go, and Python (pytest, pyright, mypy, ruff), including lint; per-kind `typecheckCommand` / `testCommand` / `lintCommand` / `buildCommand` settings override auto-detection, and ambiguity reports `needs_input`.
- Diagnostics cached by content hash, exactly one bounded repair attempt, and an `adaptiveVerify` toggle (default on).

#### Context management

- Adaptive context profiles by model window tier (compact / standard / large) with profile-specific compact trigger, prune threshold, preserve budget, and reserve ratio; reasoning reserve capped and recent-message floor enforced.
- Automatic compaction plus deterministic pruning of stale tool output (newest 10 kept, protected tools, de-duplication) and the on-demand `compress_context` tool.
- Exact context usage accounting and a context tooltip showing tier, trigger, preserve, and reserve.
- Full-history retention with archive rotation past ~5 MB, a structured metadata sidecar, pinned context (latest message, active plan, pending decisions, changed files, diagnostics), and relevance retrieval with anchors, tiered ranking, profile budgets, ambiguity summaries, and a context header.

#### Interruption recovery

- Durable run journal in global storage with atomic writes, `.bak` fallback, and retention (20 runs / 7 days, active runs protected), saved at every run boundary.
- Recovery card with Resume / Roll back / Discard; nothing runs automatically. Resume re-validates started operations and refuses uncertain workspace states; rollback restores checkpoints or snapshots.
- Recovery for queued messages, terminal approvals (re-validated), questions (original options, custom answers, batch), and partial streamed answers marked interrupted.
- Crash-safe per-edit file snapshots (git refs plus a non-git fallback store, 2 MB / 200 files), atomic writes that preserve symlinks and modes, and restore conflict protection using hash comparison with an explicit "Restore anyway" path.
- Conditional finish gate (plan steps, todos, expected files, tool failures, new diagnostics, required verification) with one compact correction and one bounded continuation before a run is marked incomplete.
- Signature and progress loop detection: canonical tool signatures, touched-file progress fingerprints, no-progress warn/stop thresholds, and polling tools excluded.

#### Scanner

- On-demand AI-adjudicated review via the **Scan File** editor button and `devFirst.scanFile` command, combining local candidate signals, AI review, and cross-file pair judging with cached verdicts.
- Evidence-backed findings with category, severity, confidence, hover explanations, and coverage status across vulnerability, smell, bug, secret, architecture, maintainability, and scalability rules.

#### Research and ecosystem

- Web fetch with markdown negotiation, retry/backoff on 429/5xx, Cloudflare mitigation retry, 24-hour caching, an optional `discover_docs` llms.txt probe, package-registry pages, and fenced code extraction from `<pre><code>`.
- Free DuckDuckGo web search with a 1-hour cache, plus untrusted-web-content and citation prompt rules.
- Multi-provider support (OpenAI-compatible, Anthropic, Gemini) with per-preset keys and task-model overrides for scanner and architecture operations.
- Bundled local semantic search (all-MiniLM-L6-v2) with no API key, optional provider embeddings, and index build/clear commands.
- Skills, slash commands, project rules, memory, background processes, MCP servers, browser automation, git worktrees, SCM commit messages, diff review, checkpoints, notifications, and the architecture map.

### Changed

- Scans are on demand (Scan File) instead of always-on, so large repositories are only reviewed when asked.
- Verification escalates adaptively instead of running a fixed command set after every edit.
- Session history is retained in full and rotated to archive files instead of being truncated at the context limit.
- Interrupted work is recovered from a durable journal and snapshots rather than from a single in-memory run state.
- Scanner and architecture operations can use their own provider and model instead of always inheriting the main connection.

### Removed

- Pre-release scanner heuristics and always-on scan toggles in favor of the on-demand, AI-adjudicated Scan File flow.
- Legacy scan settings that no longer affected behavior were dropped from the extension settings.

### Fixed

- Diff application falls back through exact, fuzzy, drift, and anchor strategies instead of failing on stale context.
- Hand edits during a run are detected and surfaced as explicit choices (re-locate, revert whole file, keep) rather than being guessed at.
- File writes are atomic and mode/symlink safe, and restore operations refuse to overwrite files changed since the run without explicit confirmation.
- Malformed model JSON is repaired and empty model responses are retried.
- Repetitive tool loops and no-progress runs stop with a reason instead of consuming the step budget.
