export const features = [
  { title: "Interactive REPL", body: "Chat interface with streaming ANSI markdown rendering." },
  {
    title: "Agentic execution",
    body: "Built-in tools for file read/write, search, patch, shell, and Git.",
  },
  {
    title: "Multiple providers",
    body: "OpenRouter, OpenAI, Anthropic, Groq, xAI (Grok), Gemini, Ollama.",
  },
  { title: "Parallel tool calling", body: "Independent operations run concurrently for speed." },
  {
    title: "Safe by default",
    body: "Deny-by-default permissions with color-coded diff approvals.",
  },
  { title: "Context-aware", body: "Auto-reads README, package.json, scripts, and git state." },
  { title: "Session persistence", body: "Resume past sessions seamlessly, anytime." },
  { title: "Extensible", body: "Custom tools via forge.config.json, guidelines via FORGE.md." },
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

// Scripted terminal demo — [prompt?, output lines...]
export const terminalLines = [
  { kind: "prompt", text: 'forge agent "add input validation to the login handler" --allow-write' },
  { kind: "step", text: "🧠 Step 1: thinking…" },
  { kind: "step", text: "⚙️  read_file src/login.ts ✔" },
  { kind: "step", text: "⚙️  apply_patch src/login.ts ✔" },
  { kind: "out", text: "✅ Added zod validation to loginHandler. 1 file changed." },
] as const;
