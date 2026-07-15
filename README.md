# Forge

Forge is a modular, terminal-first AI coding-agent runtime.

## Status

The project is in its foundation phase. It currently includes a strict TypeScript Bun monorepo, shared domain types, an event bus, a minimal runtime, and a CLI shell.

## Getting started

```bash
bun install
bun run dev
```

## Workspace layout

- `apps/cli` — the Forge command-line interface.
- `packages/types` — shared domain contracts.
- `packages/events` — event definitions and in-memory event bus.
- `packages/runtime` — session and agent-runtime foundation.
- `packages/{agent,tools,models,context,memory,config,utils}` — reserved subsystem boundaries.
