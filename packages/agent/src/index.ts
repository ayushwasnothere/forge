import { detectTestCommand } from "@forge/runtime";
import type { ToolRegistry } from "@forge/tools";
import { formatToolResult } from "@forge/tools";
import type { ModelMessage, ModelProvider, ToolExecutionContext } from "@forge/types";

export type AgentEvent =
  | { type: "plan.started" }
  | { type: "plan.finished"; plan: string }
  | { type: "model.started"; step: number }
  | { type: "model.token"; step: number; token: string }
  | { type: "model.finished"; step: number; toolCallCount: number }
  | { type: "tool.started"; step: number; toolName: string }
  | { type: "tool.finished"; step: number; toolName: string; success: boolean };

export interface AgentRunOptions {
  maxSteps?: number;
  repositoryContext?: string;
  verifyCommand?: string;
  history?: ModelMessage[];
  onEvent?: (event: AgentEvent) => void;
  enablePlanning?: boolean;
}

/** Approximate token count — 1 token ≈ 4 chars. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Summarise the oldest tool round-trips to keep context window manageable. */
function compressHistory(messages: ModelMessage[], keepSystemUser: number): ModelMessage[] {
  if (messages.length <= keepSystemUser + 4) return messages;

  const header = messages.slice(0, keepSystemUser);
  const tail = messages.slice(keepSystemUser);

  // Find oldest complete assistant→tool pair to compress
  let compressUpTo = 0;
  let pairs = 0;
  for (let i = 0; i < tail.length - 4; i++) {
    if (tail[i]?.role === "assistant" && tail[i + 1]?.role === "tool") {
      compressUpTo = i + 2;
      pairs++;
      if (pairs >= 3) break; // compress up to 3 pairs at once
    }
  }

  if (compressUpTo === 0) return messages;

  const compressed: ModelMessage = {
    role: "user",
    content: `[${compressUpTo} earlier messages compressed to save context. The agent has already made progress on the task. Continue from the current state.]`,
  };

  return [...header, compressed, ...tail.slice(compressUpTo)];
}

/** Prune history to optimize context size. */
export function pruneHistory(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= 2) return messages;

  const toolCallMap = new Map<string, { name: string; argsStr: string }>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls) {
      for (const call of msg.toolCalls) {
        toolCallMap.set(call.id, {
          name: call.name,
          argsStr: JSON.stringify(call.arguments),
        });
      }
    }
  }

  const latestReadFileIndex = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg && msg.role === "tool" && msg.toolCallId) {
      const callDef = toolCallMap.get(msg.toolCallId);
      if (callDef && callDef.name === "read_file") {
        latestReadFileIndex.set(callDef.argsStr, i);
      }
    }
  }

  const assistantIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant") {
      assistantIndices.push(i);
    }
  }

  // thresholdIndex is the 3rd assistant message from the end
  const thresholdIndex = assistantIndices.length > 2 ? (assistantIndices[2] ?? -1) : -1;

  const result: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (i === 0 || i === messages.length - 1) {
      result.push(msg);
      continue;
    }

    if (msg.role === "tool" && msg.toolCallId) {
      const callDef = toolCallMap.get(msg.toolCallId);
      if (callDef) {
        if (callDef.name === "read_file") {
          const latestIdx = latestReadFileIndex.get(callDef.argsStr);
          if (latestIdx !== undefined && i < latestIdx) {
            const prunedMessage: ModelMessage = {
              role: "tool",
              toolCallId: msg.toolCallId,
              content: "[File contents replaced to save context space. Refer to latest read.]",
            };
            result.push(prunedMessage);
            continue;
          }
        }

        if (callDef.name === "run_command" && thresholdIndex !== -1 && i <= thresholdIndex + 5) {
          if (msg.content?.startsWith("✅ run_command")) {
            const match = msg.content.match(/^✅ run_command(.*?):\n```\n([\s\S]*?)\n```$/);
            if (match) {
              const exitNote = match[1] ?? "";
              const stdout = match[2] ?? "";
              if (stdout.length > 200) {
                const truncatedStdout = `${stdout.slice(0, 200)}\n... [output truncated for brevity]`;
                const prunedMessage: ModelMessage = {
                  role: "tool",
                  toolCallId: msg.toolCallId,
                  content: `✅ run_command${exitNote}:\n\`\`\`\n${truncatedStdout}\n\`\`\``,
                };
                result.push(prunedMessage);
                continue;
              }
            }
          }
        }
      }
    }

    result.push(msg);
  }

  return result;
}

const SYSTEM_PROMPT = `You are Forge, an expert autonomous coding agent. You think carefully, act deliberately, and write clean, correct code.

## Strategy — follow this order for every task

1. **Orient** — use \`git_status\`, \`list_directory\` (or \`find_files\`) to understand the codebase shape.
2. **Locate** — use \`search_code\` to find the relevant files and symbols. Never guess file paths.
3. **Read** — use \`read_file\` with \`startLine\`/\`endLine\` to read just what you need. Use \`list_symbols\` to get a file's outline first.
4. **Plan** — reason step-by-step *before* editing. Write a short plan in your response before calling write tools.
5. **Edit** — prefer \`replace_text\` for targeted changes. Use \`write_file\` (overwrite=true) only for full rewrites. Use \`apply_patch\` for multi-hunk diffs.
6. **Verify** — after editing, run the project's test/build command to confirm correctness. If it fails, read the error and fix it.
7. **Commit** — if the user asked for a commit, use \`git_commit\` with a clear conventional-commit message.
8. **Report** — when done, summarise: what files changed, what was added/removed, and the test outcome.

## Hard rules

- **Never invent file paths.** Always use \`search_code\` or \`find_files\` to confirm a file exists before reading or editing it.
- **Never repeat the full file contents** in your response — reference line numbers instead.
- **Batch independent reads.** You may call multiple tools in a single step when the results do not depend on each other (e.g. reading several files, running search + git_status simultaneously). They execute in parallel.
- **No deferred tool execution.** If you want to use a tool, you MUST include the tool call in your current assistant message. Never output text saying "I will run X" or "Let me edit Y" in a future step without actually generating the tool call in this response. If you output text without tool calls, the agent loop immediately terminates.
- **If a test fails**, do not give up. Read the failure, locate the relevant code, and fix it. You get multiple steps.
- **Write permission is required** for \`write_file\`, \`replace_text\`, \`apply_patch\`, and \`git_commit\`.
- **If you are unsure** about a design decision, state the trade-offs and pick the simpler option.
- **GUI / Blocking commands**: If you need to launch a GUI window or run a long-running process (like Pygame or a local web server) that does not exit immediately, you MUST run it in the background to prevent a command timeout.
  - On Windows (cmd): Use \`start\`, e.g. \`start python calculator.py\`
  - On Unix: Use \`&\` at the end, e.g. \`python calculator.py &\`

## Tool quick-reference

| Tool | When to use |
|---|---|
| \`find_files\` | Discover files by glob pattern — faster than recursive listing |
| \`search_code\` | Find where a symbol, string, or pattern is used |
| \`list_symbols\` | Get the outline (functions, classes) of a file without reading it all |
| \`read_file\` | Read a file or a specific line range |
| \`replace_text\` | Targeted single-block edits (preferred) |
| \`apply_patch\` | Multi-hunk or multi-file edits via unified diff |
| \`write_file\` | Create new files or full overwrites |
| \`run_command\` | Build, test, lint, or any shell command |
| \`git_status\` | Check what has changed |
| \`git_diff\` | See the exact diff of current changes |
| \`git_log\` | Review recent commits for context |
| \`git_blame\` | Find who changed a specific line and when |
| \`git_commit\` | Stage and commit specific files |

Start by thinking through the task, then act.`;

export class CodingAgent {
  public messages: ModelMessage[] = [];

  constructor(
    private readonly model: ModelProvider,
    private readonly tools: ToolRegistry,
  ) {}

  async run(
    task: string,
    context: ToolExecutionContext,
    options: AgentRunOptions = {},
  ): Promise<string> {
    const maxSteps = options.maxSteps ?? 20;
    let messages: ModelMessage[] = [];
    this.messages = messages;

    if (options.history && options.history.length > 0) {
      // Resume: load history, inject a continuation message
      messages.push(...options.history);
      messages.push({
        role: "user",
        content: `Continuing the task. Additional instructions: ${task}`,
      });
    } else {
      // Fresh start — generate a real plan using the model if requested
      options.onEvent?.({ type: "plan.started" });

      let generatedPlan = `Task: ${task}\n\nRepository context:\n${options.repositoryContext ?? "(not provided)"}`;

      if (options.enablePlanning) {
        try {
          const plannerResponse = await this.model.complete({
            messages: [
              {
                role: "system",
                content:
                  "You are Forge's planning assistant. Generate a concise, step-by-step implementation plan for the given task. List what files to create or modify, any command executions needed, and how to verify the work. Keep it clear and action-oriented. Never output tool calls here, output only raw text.",
              },
              {
                role: "user",
                content: `Task: ${task}\n\nRepository context:\n${options.repositoryContext ?? "(not provided)"}`,
              },
            ],
            tools: [],
          });
          if (plannerResponse.content) {
            generatedPlan = plannerResponse.content;
          }
        } catch (error) {
          // Fallback to basic planNote if planning fails
        }
      }

      options.onEvent?.({ type: "plan.finished", plan: generatedPlan });

      const planNote = `Task: ${task}\n\nImplementation Plan:\n${generatedPlan}\n\nRepository Context:\n${options.repositoryContext ?? "(not provided)"}`;

      messages.push(
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `${planNote}\n\nPlease begin executing the plan.`,
        },
      );
    }

    const verifyCommand =
      options.verifyCommand ?? (await detectTestCommand(context.repositoryPath));
    const changedTools = new Set(["write_file", "replace_text", "apply_patch", "git_commit"]);
    let changedFiles = false;
    const filesChanged: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Header messages count (system + first user) — don't compress these
    const headerCount = messages.length;

    for (let step = 0; step < maxSteps; step += 1) {
      context.signal?.throwIfAborted();

      // Prune history to optimize context size
      messages = pruneHistory(messages);
      this.messages = messages;

      // Context window management: estimate tokens and compress if needed
      const historyText = messages.map((m) => m.content ?? "").join("");
      const estimatedTokens = estimateTokens(historyText);
      if (estimatedTokens > 60_000) {
        const compressed = compressHistory(messages, headerCount);
        messages.splice(0, messages.length, ...compressed);
      }

      options.onEvent?.({ type: "model.started", step: step + 1 });
      const response = await this.model.complete({
        messages,
        tools: this.tools.definitions(),
        ...(context.signal ? { signal: context.signal } : {}),
        onToken: (token) => {
          options.onEvent?.({ type: "model.token", step: step + 1, token });
        },
      });

      if (response.usage) {
        totalInputTokens += response.usage.inputTokens;
        totalOutputTokens += response.usage.outputTokens;
      }

      options.onEvent?.({
        type: "model.finished",
        step: step + 1,
        toolCallCount: response.toolCalls.length,
      });

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      if (response.toolCalls.length === 0) {
        // Model wants to stop — run verification if files changed
        if (
          changedFiles &&
          (context.allowedPermissions?.includes("execute") || context.onApproveCommand)
        ) {
          const verification = await this.tools.execute(
            "run_command",
            { command: verifyCommand },
            context,
          );
          const exitCode = (verification.data as { exitCode?: number } | undefined)?.exitCode;
          if (!verification.success || exitCode !== 0) {
            const summary = formatToolResult("run_command", verification);
            messages.push({
              role: "user",
              content: `Verification with \`${verifyCommand}\` failed. Diagnose the error and fix it:\n\n${summary}`,
            });
            continue;
          }
        }

        // Append token/file summary to final answer
        const summary = buildFinalSummary(
          response.content,
          filesChanged,
          totalInputTokens,
          totalOutputTokens,
        );
        this.messages = messages;
        return summary;
      }

      context.signal?.throwIfAborted();

      // Execute tool calls concurrently
      const toolResults = await Promise.all(
        response.toolCalls.map(async (call) => {
          context.signal?.throwIfAborted();
          options.onEvent?.({ type: "tool.started", step: step + 1, toolName: call.name });

          const result = await this.tools.execute(call.name, call.arguments, context);

          options.onEvent?.({
            type: "tool.finished",
            step: step + 1,
            toolName: call.name,
            success: result.success,
          });

          return { call, result };
        }),
      );

      for (const { call, result } of toolResults) {
        if (changedTools.has(call.name) && result.success) {
          changedFiles = true;
          // Track changed paths
          const d = result.data as { path?: string; filesPatched?: string[] } | undefined;
          if (d?.path) filesChanged.push(d.path);
          if (d?.filesPatched) filesChanged.push(...d.filesPatched);
        }

        // Use formatted summary instead of raw JSON to reduce context bloat
        const formattedResult = formatToolResult(call.name, result);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: formattedResult,
        });
      }

      context.signal?.throwIfAborted();
    }
    throw new Error(`Agent exceeded its ${maxSteps}-step limit.`);
  }
}

function buildFinalSummary(
  content: string,
  filesChanged: string[],
  inputTokens: number,
  outputTokens: number,
): string {
  const parts: string[] = [content];

  if (filesChanged.length > 0) {
    const unique = [...new Set(filesChanged)];
    parts.push(`\n\n---\n**Files modified:**\n${unique.map((f) => `- \`${f}\``).join("\n")}`);
  }

  if (inputTokens > 0 || outputTokens > 0) {
    parts.push(
      `\n**Tokens used:** ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out`,
    );
  }

  return parts.join("");
}
