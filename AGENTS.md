# Forge Agent Guide

Read [context.md](context.md) before changing code. It is the current handoff record: architecture, commands, constraints, known limitations, and ordered next work.

## Required workflow

1. Inspect the relevant package before editing it.
2. Preserve the tool boundary: agents use `ToolRegistry`; they never call filesystem, Git, or shell APIs directly.
3. Keep write and command execution permission-gated.
4. Update `context.md` for any material architecture, command, verification, limitation, or roadmap change.
5. Run `bun run check` before handing work back.

## Entry points

- `apps/cli/src/index.ts` — CLI commands and user-facing progress.
- `packages/agent/src/index.ts` — model/tool execution loop.
- `packages/tools/src/index.ts` — built-in tools and safety checks.
- `packages/models/src/index.ts` — OpenAI-compatible provider.
- `packages/runtime/src/index.ts` — runtime and health checks.
