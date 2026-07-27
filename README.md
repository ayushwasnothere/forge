<div align="center">
  <h1>⚡ Forge</h1>
  <p>A modular, terminal-first AI coding agent built with TypeScript and Bun.</p>

  <a href="https://www.npmjs.com/package/forge-code-ai"><img src="https://img.shields.io/npm/v/forge-code-ai.svg?style=flat-square" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="license" /></a>
</div>

---

**Forge** is an AI coding agent that lives in your terminal. It understands your repository, reads and edits files, runs shell commands, manages Git, and iterates autonomously using an LLM with parallel tool calling.

<!-- Add a demo GIF or screenshot here -->

## ✨ Features

- **Interactive REPL** — Chat interface with streaming ANSI markdown rendering
- **Agentic execution** — Built-in tools for file read/write, search, patch, shell commands, and Git
- **Multiple providers** — OpenRouter, OpenAI, Anthropic, Groq, xAI (Grok), Ollama
- **Parallel tool calling** — Independent operations run concurrently
- **Safe by default** — Granular permissions with interactive, color-coded diff approvals
- **Context-aware** — Auto-reads README, package.json, scripts, and git state
- **Session persistence** — Resume past sessions seamlessly
- **Extensible** — Custom tools via `forge.config.json`, project guidelines via `FORGE.md`
- **Docker sandbox** — Optional containerized command execution
- **Prompt caching** — Native Anthropic prompt caching for cost savings

## 🎬 Demo Showcase

Watch Forge build a full web-based 2D Stickman Level Editor and Game from a single prompt:

- **Demo Video**: [`forge_demo.mp4`](forge_demo.mp4)
- **Demo Prompt**:
  > *"Create a web-based 2D stickman game with two modes: 1. Map Editor (Draw Mode with grid canvas, terrain/platform drawing, spikes, enemies, eraser, Play button) and 2. Game Mode (stickman with auto-forward movement, jump, collision detection, and scrolling camera)."*

## 🚀 Quick Start

Forge requires [Bun](https://bun.sh/).

```bash
# Clone and install
git clone https://github.com/ayushwasnothere/forge.git
cd forge
bun install

# Configure your provider
cp .env.example .env
# Edit .env — set FORGE_API_KEY and FORGE_MODEL

# Launch interactive chat
bun run start
```

### Configuration

Run the interactive setup wizard to configure providers and model aliases:

```bash
forge setup
```

Or configure `~/.forge/config.json` directly for multi-model support:

```json
{
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." },
    "agentrouter": {
      "type": "openai",
      "apiKey": "sk-qtf...",
      "baseUrl": "https://agentrouter.org/v1"
    },
    "enterprise-proxy": {
      "type": "anthropic",
      "apiKey": "sk-ant-...",
      "baseUrl": "https://anthropic.proxy.internal/v1"
    }
  },
  "models": {
    "sonnet": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4" },
    "opus": { "provider": "agentrouter", "model": "claude-opus-4-6" },
    "fast": { "provider": "groq", "model": "llama-3.3-70b-versatile" }
  },
  "defaultModel": "opus"
}
```

In the chat REPL, switch instantly between configured model aliases:

```text
Forge> /model fast    ← switches to Groq llama-3.3-70b
Forge> /model opus    ← switches to Anthropic claude-opus
```

Single-model `.env` files are also supported as fallback:

```dotenv
FORGE_PROVIDER=openrouter
FORGE_API_KEY=your-api-key
FORGE_MODEL=anthropic/claude-sonnet-4
```

## 🧠 Supported Providers

| Provider | `FORGE_PROVIDER` | API Key | Default Endpoint |
|---|---|---|---|
| **OpenRouter** | `openrouter` | Required | `https://openrouter.ai/api/v1` |
| **OpenAI** | `openai` | Required | `https://api.openai.com/v1` |
| **Anthropic** | `anthropic` | Required | `https://api.anthropic.com/v1` |
| **Groq** | `groq` | Required | `https://api.groq.com/openai/v1` |
| **xAI (Grok)** | `grok` | Required | `https://api.x.ai/v1` |
| **Google Gemini** | `gemini` | Required | `https://generativelanguage.googleapis.com/v1beta/openai` |
| **Ollama** | `ollama` | Not needed | `http://localhost:11434/v1` |

Any OpenAI-compatible endpoint works — set `FORGE_BASE_URL` or set `baseUrl` in `~/.forge/config.json`.

## 🛠️ Commands

| Command | Description |
|---|---|
| `forge` | Launch the interactive REPL (default) |
| `forge chat` | Alias for the interactive REPL |
| `forge setup` | Interactive setup wizard for providers & models |
| `forge agent "<task>"` | Run a one-shot autonomous task |
| `forge inspect <path>` | Read files or list directories |
| `forge init` | Scaffold a `FORGE.md` project guidelines file |
| `forge health` | Check runtime and configuration health |
| `forge sessions` | List saved sessions |

### Common Options

```bash
forge --allow-write --allow-execute      # Full permissions
forge --provider ollama                   # Use a specific provider
forge --session <id>                      # Resume a session
forge -c                                  # Continue most recent session
forge agent "task" -p                     # Non-interactive mode
```

### Chat Slash Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/new` | Start a new conversation |
| `/resume [id]` | Resume a past session |
| `/usedir [path]`, `/cd [path]` | Change active workspace directory |
| `/model [alias]` | Switch model (use configured alias or raw name) |
| `/models` | List all configured model aliases |
| `/provider [name]` | Interactive provider setup |
| `/setup` | Launch setup wizard inside REPL |
| `/status` | Show session info, cost, tokens |
| `/compact` | Compress history to save context |
| `/cost` | Display session cost estimate |
| `/history` | View message history |
| `/diff` | Review unstaged changes |
| `/commit` | Auto-generate commit message and commit |
| `/undo` | Revert last agent run |
| `/reset` | Clear session history |
| `/exit` | Exit Forge |

## 🛡️ Permission Model

Forge follows a **deny-by-default** permission model:

| Permission | Default | Flag | What it unlocks |
|---|---|---|---|
| **Read** | ✅ Always on | — | File reads, search, git status, symbols |
| **Write** | ❌ Interactive approval | `--allow-write` | File writes, patches, git commit |
| **Execute** | ❌ Interactive approval | `--allow-execute` | Shell commands |

Without flags, file writes and commands trigger an interactive approval prompt with a color-coded diff preview.

## 📂 Project Guidelines

Create a `FORGE.md` in your repository root to give Forge project-specific instructions:

```markdown
# Project Guidelines

- Use TypeScript with strict mode
- Follow the existing code style
- Run `bun run check` before committing
- Prefer functional patterns over classes
```

Forge auto-loads this file into its system prompt on every run.

## 🔌 Custom Tools

Extend Forge with custom tools via `forge.config.json`:

```json
{
  "tools": ["./tools/my-custom-tool.ts"]
}
```

Each tool module exports a `RegisteredTool` with `name`, `description`, `permission`, and `execute`.

## 🏗️ Architecture

```text
forge/
├── apps/cli/           # CLI entry point and TUI rendering
├── packages/
│   ├── agent/          # Core agent loop with parallel tool calling
│   ├── context/        # Repository context builder
│   ├── events/         # In-memory event bus
│   ├── memory/         # Persistent memory across sessions
│   ├── models/         # Provider adapters (OpenAI, Anthropic, Ollama)
│   ├── runtime/        # Health checks, Docker sandbox
│   ├── session/        # Session persistence
│   ├── tools/          # Built-in tool implementations
│   └── types/          # Shared TypeScript contracts
```

## 🤝 Contributing

```bash
# Install dependencies
bun install

# Run lint + typecheck + tests
bun run check

# Format code
bun run format

# Dev mode (auto-reload)
bun run dev
```

## 📄 License

[MIT](LICENSE)
