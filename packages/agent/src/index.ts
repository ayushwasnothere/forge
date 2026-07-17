import { MemoryStore } from "@forge/memory";
import { detectTestCommand } from "@forge/runtime";
import type { ToolRegistry } from "@forge/tools";
import { formatToolResult } from "@forge/tools";
import type { ModelMessage, ModelProvider, ToolExecutionContext } from "@forge/types";

export type AgentEvent =
  | { type: "model.started"; step: number }
  | { type: "model.token"; step: number; token: string }
  | { type: "model.finished"; step: number; toolCallCount: number }
  | {
      type: "tool.started";
      step: number;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: "tool.finished"; step: number; toolCallId: string; toolName: string; success: boolean };

export interface AgentRunOptions {
  maxSteps?: number;
  repositoryContext?: string;
  verifyCommand?: string;
  history?: ModelMessage[];
  /** When true, appends the new user message directly to history (for REPL multi-turn chat).
   *  When false/undefined, uses a "Continuing the task" prefix (for --session resume). */
  continueChat?: boolean;
  onEvent?: (event: AgentEvent) => void;
  onStepLimitReached?: () => Promise<boolean>;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
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

  // Find oldest complete assistant→tool pairs to compress.
  // We must only cut at boundaries where an assistant message (with tool calls)
  // is immediately followed by its tool results, to preserve conversation validity.
  let compressUpTo = 0;
  let pairs = 0;
  for (let i = 0; i < tail.length - 4; i++) {
    const msg = tail[i];
    const next = tail[i + 1];
    if (msg?.role === "assistant" && next?.role === "tool") {
      // Walk forward to collect all tool responses for this assistant turn
      let j = i + 1;
      while (j < tail.length && tail[j]?.role === "tool") j++;
      compressUpTo = j;
      pairs++;
      if (pairs >= 3) break; // compress up to 3 assistant→tool groups at once
    }
  }

  if (compressUpTo === 0) return messages;

  // Use role "user" (not "system") — mid-conversation system messages are invalid per OpenAI/Anthropic API spec.
  // Claude Code uses the same [CONTEXT COMPACTED] user-message convention.
  const compressed: ModelMessage = {
    role: "user",
    content: `[CONTEXT COMPACTED: ${compressUpTo} earlier messages summarised to save context. The agent has already made progress on the task. Continue from the current state.]`,
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
          // Truncate long run_command outputs in older history to keep context manageable.
          // We look for the formatted output markers rather than parsing presentation strings.
          const content = msg.content ?? "";
          // Find the code fence block and truncate it if the stdout is long
          const fenceStart = content.indexOf("```\n");
          const fenceEnd = content.lastIndexOf("\n```");
          if (fenceStart !== -1 && fenceEnd !== -1 && fenceEnd > fenceStart) {
            const prefix = content.slice(0, fenceStart + 4);
            const stdout = content.slice(fenceStart + 4, fenceEnd);
            if (stdout.length > 200) {
              const truncatedStdout = `${stdout.slice(0, 200)}\n... [output truncated for brevity]`;
              const prunedMessage: ModelMessage = {
                role: "tool",
                toolCallId: msg.toolCallId,
                content: `${prefix}${truncatedStdout}\n\`\`\``,
              };
              result.push(prunedMessage);
              continue;
            }
          }
        }
      }
    }

    result.push(msg);
  }

  return result;
}

const SYSTEM_PROMPT = `You are Forge, an expert autonomous coding agent. You think step-by-step and write clean, correct code.

## Strategy

1. **Orient** — for *existing* codebases, use \`list_directory\` or \`find_files\` to understand structure. Skip if creating from scratch.
2. **Locate** — use \`search_code\` to find relevant files. Never guess file paths.
3. **Read** — use \`read_file\` with \`startLine\`/\`endLine\` to read only what you need.
4. **Plan** — reason in 1–2 sentences before editing. No multi-point prose plans.
5. **Edit** — prefer \`replace_text\` for targeted changes, \`write_file\` for new files or full rewrites, \`apply_patch\` for multi-hunk diffs. For simple tasks (HTML page, single script) keep it in one file.
6. **Verify** — run the test/build command from the repo context ONLY if one exists. Never invent test commands or verification scripts.
7. **Report** — briefly summarise what changed.

## Critical rules

- **Tool calls are mandatory.** Every assistant message that continues work MUST include tool calls. Text without tool calls terminates the loop. Never say "I will do X next" without including the tool call.
- **Write tools confirm success.** \`write_file\` and \`replace_text\` return a preview of the result. Do NOT \`read_file\` after writing — the preview is your confirmation. Do NOT run shell commands (Test-Path, cat, Get-Content) to verify files you just wrote.
- **Don't re-read files in context.** If you already read a file in this conversation and it hasn't been modified since, use the content from your history.
- **Keep responses brief.** 1–2 sentences before tool calls. Let the tools speak.
- **Never invent file paths.** Use \`search_code\` or \`find_files\` to confirm paths.
- **Batch independent calls.** Multiple non-dependent tool calls execute in parallel.
- **GUI / blocking commands**: Launch with \`start\` (Windows) or \`&\` (Unix) to avoid timeout.`;

function getShellContext(): string {
  const isWin = process.platform === "win32";
  if (isWin) {
    return "\n\n## Shell Environment\n- **OS**: Windows\n- **Shell**: PowerShell (powershell.exe)\n- **Rule**: When executing commands with `run_command`, you MUST use PowerShell syntax. Do NOT use bash syntax like '&&', 'ls -la', 'export', or '/'. Instead, use ';', 'Get-ChildItem', '$env:', and '\\' for paths.";
  }
  return "\n\n## Shell Environment\n- **OS**: Unix/macOS\n- **Shell**: POSIX shell (/bin/sh)\n- **Rule**: When executing commands with `run_command`, you MUST use standard POSIX shell syntax.";
}

export class CodingAgent {
  public messages: ModelMessage[] = [];
  public totalInputTokens = 0;
  public totalOutputTokens = 0;

  constructor(
    public readonly model: ModelProvider,
    private readonly tools: ToolRegistry,
  ) {}

  public compactHistory(keepSystemUser = 2): { beforeCount: number; afterCount: number } {
    const beforeCount = this.messages.length;
    const compressed = compressHistory(this.messages, keepSystemUser);
    this.messages.splice(0, this.messages.length, ...compressed);
    return { beforeCount, afterCount: this.messages.length };
  }

  async run(
    task: string,
    context: ToolExecutionContext,
    options: AgentRunOptions = {},
  ): Promise<string> {
    let maxSteps = options.maxSteps ?? 60;
    let messages: ModelMessage[] = [];
    this.messages = messages;

    if (options.history && options.history.length > 0) {
      // Resume existing conversation — push history then new user message
      messages.push(...options.history);
      if (options.continueChat) {
        // REPL chat mode: just append the user's new message directly
        messages.push({ role: "user", content: task });
      } else {
        // One-shot --session resume: add explicit continuation prefix
        messages.push({
          role: "user",
          content: `Continuing the task. Additional instructions: ${task}`,
        });
      }
    } else {
      const facts = await MemoryStore.load(context.repositoryPath);
      let memoryNote = "";
      if (Object.keys(facts).length > 0) {
        memoryNote = `\n\n## Learnt Facts & Settings (Memory)\n${Object.entries(facts)
          .map(([k, v]) => `- ${k}: ${v}`)
          .join("\n")}`;
      }

      const userContent = `Task: ${task}${memoryNote}\n\nRepository Context:\n${options.repositoryContext ?? "(not provided)"}`;

      messages.push(
        { role: "system", content: SYSTEM_PROMPT + getShellContext() },
        {
          role: "user",
          content: userContent,
        },
      );
    }

    const verifyCommand: string | null =
      options.verifyCommand ?? (await detectTestCommand(context.repositoryPath));
    const changedTools = new Set(["write_file", "replace_text", "apply_patch", "git_commit"]);
    let changedFiles = false;
    const filesChanged: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Loop prevention safeguards
    const toolCallCounts = new Map<string, number>();
    let toolCallsSinceLastEdit = 0;

    // Header messages count (system + first user) — don't compress these
    const headerCount = messages.length;

    let step = 0;
    while (true) {
      if (step >= maxSteps) {
        if (options.onStepLimitReached) {
          const shouldContinue = await options.onStepLimitReached();
          if (shouldContinue) {
            maxSteps += options.maxSteps ?? 60;
          } else {
            throw new Error(`Agent exceeded its ${maxSteps}-step limit.`);
          }
        } else {
          throw new Error(`Agent exceeded its ${maxSteps}-step limit.`);
        }
      }

      context.signal?.throwIfAborted();

      // Prune history to optimize context size
      messages = pruneHistory(messages);
      this.messages = messages;

      // Context window management: estimate tokens and compress if needed
      const historyText = messages
        .map((m) => {
          let text = m.content ?? "";
          if (m.toolCalls) {
            text += JSON.stringify(m.toolCalls);
          }
          return text;
        })
        .join("");
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
        this.totalInputTokens += response.usage.inputTokens;
        this.totalOutputTokens += response.usage.outputTokens;
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
        // Detect whether this looks like a premature stop on the very first response.
        // Only push back if: step 0 (no tools were called yet in this run) AND the
        // message history shows no previous tool calls AND the content doesn't look like
        // a deliberate info-only response (e.g. answering a question).
        const content = response.content ?? "";
        const hasPriorToolCalls = messages.some((m) => m.role === "tool");
        const isDeferredAction =
          /\b(let me|i will|i'll|i’ll|i need to|let's|let’s|going to|about to|running|checking|trying|rewriting|updating|adding|modifying|replacing|fixing)\b/i.test(
            content,
          );

        const isQuestion =
          /\?\s*$/i.test(content) ||
          /\b(could you|would you|should i|can you|please clarify|please specify|please let me know)\b/i.test(
            content,
          );

        const looksLikeInfoResponse =
          (content.length < 200 && !isDeferredAction) || // very short responses are probably answers or errors
          /\b(error|fail|denied|cannot|unable|permission|not found|doesn't exist)\b/i.test(
            content,
          ) ||
          /\b(here is|here's|this is|the answer|in summary|to answer)\b/i.test(content);

        const shouldPushBack =
          ((step === 0 && !hasPriorToolCalls && !changedFiles && !looksLikeInfoResponse) ||
            (isDeferredAction && !looksLikeInfoResponse)) &&
          !isQuestion;

        if (shouldPushBack && step < maxSteps - 2) {
          // Push back — the model stopped without taking action
          messages.push({
            role: "user",
            content:
              "You stopped without using any tools. The task is not yet complete. Please continue by calling the appropriate tools to make progress.",
          });
          continue;
        }

        // Model wants to stop — run verification only if a test command exists
        if (
          changedFiles &&
          verifyCommand &&
          (context.allowedPermissions?.includes("execute") || context.onApproveCommand)
        ) {
          const verification = await this.tools.execute(
            "run_command",
            { command: verifyCommand },
            context,
          );
          const exitCode = (verification.data as { exitCode?: number } | undefined)?.exitCode;
          if (!verification.success || exitCode !== 0) {
            const summary = formatToolResult("run_command", verification, context.repositoryPath);
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
          options.pricing,
        );
        this.messages = messages;
        return summary;
      }

      context.signal?.throwIfAborted();

      // Execute tool calls concurrently with loop checks
      const toolResults = await Promise.all(
        response.toolCalls.map(async (call) => {
          context.signal?.throwIfAborted();
          options.onEvent?.({
            type: "tool.started",
            step: step + 1,
            toolCallId: call.id,
            toolName: call.name,
            args: call.arguments as Record<string, unknown>,
          });

          // 1. Loop prevention check: exact same call executed more than 3 times since last edit
          const callKey = `${call.name}:${JSON.stringify(call.arguments)}`;
          const runCount = (toolCallCounts.get(callKey) ?? 0) + 1;
          toolCallCounts.set(callKey, runCount);

          if (runCount > 3) {
            const result: import("@forge/types").ToolResult<unknown> = {
              success: false,
              error: `Tool call blocked by loop prevention. You have already executed '${call.name}' with these identical arguments ${runCount - 1} times since your last file edit. Do not repeat the same call. If the file content or status has not changed, proceed to making an edit or completing the task.`,
              durationMs: 0,
              metadata: {},
            };
            options.onEvent?.({
              type: "tool.finished",
              step: step + 1,
              toolCallId: call.id,
              toolName: call.name,
              success: false,
            });
            return { call, result };
          }

          // 2. Progress detector check: limit total non-edit tool calls
          toolCallsSinceLastEdit++;
          if (toolCallsSinceLastEdit > 12) {
            throw new Error(
              `Agent aborted: Loop detected. Executed ${toolCallsSinceLastEdit} consecutive tool calls without making any successful file edits.`,
            );
          }

          const result = await this.tools.execute(call.name, call.arguments, context);

          options.onEvent?.({
            type: "tool.finished",
            step: step + 1,
            toolCallId: call.id,
            toolName: call.name,
            success: result.success,
          });

          return { call, result };
        }),
      );

      let changedFilesThisStep = false;
      for (const { call, result } of toolResults) {
        if (changedTools.has(call.name) && result.success) {
          changedFiles = true;
          changedFilesThisStep = true;
          // Track changed paths
          const d = result.data as { path?: string; filesPatched?: string[] } | undefined;
          if (d?.path) filesChanged.push(d.path);
          if (d?.filesPatched) filesChanged.push(...d.filesPatched);
        }

        // Use formatted summary instead of raw JSON to reduce context bloat
        const formattedResult = formatToolResult(call.name, result, context.repositoryPath);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: formattedResult,
        });
      }

      if (changedFilesThisStep) {
        toolCallCounts.clear();
        toolCallsSinceLastEdit = 0;
      }

      context.signal?.throwIfAborted();
      step += 1;
    }
  }
}

function buildFinalSummary(
  content: string,
  filesChanged: string[],
  inputTokens: number,
  outputTokens: number,
  pricing?: { inputPerMillion: number; outputPerMillion: number },
): string {
  const parts: string[] = [content];

  if (filesChanged.length > 0) {
    const unique = [...new Set(filesChanged)];
    parts.push(`\n\n---\n**Files modified:**\n${unique.map((f) => `- \`${f}\``).join("\n")}`);
  }

  if (inputTokens > 0 || outputTokens > 0) {
    let costStr = "";
    if (pricing) {
      const cost =
        (inputTokens / 1_000_000) * pricing.inputPerMillion +
        (outputTokens / 1_000_000) * pricing.outputPerMillion;
      costStr = ` (est. cost: $${cost.toFixed(4)})`;
    }
    parts.push(
      `\n**Tokens used:** ${inputTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out${costStr}`,
    );
  }

  return parts.join("");
}
