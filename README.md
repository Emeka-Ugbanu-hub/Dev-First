# Dev-First

![Dev-First — Developer first. Build with confidence.](media/banner.png)

> **An open-source VS Code coding harness that keeps developers in control while AI helps them understand, plan, and build.**

Dev-First is built around a simple belief: AI should help developers understand their codebase more deeply while keeping them in charge of the work. You should be able to move from the architecture of a system to the files and symbols that implement it, see what the model is doing, understand why it chose a direction, and decide what changes are worth making.

It is also made for practical everyday use with small local models. Focused context, visible stages, plans, checkpoints, verification, and recovery controls help local models do useful work while the developer remains the decision-maker.

## The Dev-First workflow

1. **Ask.** Ask a question, explain code, investigate a problem, or describe a change.
2. **Understand.** Dev-First brings in relevant files, selections, diagnostics, project memory, and conversation context.
3. **Plan when work needs a plan.** The model states the scope, files, steps, assumptions, alternatives, trade-offs, and verification. Questions and explanations can be answered directly with the evidence they need.
4. **Refine.** Ask why, change the scope, correct an assumption, or request a different approach. Nothing is locked in until you approve it.
5. **Build.** After approval, the agent edits files, runs commands, uses tools, and checks its work while showing the current stage and activity.
6. **Review.** Every change is presented as a real before-and-after diff. Review a file, accept it, reject it, or accept/reject the whole run. The result is not marked complete until verification finishes.

The developer directs the work throughout: the agent can inspect, explain, suggest refactors, describe trade-offs, and execute approved changes, while the developer can pause, steer, approve, deny, keep, or undo. The point is to learn how the codebase works while using AI to move through it faster.

## Understand the codebase before changing it

### Architecture mapping

The Architecture view gives the project a visual map of its domains, subsystems, components, and relationships. It helps answer questions such as “where does this request start?”, “which part owns this behavior?”, and “what could this change affect?”

You can generate, refresh, and open the map from the Dev-First view. The map records coverage and can show when the underlying project has changed, so it remains a guide to the current codebase rather than an old snapshot. Use a dedicated architecture provider and model when a separate model is better suited to system-level understanding.

### Scanner

The Scanner examines files and project structure for bugs, security concerns, maintainability risks, duplicated logic, suspicious patterns, and cross-file problems. Findings include a relevant location and explanation so you can investigate them instead of receiving an unexplained score.

Run it on an open file or use it as part of a wider codebase review. Scanner work can use its own provider, model, and reasoning setting, or inherit the main connection. A fast local model can handle routine scans while another model handles planning or implementation.

### Explanations and learning

Ask Dev-First to explain a selection, file, terminal command, diagnostic, architecture, or the codebase as a whole. When current documentation would help, Learn more can provide relevant, verified resources and alternatives. The goal is not only to finish a task. Dev-First helps the developer build a clearer mental model of the codebase, understand the reasoning behind a change, and choose between practical trade-offs before editing it.

## Change with control

- Plans show intended files, concrete steps, assumptions, dependencies, alternatives, trade-offs, and checks.
- Planning inspects and gathers evidence; implementation and verification handle edits and commands.
- Tool activity, progress stages, diagnostics, and reasoning are visible when the provider exposes them.
- Changes are checkpointed and shown in a side-by-side diff.
- Open any changed file to compare the original and updated versions.
- Accept or reject an individual file, a change, or the complete run.
- Resolve conflicts instead of silently overwriting work.
- Verification can use diagnostics, related files, tests, lint, typecheck, and build commands when the project requires them.
- Interrupted or stuck work can be stopped, recovered, resumed, rolled back, or discarded.

Small, low-risk actions can stay lightweight. Larger or risky work keeps the plan and approval boundary so speed does not remove visibility. When a refactor or design choice has more than one sensible path, Dev-First explains the alternatives and trade-offs so the developer can choose rather than accept an unexplained decision.

## Models that fit your workflow

Use a hosted provider or a local model through Ollama or LM Studio. Connect one model and Dev-First can use it immediately. If you connect several, choose which one handles each role:

- **Main model:** chat, planning, and execution.
- **Scanner model:** code and risk scanning.
- **Architecture model:** architecture mapping and system understanding.
- **Autocomplete model:** inline completions, with chat fallback when supported.

Each role can have its own provider, model, and supported reasoning level, or inherit the main connection. Live model metadata is used when available, with cached information when a provider is temporarily unavailable.

Supported presets include OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, and custom OpenAI-compatible endpoints. Local models can be used without an API key.

## Context, memory, and project knowledge

Dev-First keeps useful project rules, durable memory, session history, plans, decisions, diagnostics, and changed-file context. It selects relevant context instead of blindly sending every old message, while preserving the history needed for recovery and continuity. A local semantic index can help find related code without sending it to a service.

You can add workspace rules, reusable skills, commands, and project notes under `.dev-first/`. These help the agent follow the way you work across sessions while keeping you in control of what is remembered.

## Tools beyond the chat

- Read and search the workspace, symbols, diagnostics, and terminal output.
- Run approved terminal commands and installations with sandbox and approval controls.
- Use browser tools for local web work and current pages when enabled.
- Connect MCP servers for additional tools and services.
- Work in isolated Git worktrees, then review and merge the result.
- Generate commit messages and export transcripts.
- Use autocomplete for inline code suggestions.
- Use web search for current documentation when repository evidence is not enough.

## Setup

1. Install the extension and open the **Dev-First** view in VS Code.
2. Connect a provider in the panel. Hosted providers use their API key; Ollama and LM Studio can run locally without one.
3. Choose the main model, then optionally choose separate Scanner, Architecture, and Autocomplete models in settings.
4. Ask a question or describe the work.

Useful commands include **Open Chat**, **New Session**, **Explain Selection**, **Fix Selection**, **Scan File**, **Open Architecture**, **Refresh Architecture**, **Build Semantic Index**, **Select Model**, and **Export Transcript**.

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
| `devFirst.localContextCapTokens` | `32768` | Optional maximum context for local models; `0` disables the cap and the effective limit never exceeds the model or Modelfile context |
| `devFirst.contextProfile` | `auto` | `auto` derives the tier from the model window, or force `compact`, `standard`, `large` |
| `devFirst.plannerThinking` | `auto` | Planner thinking policy: `auto` skips planner thinking on local models and uses bounded evidence-based effort routing elsewhere, `off` disables it everywhere, and `on` honors the selected effort; explicit run overrides win |
| `devFirst.pasteFileLines` | `120` | Pasted text longer than this many lines is saved under `.dev-first/pastes` instead of filling the prompt |
| `devFirst.warmOnFocus` | `true` | Warm up the local Ollama model when the chat input gains focus, so the first response starts without a cold load |

Planning is graduated per change: the model chooses `skip` for one explicit low-risk operation, `lite` for a small known change, `spec` for a normal change, or `full` for architecture and high-risk work. Skip runs directly; the other modes keep the appropriate plan and approval flow.

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

## Open source and the direction of the project

Dev-First is an evolving open-source harness for a developer-led AI workflow. The aim is to make coding more enjoyable and more understandable: help developers learn their systems from architecture to file-level detail, inspect and refactor code with confidence, see what is happening, and still gain the speed and repeatability that AI can provide.

The workflow will keep being refined around that idea. Feedback, corrections, and contributions are welcome.
