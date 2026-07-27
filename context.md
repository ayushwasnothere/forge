# Forge Continuation Context

## Project goal

Forge is a modular, terminal-first AI coding agent inspired by OpenCode and Claude Code. Its goal is an autonomous coding agent that understands one repository, inspects and edits files, runs commands, inspects Git state, and iterates using an LLM with parallel tool calling.

## Technology choices

- TypeScript, Bun workspaces, strict TypeScript settings (`exactOptionalPropertyTypes: true`).
- Commander for the CLI, Zod v4 for tool-input validation, Biome for linting and formatting, and Vitest for tests.
- Provider-agnostic model layer: OpenRouter / OpenAI / Grok / Anthropic / Ollama / Groq.
- A modular monolith: workspace packages share contracts but run locally in the CLI.

## Current architecture

```text
CLI (apps/cli)
  -> CodingAgent (packages/agent)
     -> Provider factory (packages/models)
        -> OpenAICompatibleProvider | AnthropicProvider | OllamaProvider
     -> ToolRegistry (packages/tools)
        -> filesystem / shell / Git / symbol / patch tools
  -> SessionStore (packages/session)  — .forge/sessions/<uuid>.json
  -> MemoryStore (packages/memory)    — .forge/memory.json
  -> AgentRuntime (packages/runtime)  — health checks, event bus, sandbox
  -> RepositoryContextBuilder (packages/context) — git metadata, tree, scripts, FORGE.md
  -> TUI (apps/cli/src/tui.ts) — ANSI markdown renderer, progress indicators
```

The runtime owns repository path and permissions. The model proposes tool calls; it never directly accesses the filesystem or shell.

## Implemented packages

| Package | Description |
|---|---|
| `apps/cli` | `forge` CLI: default command launches interactive REPL chat. Also has `agent`, `chat`, `setup`, `init`, `inspect`, `replace`, `sessions`, `session`, `health` subcommands. Interactive REPL powered by `@clack/prompts` and `picocolors` with `/help`, `/new`, `/resume`, `/model`, `/models`, `/provider`, `/setup`, `/status`, `/compact`, `/cost`, `/history`, `/diff`, `/commit`, `/undo`, `/reset`, `/exit`. Supports non-interactive mode (`-p` / `--non-interactive`) and continue flag (`-c` / `--continue`). |
| `packages/types` | Shared tool, model, session, task, permission, and sandbox contracts. |
| `packages/events` | Small in-memory pub/sub event bus. |
| `packages/runtime` | AgentRuntime (health checks, event bus), DockerSandboxRunner (Docker isolation with host fallback), test command auto-detection. |
| `packages/tools` | ToolRegistry with try/catch safety net, Zod input validation, path confinement, `read_file`, `list_directory`, `find_files`, `list_symbols` (TypeScript AST + regex fallback), `replace_text`, `apply_patch`, `write_file`, `run_command`, `search_code` (ripgrep + pure-JS fallback), `git_status`, `git_diff`, `git_log`, `git_blame`, `git_commit`, `remember_fact`, `recall_facts`, `forget_fact`, `formatToolResult`. |
| `packages/models` | Provider factory + OpenAI-compatible, Anthropic (with prompt caching), and Ollama adapters with token-usage extraction and streaming (SSE) support. |
| `packages/agent` | Iterative parallel tool-calling agent loop, `pruneHistory` (deduplicates `read_file` results, truncates old `run_command` outputs), `compressHistory` (summarises oldest turns when estimated context > 60k tokens, includes toolCalls in token estimation), configurable step limit, premature-stop detection, verification loop. |
| `packages/session` | JSON session snapshots in `.forge/sessions/`. `save`, `load` (with runtime shape validation), `list` (resilient via `Promise.allSettled`), `appendEvent`, `getEvents`. |
| `packages/memory` | Persistent JSON memory storage (`.forge/memory.json`) for agent learning across runs. Runtime validation on load. |
| `packages/context` | Repository tree, README, package scripts, config files, and **FORGE.md / CLAUDE.md** guidelines injection into context. |

## Available tools

| Tool | Permission | Notes |
|---|---|---|
| `read_file` | read | Reads UTF-8 files under the active repository. Supports `startLine`/`endLine`. |
| `list_directory` | read | Lists a repository directory. |
| `find_files` | read | Finds files by glob pattern (Bun.Glob with pure-JS fallback). |
| `list_symbols` | read | Outlines functions, classes, types via TypeScript AST (JS/TS) or regex (Python/Rust/Go). |
| `replace_text` | write | Replaces exactly one matching text segment. Uses `hasPermission()` helper. |
| `apply_patch` | write | Applies a unified diff (pure-JS implementation, context-verified ±5 line fuzzy window). |
| `write_file` | write | Creates or fully overwrites a file. |
| `run_command` | execute | Runs a shell command with configurable timeout and optional Docker sandbox. |
| `search_code` | read | Searches using ripgrep (with pure-JS fallback if rg is not in PATH). |
| `remember_fact` | write | Persists a key-value learning/instruction in long-term memory. |
| `recall_facts` | read | Recalls all current facts/settings from long-term memory. |
| `forget_fact` | write | Deletes a stored fact by key from long-term memory. |
| `git_status` | read | Concise branch and working-tree status. |
| `git_diff` | read | Unstaged or staged changes. |
| `git_log` | read | Recent commits. |
| `git_blame` | read | Line-by-line authorship. |
| `git_commit` | write | Stages explicit paths and creates a commit. |

All tools are limited to the active repository path. `write` and `execute` tools deny access unless the caller grants the corresponding permission. `ToolRegistry.execute()` wraps every tool call in try/catch to prevent individual tool errors from crashing the agent loop.

## Configuration

`.env` is ignored by Git and currently contains placeholders:

```dotenv
FORGE_BASE_URL=https://openrouter.ai/api/v1
FORGE_PROVIDER=openrouter
FORGE_API_KEY=replace_with_your_openrouter_api_key
FORGE_MODEL=anthropic/claude-sonnet-4
```

Replace `FORGE_API_KEY` with a valid OpenRouter key. Change `FORGE_MODEL` to any OpenRouter model that supports tool/function calling.

### Provider selection

Set `FORGE_PROVIDER` in `.env` or pass `--provider` to the agent command. You can also switch live in the REPL with `/provider` and `/model`.

| Provider | Provider value | API key | Default endpoint |
|---|---|---|---|
| OpenRouter | `openrouter` | Required | `https://openrouter.ai/api/v1` |
| OpenAI | `openai` | Required | `https://api.openai.com/v1` |
| xAI Grok | `grok` | Required | `https://api.x.ai/v1` |
| Anthropic | `anthropic` | Required | `https://api.anthropic.com/v1` |
| Ollama | `ollama` | Not required | `http://localhost:11434/v1` |

### Anthropic prompt caching

When using the Anthropic provider, Forge automatically enables prompt caching via the `anthropic-beta: prompt-caching-2024-07-31` header. The system prompt, tools definition, and the most recent message are tagged with `cache_control: { type: "ephemeral" }` for up to 90% cost reduction on cache hits.

### Dynamic tool loading (`forge.config.json`)

Place a `forge.config.json` in the repository root to load extra tools at startup:

```json
{
  "tools": ["./tools/my-custom-tool.ts"]
}
```

Each module must export either `default` or `tool` as a `RegisteredTool` with a `name` string and `execute` function.

### Project guidelines (`FORGE.md`)

Place a `FORGE.md` (or `CLAUDE.md` as fallback) in the repository root. Its contents are automatically loaded and injected into the system prompt as a `## Project Guidelines` section. Use this to specify coding conventions, preferred libraries, test commands, and project-specific rules.

## Commands

```powershell
# Install dependencies
bun install

# Verify formatting, type checking, and tests
bun run check

# Inspect a file or directory
bun run start -- inspect README.md
bun run start -- inspect packages

# Check local runtime configuration and repository status
bun run start -- health

# Exact manual replacement; requires explicit write permission
bun run start -- replace README.md "old text" "new text" --allow-write

# Launch interactive chat REPL (default command)
bun run start

# With full permissions
bun run start -- --allow-write --allow-execute

# Run the coding agent (one-shot)
bun run start -- agent "Explain this repository"

# Use a different provider for one run
bun run start -- agent "Explain this repository" --provider ollama

# Permit changes and shell commands for this run
bun run start -- agent "Add a health check and run tests" --allow-write --allow-execute

# Resume a saved session
bun run start -- agent "Continue" --session <id>

# Start an interactive REPL chat session (explicit subcommand)
bun run start -- chat --allow-write --allow-execute

# Limit command execution to 30 seconds (default: 60)
bun run start -- agent "Run the test suite" --allow-execute --command-timeout 30

# Inspect locally saved task handoffs
bun run start -- sessions
bun run start -- session <id>
```

### Interactive REPL (`chat`) slash commands

| Command | Description |
|---|---|
| `/help` | Show all available commands |
| `/new` | Start a fresh session with a new session ID |
| `/resume [id]` | Without id: list saved sessions. With id: restore history from that session |
| `/provider [name] [model]` | Without args: show current provider+model. With args: switch live |
| `/model [name]` | Without args: show current model. With args: switch model for current provider |
| `/status` | Show session ID, provider, model, message count, git branch, memory facts, session cost & token usage |
| `/compact` | Manually compress older history to free up context window space |
| `/cost` | Display cumulative token usage and estimated API cost for the current session |
| `/history` | Show a formatted summary of messages in the current session |
| `/diff` | View current unstaged repository changes |
| `/commit` | Auto-generate a conventional commit message via the model and commit all changes |
| `/undo` | Revert the workspace and chat history to the state before the last agent run (uses git stash checkpoints) |
| `/reset` | Clear the current session's message history |
| `/exit`, `/quit` | Exit the REPL |

## Verification status

Latest `bun run check` completed successfully:

- **Lint**: Biome — 0 errors.
- **Types**: `tsc --noEmit` — 0 errors (strict mode, `exactOptionalPropertyTypes: true`).
- **Tests**: 66 tests across 8 suites (events, models, session, runtime, context, agent, tools, memory) — all passing.
- **Version**: Read dynamically from `apps/cli/package.json` via `getVersion()` — no more hardcoded version strings.

## Known limitations and design decisions

- **Parallel tool execution**: The agent can issue multiple tool calls in one step; they run concurrently via `Promise.all`. The system prompt instructs the model to batch independent reads.
- **Context compaction**: Two-stage: `pruneHistory` (dedup read_file, truncate old run_command outputs) runs every step; `compressHistory` (summarises oldest assistant→tool groups) kicks in when estimated context > 60k tokens. Token estimation includes `toolCalls` serialization for accuracy. Compression uses `role: "user"` with `[CONTEXT COMPACTED]` prefix to avoid invalid mid-conversation system messages.
- **Docker sandbox**: `DockerSandboxRunner` mounts the repository into a container. Falls back to host execution if Docker is unavailable, logging a warning.
- **GUI / blocking commands**: Must be launched in the background (`start` on Windows, `&` on Unix) to avoid command timeout. The system prompt includes this rule.
- **Shell execution**: Host command execution on Windows uses `powershell.exe` (with `-NoProfile`, `-NonInteractive`, and `-ExecutionPolicy Bypass`). On Unix/macOS/Linux, it uses `sh -lc`. The active shell details and syntax rules (like avoiding `&&` on Windows) are dynamically injected into the system prompt's **Shell Environment** section to prevent syntax errors.
- **Single-step architecture (Claude Code style)**: No separate planning phase. The model is instructed in its system prompt to reason and plan inline before executing tools. This matches the design of Claude Code and OpenCode.
- **Anti-redundancy rules in system prompt**: The system prompt explicitly tells the model: (1) write tools already return a preview confirming success — do NOT read a file back after writing it, (2) do NOT run ad-hoc verification commands (Test-Path, cat, Get-Content), (3) don't re-read files already in context history. These rules dramatically reduce unnecessary steps and token usage.
- **Premature stop & step limit detection**: The agent detects when a model stops without taking action on Step 0, or emits deferred reasoning without outputting tool calls (matching contractions like "I'll", progressive verbs like "updating", "rewriting"). In these cases, it pushes back with a nudge to continue. The default max step limit per prompt is 60. When this limit is reached, the CLI prompts the user interactively (`Continue? (y/N)`) to either extend execution by another 60 steps or exit.
- **Loop Prevention & Progress Detector Safeguards**:
  - **Duplicate tool call blocking**: If the exact same tool call (same tool, same arguments) is executed more than 3 times without any successful file edits in between, the agent intercepts the call and fails it gracefully with a loop warning to force the model to proceed.
  - **Progress limit termination**: If the agent executes 12 consecutive tool calls without any successful file edits, it aborts the execution run with a loop detection error to prevent token waste.
- **Path Sanitization & Normalization**:
  - **Automatic workspace prefix stripping**: In `resolveRepositoryPath`, if the model prepends the repository directory name (e.g. `sandbox/index.html` when repository root is `sandbox`), the prefix is automatically stripped if no nested folder with that name exists, preventing duplicate nested paths.
  - **Repository-relative path formatting**: The `formatToolResult` helper prints all paths relative to the repository root for LLM consumption, preventing path-doubling confusion.
- **`apply_patch`**: Pure-JS unified diff parser — no system `patch` binary needed. Context lines are verified against the file before applying each hunk (±5 line fuzzy window); hunks that fail context verification are rejected rather than applied blindly.
- **Workspace auto-creation**: Both `agent` and `chat` commands auto-create the workspace directory with `mkdir({ recursive: true })` if it doesn't exist.
- **Session save on `/new`**: Generates a fresh UUID so new sessions do not overwrite old ones.
- **Path error messages**: When a tool rejects an out-of-repo path, the error message includes the repository root and the rejected absolute path for model self-correction.
- **AST symbol extraction**: Uses TypeScript Compiler API for `.ts/.tsx/.js/.jsx`. Falls back to regex for Python, Rust, Go.
- **Streaming output & Markdown rendering**: All three providers (OpenAI-compatible, Anthropic, Ollama) support token-by-token streaming via `onToken` callbacks. The CLI displays content live during streaming and erases the raw text upon completion to output a fully rendered ANSI Markdown document for rich terminal UX. **All inline Markdown (bold, italic, `code`, links) uses callback-form regex replacements so picocolors ANSI wrapping correctly applies to captured groups.**
- **Anthropic Prefix Caching**: The Anthropic provider uses a monotonically growing cache strategy by marking both the penultimate (second-to-last) and last messages with `cache_control: { type: "ephemeral" }`. Content blocks are cloned before annotation to avoid mutating shared message objects in session history.
- **Multi-turn chat (REPL)**: The `chat` command passes `history: agent.messages, continueChat: true` to `agent.run()` each turn. The `continueChat` flag makes the agent append the new user message directly (without a "Continuing the task" prefix), preserving correct multi-turn conversation structure. The `--session` resume path (one-shot `agent` command) still uses the continuation prefix.
- **Self-Verifying Edits**: The `replace_text` and `write_file` tools return a text snippet preview (±3 lines of context or first 20 lines) in their success results. This gives the model immediate visual confirmation of its edits, eliminating the need for redundant `read_file` calls just to verify changes.
- **Diff approval UI**: File-writing tools (`write_file`, `replace_text`, `apply_patch`) invoke an `onApproveFileChange` callback before mutating files. In interactive mode (when `--allow-write` is not set), the user sees a color-coded visual diff and must approve each change.
- **No-test-setup guard (vs over-engineering)**: `detectTestCommand` returns `null` (not a fallback `"bun run test"`) when no test setup is detected in the workspace. The context builder only injects a `## Test Command` section when one is actually found, and the system prompt instructs the model not to invent tests if none are present. The agent's post-edit verify loop also skips test execution when `verifyCommand` is null. This prevents the agent from hallucinating a full Bun/Node project structure and unit-test suite when asked to do a simple task like "create an HTML file".
- **Tool error isolation**: `ToolRegistry.execute()` wraps every `tool.execute()` call in a try/catch. If a tool throws (e.g., ENOENT from a non-existent cwd), the error is converted to a graceful failure result instead of crashing the agent loop.
- **`/commit` command**: Uses `git diff HEAD` to capture all changes, sends the diff to the model to generate a conventional commit message, prompts for user approval, then runs `git add -A && git commit -m "<message>"`.
- **`/undo` command**: Before each agent run, a git stash checkpoint is created via `git stash create`. On `/undo`, the workspace is hard-reset and the stash is reapplied. Chat history is also sliced back to the state before the last prompt.
- **Anthropic prompt caching**: The Anthropic provider sends the `anthropic-beta: prompt-caching-2024-07-31` header and tags the system prompt, tools, and last message with `cache_control: { type: "ephemeral" }`.

## Implementation roadmap (ordered by priority)

### Medium priority (feature depth)

1. **Google Gemini provider** — [COMPLETED ✅] Added `gemini` provider supporting Google's OpenAI-compatible REST endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`), with full support for `thought_signature` and `extra_content` for Gemini 2.5/3.5/Gemma models.

2. **Custom Providers** — [COMPLETED ✅] Added `type: "openai" | "anthropic"` support in `~/.forge/config.json` and interactive wizard for configuring self-hosted proxies, LiteLLM, AgentRouter, Azure OpenAI, enterprise Anthropic proxies, and LM Studio.

3. **Workspace Directory Switching** — [COMPLETED ✅] Added `/usedir` and `/cd` slash commands to dynamically change active workspace directory live inside a session.

4. **MCP (Model Context Protocol) tool server** — Expose the `ToolRegistry` as an MCP server so external editors (VS Code, Neovim) and other clients can connect and use Forge's tools. Both OpenCode and Claude Code support MCP.

5. **Multi-agent orchestration** — A coordinator agent breaks complex tasks into sub-tasks and spawns worker agents that execute in parallel, collecting results. OpenCode has a "General Subagent" for this.

### Low priority (nice to have)

4. **Rich TUI (Bubble Tea / Ink)** — Replace the basic readline REPL with a full terminal UI framework (e.g., Bubble Tea or Ink). OpenCode has a polished Bubble Tea TUI. This is low priority because the current readline REPL is functional and reliable.

5. **Lifecycle hooks** — User-defined shell commands or HTTP endpoints that execute automatically at specific lifecycle events (e.g., `PreToolUse`, `PostToolUse`, `SessionStart`). Claude Code has this.

6. **Fine-grained allow/deny rules** — Regex-based patterns for allowing or denying specific commands and file paths, instead of the current blanket `--allow-write` / `--allow-execute` flags. Claude Code has this.

7. **LSP integration** — Automatically start a Language Server for the detected language to provide IDE-like diagnostics. OpenCode has this.

8. **`--watch` mode for `agent`** — Re-run the last task automatically when files in the repository change (uses `fs.watch`).

9. **AWS Bedrock / Google Vertex AI providers** — Additional cloud provider adapters. Claude Code supports Bedrock and Vertex.

## Working conventions

- Keep packages decoupled; expose shared contracts through `@forge/types`.
- Add tools through `ToolRegistry`; the agent never calls filesystem, Git, or shell APIs directly.
- Require explicit permission for mutating or command-execution tools.
- Run `bun run check` after each feature and before handing off.
- Keep `context.md` updated whenever architecture, implementation state, commands, limitations, or next steps change.
