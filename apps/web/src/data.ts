export const features = [
  {
    icon: "💬",
    title: "Interactive REPL",
    body: "Real-time chat interface with streaming ANSI markdown rendering, slash commands, and inline diff approvals.",
  },
  {
    icon: "🤖",
    title: "Agentic Execution",
    body: "Built-in tools for file read/write, search, apply_patch, shell commands, and full Git workflow management.",
  },
  {
    icon: "🔌",
    title: "Multiple Providers",
    body: "First-class support for OpenRouter, OpenAI, Anthropic, Groq, xAI Grok, Google Gemini, and local Ollama.",
  },
  {
    icon: "⚡",
    title: "Parallel Tool Calling",
    body: "Independent tool operations run concurrently — edit multiple files and run commands simultaneously.",
  },
  {
    icon: "🛡️",
    title: "Safe by Default",
    body: "Deny-by-default permissions. Every file write and shell command needs explicit approval with color-coded diffs.",
  },
  {
    icon: "🧠",
    title: "Context-Aware",
    body: "Automatically reads README, package.json, project scripts, git state, and FORGE.md guidelines.",
  },
  {
    icon: "💾",
    title: "Session Persistence",
    body: "Save, list, and resume sessions seamlessly. Continue exactly where you left off, anytime.",
  },
  {
    icon: "🔧",
    title: "Extensible",
    body: "Register custom tools via forge.config.json. Add project-specific instructions with FORGE.md.",
  },
] as const;

export const providers = [
  "OpenRouter",
  "OpenAI",
  "Anthropic",
  "Groq",
  "xAI Grok",
  "Gemini",
  "Ollama",
] as const;

export const stats = [
  { value: "7+", label: "LLM Providers" },
  { value: "15+", label: "Built-in Tools" },
  { value: "100%", label: "Open Source" },
  { value: "<3MB", label: "Install Size" },
] as const;

// Scripted terminal demo lines
export const terminalLines = [
  {
    kind: "prompt",
    text: 'forge agent "add input validation to the login handler" --allow-write',
  },
  { kind: "blank", text: "" },
  { kind: "step", text: "🧠 Analyzing repository structure…" },
  { kind: "step", text: "⚙️  read_file src/routes/login.ts ✔" },
  { kind: "step", text: '⚙️  grep_search "loginHandler" ✔' },
  { kind: "step", text: "⚙️  read_file src/schemas/auth.ts ✔" },
  { kind: "step", text: "⚙️  apply_patch src/routes/login.ts ✔" },
  { kind: "step", text: "⚙️  apply_patch src/schemas/auth.ts ✔" },
  { kind: "step", text: "⚙️  run_command bun test auth ✔" },
  { kind: "blank", text: "" },
  {
    kind: "out",
    text: "✅ Added Zod validation to loginHandler. 2 files changed, 3 tests passing.",
  },
] as const;
