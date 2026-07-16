# Forge — Usage Guide

Forge is a modular, terminal-first AI coding agent. It understands your repository, reads and edits files, runs shell commands, manages Git, and iterates autonomously using an LLM with parallel tool calling.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CLI Commands](#cli-commands)
  - [forge agent](#forge-agent)
  - [forge chat](#forge-chat)
  - [forge inspect](#forge-inspect)
  - [forge replace](#forge-replace)
  - [forge health](#forge-health)
  - [forge sessions / session](#forge-sessions--session)
- [Interactive REPL (chat)](#interactive-repl-chat)
- [Permissions](#permissions)
- [Streaming Output](#streaming-output)
- [Diff Approval UI](#diff-approval-ui)
- [Session Management](#session-management)
- [Custom Tools](#custom-tools)
- [Docker Sandbox](#docker-sandbox)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Create your .env file in the project root
cp .env.example .env   # or create it manually (see Configuration below)

# 3. Verify everything works
bun run check

# 4. Ask Forge a question (read-only by default)
bun run start -- agent "Explain the architecture of this repository"

# 5. Let Forge make changes
bun run start -- agent "Add input validation to the login handler" --allow-write --allow-execute

# 6. Start an interactive session
bun run start -- chat --allow-write --allow-execute
```

---

## Configuration

Create a `.env` file in your project root:

```dotenv
# Provider: openrouter | openai | grok | anthropic | ollama
FORGE_PROVIDER=openrouter

# API endpoint (optional — each provider has a sensible default)
FORGE_BASE_URL=https://openrouter.ai/api/v1

# Your API key (not needed for ollama)
FORGE_API_KEY=sk-your-api-key-here

# Model to use (must support tool/function calling)
FORGE_MODEL=anthropic/claude-sonnet-4
```

### Supported Providers

| Provider | `FORGE_PROVIDER` | API Key | Default Endpoint |
|---|---|---|---|
| OpenRouter | `openrouter` | Required | `https://openrouter.ai/api/v1` |
| OpenAI | `openai` | Required | `https://api.openai.com/v1` |
| xAI Grok | `grok` | Required | `https://api.x.ai/v1` |
| Anthropic | `anthropic` | Required | `https://api.anthropic.com/v1` |
| Ollama | `ollama` | Not needed | `http://localhost:11434/v1` |

> **Tip:** You can override the provider per-run with `--provider ollama` or switch live inside the REPL with `/provider`.

---

## CLI Commands

All commands are run from the repository root via:

```bash
bun run start -- <command> [options]
```

### `forge agent`

Run the coding agent with a one-shot task.

```bash
bun run start -- agent "<task description>" [options]
```

| Option | Default | Description |
|---|---|---|
| `--allow-write` | off | Allow file creation and modification |
| `--allow-execute` | off | Allow shell command execution |
| `--max-steps <n>` | `20` | Maximum agent reasoning steps |
| `--command-timeout <s>` | `60` | Shell command timeout in seconds |
| `--provider <name>` | env | Override `FORGE_PROVIDER` for this run |
| `--session <id>` | — | Resume a previously saved session |
| `--verbose` | off | Print raw tool output |

**Examples:**

```bash
# Read-only analysis
bun run start -- agent "What does the authentication middleware do?"

# Make changes and run tests
bun run start -- agent "Fix the failing unit tests" --allow-write --allow-execute

# Use Ollama locally
bun run start -- agent "Refactor the utils module" --provider ollama --allow-write

# Resume a previous session
bun run start -- agent "Continue with the refactoring" --session abc123-def456
```

---

### `forge chat`

Start an interactive REPL session. This is the recommended way to work with Forge — you can have a back-and-forth conversation, switch providers, manage sessions, and more.

```bash
bun run start -- chat [options]
```

Options are the same as `forge agent` (except `[task]` — you type prompts interactively).

```bash
# Full-power interactive session
bun run start -- chat --allow-write --allow-execute

# Read-only exploration
bun run start -- chat
```

See [Interactive REPL](#interactive-repl-chat) for all available slash commands.

---

### `forge inspect`

Read a file or list a directory. Useful for quick exploration without invoking the agent.

```bash
# Read a file
bun run start -- inspect src/index.ts

# List a directory
bun run start -- inspect packages

# List symbols (functions, classes, types) in a source file
bun run start -- inspect src/index.ts --symbols
```

---

### `forge replace`

Perform a single exact text replacement in a file.

```bash
bun run start -- replace <file> "<old text>" "<new text>" --allow-write
```

```bash
bun run start -- replace src/config.ts "port: 3000" "port: 8080" --allow-write
```

---

### `forge health`

Check runtime configuration, environment, and repository health.

```bash
bun run start -- health
```

Reports:
- Whether `.env` is configured
- Git repository status
- Docker availability
- Test command detection

---

### `forge sessions` / `session`

Manage saved sessions.

```bash
# List all saved sessions (sorted by most recent)
bun run start -- sessions

# View the full details of a specific session
bun run start -- session <id>
```

---

## Interactive REPL (chat)

When running `forge chat`, you get a full interactive prompt. Type natural language prompts, or use these slash commands:

| Command | Description |
|---|---|
| `/help` | Show all available commands |
| `/new` | Start a fresh session (generates a new session ID) |
| `/resume [id]` | Without id: list saved sessions. With id: restore that session's history |
| `/provider [name] [model]` | Without args: show current provider + model. With args: switch live |
| `/model [name]` | Without args: show current model. With args: switch model |
| `/history` | Show a formatted summary of messages in the current session |
| `/diff` | View current unstaged repository changes |
| `/reset` | Clear the current session's message history |
| `/exit` or `/quit` | Exit the REPL |

**Example session:**

```
Forge> /provider ollama llama3.1
✅ Switched to ollama / llama3.1

Forge> Explain the folder structure of this project
🧠 Step 1: thinking…
⚙️  Step 1: list_directory…
⚙️  Step 1: list_directory ✔ done
This project uses a Bun monorepo with the following structure...

Forge> /diff
 M src/index.ts

Forge> /new
🆕 Started new session: a1b2c3d4-...

Forge> /exit
Goodbye!
```

---

## Permissions

Forge follows a **deny-by-default** permission model. The agent can always read files and Git state, but it cannot modify anything without explicit flags:

| Permission | Flag | What it unlocks |
|---|---|---|
| **Read** | Always on | `read_file`, `list_directory`, `find_files`, `list_symbols`, `search_code`, `git_status`, `git_diff`, `git_log`, `git_blame` |
| **Write** | `--allow-write` | `write_file`, `replace_text`, `apply_patch`, `git_commit` |
| **Execute** | `--allow-execute` | `run_command` (shell commands) |

Without `--allow-write`, file changes trigger the [Diff Approval UI](#diff-approval-ui) for interactive confirmation.  
Without `--allow-execute`, shell commands trigger an interactive approval prompt.

---

## Streaming Output

Forge streams model responses **token by token** as they arrive from the provider. You'll see the agent's thinking appear in real-time rather than waiting for the full response to buffer.

All three providers (OpenAI-compatible, Anthropic, Ollama) support streaming. After the run completes, Forge shows a metadata summary with files modified and token usage.

---

## Diff Approval UI

When running **without** `--allow-write`, any file modification triggers an interactive approval flow:

1. Forge displays a **color-coded visual diff** showing additions (green) and deletions (red)
2. You're prompted: `⚠️ Allow file changes to "path/to/file"? (y/N):`
3. Type `y` to approve, or anything else (or Enter) to reject

This applies to all write tools: `write_file`, `replace_text`, and `apply_patch`.

> **Tip:** If you trust the agent and want to skip approval prompts, use `--allow-write`.

---

## Session Management

Every agent run is automatically saved to `.forge/sessions/<uuid>.json`. Sessions store:

- The original task/prompt
- Full message history (user, assistant, tool calls)
- The agent's plan
- The final result
- Timestamps

**Resuming sessions:**

```bash
# One-shot: resume and continue
bun run start -- agent "Continue" --session <id>

# Interactive: resume inside the REPL
bun run start -- chat
# then:
Forge> /resume <id>
```

**Listing sessions:**

```bash
bun run start -- sessions
```

---

## Custom Tools

You can extend Forge with custom tools by creating a `forge.config.json` in your repository root:

```json
{
  "tools": [
    "./tools/my-custom-tool.ts"
  ]
}
```

Each tool module must export a `RegisteredTool` object (as `default` or `tool`):

```typescript
import type { Tool } from "@forge/types";

const myTool: Tool<{ query: string }, string> = {
  name: "my_custom_tool",
  description: "Does something specific to my project",
  permission: "read",
  async execute(input, context) {
    const startedAt = performance.now();
    // Your tool logic here
    return {
      success: true,
      data: "result",
      durationMs: performance.now() - startedAt,
      metadata: {},
    };
  },
};

export default myTool;
```

Forge loads custom tools at startup and shows `🔌 Registered custom tool: my_custom_tool` on success.

---

## Docker Sandbox

Forge can execute shell commands inside a Docker container for isolation. If Docker is available, the `run_command` tool will mount the repository into a container. If Docker is not available, it falls back to host execution with a warning.

No extra configuration is needed — Forge auto-detects Docker availability.

---

## Keyboard Shortcuts

| Key | Context | Action |
|---|---|---|
| `Ctrl+C` | During agent run | Cancel the current run and return to prompt |
| `Ctrl+C` | At idle prompt | Exit the REPL |
| `Enter` | At prompt | Submit your message |

---

## Troubleshooting

### "Set FORGE_MODEL before using the agent command"
Create a `.env` file with at least `FORGE_MODEL` set. See [Configuration](#configuration).

### "Model request failed (401)"
Your API key is invalid or expired. Check `FORGE_API_KEY` in `.env`.

### "Model request failed (429)"
Rate limited. Wait a moment and try again, or switch to a different model/provider.

### Agent keeps running after GUI program closes
GUI programs (e.g., pygame windows) must be launched in the background. The agent's system prompt handles this, but if it doesn't, you can cancel with `Ctrl+C`.

### "Write permission is required"
Add `--allow-write` to your command, or approve the change when prompted in interactive mode.

### Tests not running
Make sure you have `bun` installed, then run:
```bash
bun install
bun run check
```

---

## Development

```bash
# Install dependencies
bun install

# Run lint + typecheck + tests
bun run check

# Format code
bun run format

# Run in watch mode (auto-reload on changes)
bun run dev -- agent "test task"
```

### Project Structure

```
forge/
├── apps/cli/           # CLI entry point and TUI rendering
├── packages/
│   ├── agent/          # Core agent loop with parallel tool calling
│   ├── context/        # Repository context builder
│   ├── events/         # In-memory pub/sub event bus
│   ├── models/         # Provider adapters (OpenAI, Anthropic, Ollama)
│   ├── runtime/        # Health checks, sandbox, event bus
│   ├── session/        # Session persistence
│   ├── tools/          # Built-in tool implementations
│   └── types/          # Shared TypeScript contracts
├── .env                # Your API keys and provider config
├── forge.config.json   # Optional: custom tool paths
└── context.md          # Architecture reference for contributors
```
