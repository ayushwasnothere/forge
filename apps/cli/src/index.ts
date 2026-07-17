#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { MultiLinePrompt } from "@clack/core";

import {
  confirm,
  intro,
  isCancel,
  log,
  multiline,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { CodingAgent } from "@forge/agent";
import { RepositoryContextBuilder } from "@forge/context";
import { type ProviderKind, calculateCost, createProvider, getModelPricing } from "@forge/models";
import { AgentRuntime } from "@forge/runtime";
import { SessionStore, type StoredSession } from "@forge/session";
import {
  ToolRegistry,
  applyPatchTool,
  findFilesTool,
  forgetFactTool,
  formatToolResult,
  gitBlameTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
  listDirectoryTool,
  listSymbolsTool,
  readFileTool,
  recallFactsTool,
  rememberFactTool,
  replaceTextTool,
  runCommandTool,
  searchCodeTool,
  writeFileTool,
} from "@forge/tools";
import type { ModelMessage } from "@forge/types";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig, loadGlobalConfig } from "./config";
import {
  clearStreamedText,
  generateVisualDiff,
  renderMarkdown,
  toolArgPreview,
  toolIcon,
} from "./tui";

const program = new Command();

async function loadExternalTools(registry: ToolRegistry, root: string): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");

  const configPath = join(root, "forge.config.json");
  const content = await readFile(configPath, "utf8").catch(() => null);
  if (!content) return;

  try {
    const config = JSON.parse(content) as { tools?: string[] };
    if (Array.isArray(config.tools)) {
      for (const toolRelPath of config.tools) {
        const absPath = resolve(root, toolRelPath);
        const mod = await import(absPath);
        const toolObj = mod.default || mod.tool;
        if (toolObj && typeof toolObj.name === "string" && typeof toolObj.execute === "function") {
          registry.register(toolObj);
          console.log(`🔌 Registered custom tool: ${toolObj.name} from ${toolRelPath}`);
        } else {
          console.warn(`⚠️ Custom tool module at ${toolRelPath} must export a valid Tool object.`);
        }
      }
    }
  } catch (err) {
    console.warn(
      `⚠️ Failed to parse or load forge.config.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

program
  .name("forge")
  .description("A modular, terminal-first AI coding-agent runtime")
  .version("0.1.0")
  .action(async () => {
    const globalConfig = await loadGlobalConfig();
    process.env.FORGE_CLI_ROOT = globalConfig.forgePath || homedir();
    const store = new SessionStore(sessionsRoot());
    const sessions = await store.list().catch(() => []);
    const currentPath = path.resolve(process.cwd());
    const matched = sessions.filter(
      (s) => s.repositoryPath && path.resolve(s.repositoryPath) === currentPath,
    );
    const sorted = matched.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latest = sorted[0];
    if (latest) {
      console.log(
        `Forge v0.1.0\n\n🌿 Active session found: ${pc.dim(latest.id.slice(0, 8))}… "${latest.task}"\nRun: ${pc.cyan("bun run start -- chat -c")} to resume, or ${pc.cyan("bun run start -- chat")} to start a new chat.`,
      );
    } else {
      console.log("Forge v0.1.0\n\nNo session active in the current directory.");
      const startChat = await confirm({
        message: `Do you want to start an interactive chat in the current directory ("${currentPath}")?`,
        initialValue: true,
      });
      if (startChat && typeof startChat === "boolean") {
        await runChatAction({
          maxSteps: "60",
          commandTimeout: "60",
          workspace: currentPath,
        });
      } else {
        outro("To start a chat in another directory, run: bun run start -- chat");
      }
    }
  });

program
  .command("inspect <path>")
  .description("Read a file or list a directory within the current repository")
  .option("--symbols", "list symbols (functions, classes) in a source file")
  .action(async (path: string, options: { symbols?: boolean }) => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(listDirectoryTool);
    registry.register(listSymbolsTool);
    const context = { repositoryPath: process.cwd() };

    if (options.symbols) {
      const result = await registry.execute("list_symbols", { path }, context);
      if (!result.success) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(formatToolResult("list_symbols", result, context.repositoryPath));
      return;
    }

    let result = await registry.execute("read_file", { path }, context);
    if (!result.success && result.error?.endsWith("is not a file.")) {
      result = await registry.execute("list_directory", { path, recursive: false }, context);
    }

    if (!result.success) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }

    console.log(
      formatToolResult(
        result.data && "symbols" in (result.data as object)
          ? "list_symbols"
          : result.data && "entries" in (result.data as object)
            ? "list_directory"
            : "read_file",
        result,
        context.repositoryPath,
      ),
    );
  });

program
  .command("replace <path> <old-text> <new-text>")
  .description("Replace one exact text match in a repository file")
  .option("--allow-write", "grant permission to modify the file")
  .action(
    async (path: string, oldText: string, newText: string, options: { allowWrite?: boolean }) => {
      const registry = new ToolRegistry();
      registry.register(replaceTextTool);
      const result = await registry.execute(
        "replace_text",
        { path, oldText, newText },
        {
          repositoryPath: process.cwd(),
          allowedPermissions: options.allowWrite ? ["write"] : [],
        },
      );

      if (!result.success) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }

      console.log(`Updated ${path}.`);
    },
  );

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** The canonical list of built-in tools registered in every command. */
const BUILTIN_TOOLS = [
  readFileTool,
  listDirectoryTool,
  findFilesTool,
  listSymbolsTool,
  replaceTextTool,
  applyPatchTool,
  writeFileTool,
  runCommandTool,
  searchCodeTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitBlameTool,
  gitCommitTool,
  rememberFactTool,
  recallFactsTool,
  forgetFactTool,
];

async function promptWorkspace(supplied: string | undefined): Promise<string> {
  if (supplied) return supplied;
  if (!process.stdin.isTTY) return "sandbox";

  // Check if there is any session with the current path in global .forge/sessions
  const store = new SessionStore(sessionsRoot());
  const sessions = await store.list().catch(() => []);
  const currentPath = path.resolve(process.cwd());
  const hasSession = sessions.some(
    (s) => s.repositoryPath && path.resolve(s.repositoryPath) === currentPath,
  );

  if (!hasSession) {
    const useCurrent = await confirm({
      message: `No active sessions found for this directory. Use current directory ("${currentPath}") as workspace?`,
      initialValue: true,
    });
    if (useCurrent && typeof useCurrent === "boolean") {
      return currentPath;
    }
  }

  const result = await text({
    message: "Enter workspace path",
    defaultValue: "sandbox",
    placeholder: "sandbox",
  });

  if (isCancel(result)) {
    outro("Aborted.");
    process.exit(0);
  }
  return String(result).trim() || "sandbox";
}

/** Ask the user a y/N question via clack. Returns true if they say yes. */
async function ynPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const result = await confirm({ message: question });
  if (isCancel(result)) return false;
  return result;
}

/** Run a git command in the workspace. */
async function execGit(workspace: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("git", args, { cwd: workspace });
    return stdout.trim();
  } catch {
    return "";
  }
}

type ApprovalChoice = "once" | "step" | "session" | "deny" | "abort";

async function richApprovalPrompt(message: string): Promise<ApprovalChoice> {
  if (!process.stdin.isTTY) return "deny";
  const result = await select({
    message,
    options: [
      { value: "once", label: "y - Yes (allow once)" },
      { value: "step", label: "s - Allow all in this step / batch" },
      { value: "session", label: "a - Always allow (for the whole session)" },
      { value: "deny", label: "n - No (deny once)" },
      { value: "abort", label: "d - Deny all / Abort" },
    ],
  });
  if (isCancel(result) || result === "abort") return "abort";
  return result as ApprovalChoice;
}

class PromptMutex {
  private promise: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.promise.then(() => fn());
    this.promise = next.catch(() => {});
    return next as Promise<T>;
  }
}

const promptMutex = new PromptMutex();

/** Build the interactive command-approval callback when --allow-execute is not set. */
function makeOnApproveCommand(
  permissions: ("write" | "execute")[],
  stepPermissions: ("write" | "execute")[],
  nonInteractive?: boolean,
): (cmd: string) => Promise<boolean> {
  return async (cmd: string) => {
    if (permissions.includes("execute") || stepPermissions.includes("execute")) {
      return true;
    }
    if (nonInteractive) {
      return false;
    }
    return promptMutex.run(async () => {
      const choice = await richApprovalPrompt(`⚠️  Forge wants to run: "${cmd}"`);
      switch (choice) {
        case "session":
          permissions.push("execute");
          return true;
        case "step":
          stepPermissions.push("execute");
          return true;
        case "once":
          return true;
        case "abort":
          outro("Aborted by user request.");
          process.exit(0);
          return false;
        default:
          return false;
      }
    });
  };
}

/** Build the interactive file-change-approval callback when --allow-write is not set. */
function makeOnApproveFileChange(
  permissions: ("write" | "execute")[],
  stepPermissions: ("write" | "execute")[],
  nonInteractive?: boolean,
): (filePath: string, newContent: string, currentContent?: string) => Promise<boolean> {
  return async (filePath: string, newContent: string, currentContent?: string) => {
    if (permissions.includes("write") || stepPermissions.includes("write")) {
      return true;
    }
    if (nonInteractive) {
      return false;
    }
    return promptMutex.run(async () => {
      const diff = generateVisualDiff(newContent, currentContent);
      note(diff, `Proposed changes to ${filePath}`);
      const choice = await richApprovalPrompt(`Allow file changes to "${filePath}"?`);
      switch (choice) {
        case "session":
          permissions.push("write");
          return true;
        case "step":
          stepPermissions.push("write");
          return true;
        case "once":
          return true;
        case "abort":
          outro("Aborted by user request.");
          process.exit(0);
          return false;
        default:
          return false;
      }
    });
  };
}

/** Build the step-limit-reached callback that prompts the user to continue. */
function makeOnStepLimitReached(
  spinnerObj: ReturnType<typeof spinner> | null,
  nonInteractive?: boolean,
): () => Promise<boolean> {
  return async () => {
    if (nonInteractive) {
      return false;
    }
    if (spinnerObj) spinnerObj.stop("Step limit reached");
    const cont = await ynPrompt("⚠️ Step limit reached. Continue?");
    if (cont) log.info("Continuing execution...");
    return cont;
  };
}

/**
 * Build the onEvent handler shared by agent and chat commands.
 * Keys timer/args maps by toolCallId to correctly handle parallel tool calls.
 */
function makeOnEventHandler(
  spinnerObj: ReturnType<typeof spinner>,
  runtime: AgentRuntime,
  taskId: string,
  opts: {
    getStreamedText: () => string;
    setStreamedText: (t: string) => void;
    hadContent: () => boolean;
    setHadContent: (v: boolean) => void;
  },
  nonInteractive?: boolean,
): (event: import("@forge/agent").AgentEvent) => void {
  const toolTimers = new Map<string, number>();
  const toolArgsMap = new Map<string, Record<string, unknown>>();
  let spinnerActive = false;

  return (event) => {
    const now = new Date().toISOString();
    if (event.type === "model.started") {
      opts.setHadContent(false);
      opts.setStreamedText("");
      if (!nonInteractive) {
        spinnerActive = true;
        spinnerObj.start(`analyzing… (step ${event.step})`);
      }
      runtime.events.publish({ type: "model.started", taskId, step: event.step, timestamp: now });
    }
    if (event.type === "model.token") {
      if (spinnerActive) {
        spinnerObj.stop();
        spinnerActive = false;
      }
      opts.setHadContent(true);
      opts.setStreamedText(opts.getStreamedText() + event.token);
      process.stdout.write(event.token);
    }
    if (event.type === "model.finished") {
      if (spinnerActive) {
        spinnerObj.stop();
        spinnerActive = false;
      }
      if (opts.hadContent()) {
        if (!nonInteractive) {
          clearStreamedText(opts.getStreamedText());
          console.log(renderMarkdown(opts.getStreamedText()));
        } else {
          process.stdout.write("\n");
        }
      }
      runtime.events.publish({
        type: "model.finished",
        taskId,
        step: event.step,
        toolCallCount: event.toolCallCount,
        timestamp: now,
      });
    }
    if (event.type === "tool.started") {
      toolTimers.set(event.toolCallId, Date.now());
      toolArgsMap.set(event.toolCallId, event.args ?? {});
      if (nonInteractive) {
        const preview = toolArgPreview(event.toolName, event.args ?? {});
        const previewStr = preview ? `: ${preview}` : "";
        process.stderr.write(`🛠️  [tool.started] ${event.toolName}${previewStr}\n`);
      }
      runtime.events.publish({
        type: "tool.started",
        taskId,
        step: event.step,
        toolName: event.toolName,
        timestamp: now,
      });
    }
    if (event.type === "tool.finished") {
      const duration = Date.now() - (toolTimers.get(event.toolCallId) ?? Date.now());
      const args = toolArgsMap.get(event.toolCallId) ?? {};

      const preview = toolArgPreview(event.toolName, args);
      const icon = toolIcon(event.toolName);
      const dStr = duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`;
      const previewStr = preview ? `  ${pc.dim(preview)}` : "";

      const msg = `${pc.gray(icon)} ${pc.cyan(event.toolName)}${previewStr}  ${pc.gray(dStr)}`;
      if (!nonInteractive) {
        promptMutex.run(async () => {
          if (event.success) {
            log.success(msg);
          } else {
            log.error(msg);
          }
        });
      } else {
        process.stderr.write(
          `${event.success ? "✅" : "❌"} [tool.finished] ${event.toolName} (${dStr})\n`,
        );
      }

      runtime.events.publish({
        type: "tool.finished",
        taskId,
        step: event.step,
        toolName: event.toolName,
        success: event.success,
        timestamp: now,
      });
    }
  };
}

/** Walk up parent directories to find repository/project root. */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (
      existsSync(path.join(dir, ".git")) ||
      existsSync(path.join(dir, "package.json")) ||
      existsSync(path.join(dir, ".forge"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return startDir;
}

/** Return the sessions directory root — same logic as SessionStore uses. */
function sessionsRoot(): string {
  return process.env.FORGE_CLI_ROOT || findProjectRoot(process.cwd());
}

program
  .command("agent [task]")
  .description("Run the coding agent with an OpenAI-compatible model provider")
  .option("--allow-write", "allow file writes")
  .option("--allow-execute", "allow shell commands")
  .option("--max-steps <number>", "maximum agent steps", "60")
  .option("--command-timeout <seconds>", "shell-command timeout", "60")
  .option("--provider <name>", "openrouter, openai, grok, anthropic, ollama, or groq")
  .option("--session <id>", "resume a saved Forge session")
  .option("--verbose", "print raw tool output alongside formatted summaries")
  .option("--workspace <path>", "root workspace directory")
  .option("-p, --non-interactive", "Run in non-interactive mode without TUI prompts or spinners")
  .action(
    async (
      task: string | undefined,
      options: {
        allowWrite?: boolean;
        allowExecute?: boolean;
        maxSteps: string;
        commandTimeout: string;
        provider?: string;
        session?: string;
        verbose?: boolean;
        workspace?: string;
        nonInteractive?: boolean;
        continue?: boolean;
      },
    ) => {
      const globalConfig = await loadGlobalConfig();
      process.env.FORGE_CLI_ROOT = globalConfig.forgePath || homedir();

      const workspace = await promptWorkspace(options.workspace);
      const workspacePath = path.resolve(process.cwd(), workspace);
      await mkdir(workspacePath, { recursive: true });

      if (!task && !options.session) {
        console.error("Error: Please provide a task argument or a --session <id> to resume.");
        process.exitCode = 1;
        return;
      }
      const apiKey = process.env.FORGE_API_KEY;
      const model = process.env.FORGE_MODEL;
      const provider = (options.provider ??
        process.env.FORGE_PROVIDER ??
        "openrouter") as ProviderKind;
      if (!model) throw new Error("Set FORGE_MODEL before using the agent command.");
      const registry = new ToolRegistry();
      for (const tool of BUILTIN_TOOLS) {
        registry.register(tool);
      }
      await loadExternalTools(registry, workspacePath);
      const agent = new CodingAgent(
        createProvider({
          provider,
          ...(apiKey ? { apiKey } : {}),
          model,
          ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}),
        }),
        registry,
      );

      const defaultPerms = globalConfig.defaultPermissions || [];
      const hasAllowWrite = options.allowWrite ?? defaultPerms.includes("write");
      const hasAllowExecute = options.allowExecute ?? defaultPerms.includes("execute");

      const permissions = [
        "read",
        hasAllowWrite ? "write" : undefined,
        hasAllowExecute ? "execute" : undefined,
      ].filter((value): value is "read" | "write" | "execute" => value !== undefined);

      const store = new SessionStore(workspacePath);
      let sessionId = options.session ?? crypto.randomUUID();
      let loadedSession: StoredSession | undefined;
      let history: ModelMessage[] = [];

      if (options.continue && !options.session) {
        const sessions = await store.list();
        const currentPath = path.resolve(process.cwd());
        const matched = sessions.filter(
          (s) => s.repositoryPath && path.resolve(s.repositoryPath) === currentPath,
        );
        const latest = matched.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )[0];
        if (latest) {
          options.session = latest.id;
          sessionId = latest.id;
        } else {
          console.warn("⚠️ No saved sessions found to resume. Starting a new session.");
        }
      }

      if (options.session) {
        try {
          loadedSession = await store.load(options.session);
          history = loadedSession.messages ?? [];
          agent.totalInputTokens = loadedSession.totalInputTokens ?? 0;
          agent.totalOutputTokens = loadedSession.totalOutputTokens ?? 0;
          if (task) {
            history.push({ role: "user", content: task });
          }
        } catch (error) {
          console.error(`Error: Saved session "${options.session}" not found or failed to load.`);
          process.exitCode = 1;
          return;
        }
      }

      const agentTask = task ?? loadedSession?.task ?? "";
      const runtime = new AgentRuntime();
      const taskId = sessionId;

      // Persist events to .events.jsonl file
      runtime.events.subscribe(async (event) => {
        await store.appendEvent(sessionId, event).catch(() => {});
      });

      const stepPermissions: ("write" | "execute")[] = [];
      const approvalPermissions = permissions.filter((p): p is "write" | "execute" => p !== "read");
      const onApproveCommand = makeOnApproveCommand(
        approvalPermissions,
        stepPermissions,
        options.nonInteractive,
      );
      const onApproveFileChange = makeOnApproveFileChange(
        approvalPermissions,
        stepPermissions,
        options.nonInteractive,
      );

      const controller = new AbortController();
      const cancel = () => {
        log.warn("Cancelling agent…");
        controller.abort();
      };
      process.once("SIGINT", cancel);

      try {
        const ctxResult = await new RepositoryContextBuilder().buildStructured(workspacePath);
        const repositoryContext = ctxResult.text;
        const bannerParts = [
          pc.dim(model),
          ctxResult.gitBranch ? pc.gray(`⎇ ${ctxResult.gitBranch}`) : null,
          ctxResult.testCommand ? pc.dim(ctxResult.testCommand) : null,
        ].filter(Boolean) as string[];

        if (!options.nonInteractive) {
          intro(
            `${pc.bold(pc.cyanBright("⚡ forge"))}  ${pc.gray("│")}  ${bannerParts.join(`  ${pc.gray("│")}  `)}`,
          );
          log.info(`${pc.dim(`Session ${pc.gray(`${taskId.slice(0, 8)}…`)}`)}`);
        }

        // Save initial session state so it is immediately listable and resumable
        await store
          .save({
            id: sessionId,
            task: loadedSession?.task ?? agentTask,
            repositoryPath: workspacePath,
            createdAt: loadedSession?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: agent.messages,
            totalInputTokens: agent.totalInputTokens,
            totalOutputTokens: agent.totalOutputTokens,
          })
          .catch(() => {});

        runtime.events.publish({
          type: "task.created",
          taskId,
          goal: agentTask,
          timestamp: new Date().toISOString(),
        });

        let stepHadContent = false;
        let agentStreamedText = "";
        const spinnerObj = options.nonInteractive
          ? ({ start: () => {}, stop: () => {}, message: () => {} } as unknown as ReturnType<
              typeof spinner
            >)
          : spinner();

        const config = await loadConfig(workspacePath);
        const pricing = getModelPricing(model, config.pricing);

        let answer = "";
        try {
          answer = await agent.run(
            agentTask,
            {
              repositoryPath: workspacePath,
              allowedPermissions: permissions,
              commandTimeoutMs: Number(options.commandTimeout) * 1000,
              signal: controller.signal,
              taskId,
              onApproveCommand,
              onApproveFileChange,
            },
            {
              maxSteps: Number(options.maxSteps),
              repositoryContext,
              history,
              pricing,
              onStepLimitReached: makeOnStepLimitReached(spinnerObj, options.nonInteractive),
              onEvent: makeOnEventHandler(
                spinnerObj,
                runtime,
                taskId,
                {
                  getStreamedText: () => agentStreamedText,
                  setStreamedText: (t) => {
                    agentStreamedText = t;
                  },
                  hadContent: () => stepHadContent,
                  setHadContent: (v) => {
                    stepHadContent = v;
                  },
                },
                options.nonInteractive,
              ),
            },
          );
        } finally {
          spinnerObj.stop();
          const sessionToSave: StoredSession = {
            id: sessionId,
            task: loadedSession?.task ?? agentTask,
            repositoryPath: workspacePath,
            createdAt: loadedSession?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: agent.messages,
            totalInputTokens: agent.totalInputTokens,
            totalOutputTokens: agent.totalOutputTokens,
          };
          if (answer) {
            sessionToSave.result = answer;
          }
          await store.save(sessionToSave).catch(() => {});
        }

        runtime.events.publish({
          type: "task.completed",
          taskId,
          result: answer,
          timestamp: new Date().toISOString(),
        });

        await store.save({
          id: sessionId,
          task: loadedSession?.task ?? agentTask,
          repositoryPath: workspacePath,
          result: answer,
          createdAt: loadedSession?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: agent.messages,
          totalInputTokens: agent.totalInputTokens,
          totalOutputTokens: agent.totalOutputTokens,
        });

        if (!options.nonInteractive) {
          // Content was already streamed live; show only the metadata footer
          const metaLines: string[] = [];
          const filesMatch = answer.match(
            /\*\*Files modified:\*\*\n([\s\S]*?)(?=\n\n|\n\*\*Tokens|$)/,
          );
          if (filesMatch) metaLines.push(filesMatch[0]);
          const tokensMatch = answer.match(/\*\*Tokens used:\*\*.+/);
          if (tokensMatch) metaLines.push(tokensMatch[0]);
          if (metaLines.length > 0) console.log(renderMarkdown(metaLines.join("\n")));
          else console.log("Done.");
          log.info(`Session saved: ${sessionId.slice(0, 8)}… (.forge/sessions/${sessionId}.json)`);
        } else {
          // In non-interactive mode, print files modified and tokens used/cost to stderr
          const filesMatch = answer.match(
            /\*\*Files modified:\*\*\n([\s\S]*?)(?=\n\n|\n\*\*Tokens|$)/,
          );
          if (filesMatch) process.stderr.write(`\n${filesMatch[0]}\n`);
          const tokensMatch = answer.match(/\*\*Tokens used:\*\*.+/);
          if (tokensMatch) {
            process.stderr.write(`\n${tokensMatch[0].replace(/\*\*/g, "")}\n`);
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          console.log("\n🛑 Agent run cancelled.");
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          runtime.events.publish({
            type: "task.failed",
            taskId,
            error: errorMsg,
            timestamp: new Date().toISOString(),
          });
          throw error;
        }
      } finally {
        process.removeListener("SIGINT", cancel);
      }
    },
  );

class PastedMultiLinePrompt extends MultiLinePrompt {
  #inPaste = false;
  #lastCharTime = 0;
  // biome-ignore lint/suspicious/noExplicitAny: timeout handle
  #pasteTimeout: any = null;

  // biome-ignore lint/suspicious/noExplicitAny: subclass options casting
  constructor(opts: any) {
    super({ ...opts, showSubmit: false });

    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      // If a chunk is larger than 1 character and contains newline, it's definitely a paste!
      if (str.length > 1 && (str.includes("\n") || str.includes("\r"))) {
        this.#inPaste = true;
      }
      if (str.includes("\x1b[200~")) {
        this.#inPaste = true;
      }
      if (str.includes("\x1b[201~")) {
        this.#inPaste = false;
      }
    };

    this.input.on("data", onData);

    // biome-ignore lint/suspicious/noExplicitAny: keyOpts object
    this.on("key", (char: string | undefined, keyOpts: any) => {
      const now = Date.now();
      const elapsed = now - this.#lastCharTime;
      this.#lastCharTime = now;

      // If characters are coming in extremely fast (< 8ms apart), it's a paste
      if (elapsed < 8) {
        this.#inPaste = true;
      }

      clearTimeout(this.#pasteTimeout);
      this.#pasteTimeout = setTimeout(() => {
        this.#inPaste = false;
      }, 50);
    });

    const cleanup = () => {
      process.stdout.write("\x1b[?2004l"); // Disable bracketed paste
      this.input.removeListener("data", onData);
      clearTimeout(this.#pasteTimeout);
    };

    this.once("submit", cleanup);
    this.once("cancel", cleanup);
  }

  _shouldSubmit(key: string | undefined, keyOpts: unknown) {
    if (this.#inPaste) {
      const input = this.userInput;
      const cursor = this.cursor;
      this._setUserInput(`${input.slice(0, cursor)}\n${input.slice(cursor)}`);
      // @ts-ignore
      this._cursor = cursor + 1;
      return false;
    }
    return true;
  }
}

async function getPastedMultilineInput(): Promise<string | symbol> {
  process.stdout.write("\x1b[?2004h"); // Enable bracketed paste

  const prompt = new PastedMultiLinePrompt({
    message: "Forge>",
    render() {
      const lineBar = pc.cyan("│  ");
      const activeBar = pc.cyan("◇  ");
      const submitBar = pc.green("✔  ");
      const cancelBar = pc.red("■  ");

      let sym = activeBar;
      let bar = lineBar;

      if (this.state === "submit") {
        sym = submitBar;
        bar = pc.gray("│  ");
      } else if (this.state === "cancel") {
        sym = cancelBar;
        bar = pc.gray("│  ");
      } else if (this.state === "error") {
        sym = pc.yellow("▲  ");
        bar = pc.yellow("│  ");
      }

      const title = `${sym}${pc.bold("Forge>")}`;
      const inputLines = this.userInputWithCursor
        .split("\n")
        .map((line: string) => bar + line)
        .join("\n");

      if (this.state === "submit") {
        return `${title}\n${bar}${pc.dim((this.value as string) ?? this.userInput)}`;
      }
      if (this.state === "cancel") {
        return `${title}\n${bar}${pc.red("Cancelled")}`;
      }

      return `${title}\n${inputLines}\n${pc.cyan("└")}`;
    },
  });

  const res = await prompt.prompt();
  return res ?? "";
}

program
  .command("chat")
  .description("Start an interactive chat session with the coding agent")
  .option("--allow-write", "allow file writes")
  .option("--allow-execute", "allow shell commands")
  .option("--max-steps <number>", "maximum agent steps per prompt", "60")
  .option("--command-timeout <seconds>", "shell-command timeout", "60")
  .option("--provider <name>", "openrouter, openai, grok, anthropic, ollama, or groq")
  .option("--session <id>", "resume a saved Forge session")
  .option("-c, --continue", "resume the most recent saved session")
  .option("--verbose", "print raw tool output alongside formatted summaries")
  .option("--workspace <path>", "root workspace directory")
  .action(runChatAction);

interface ChatOptions {
  allowWrite?: boolean;
  allowExecute?: boolean;
  maxSteps: string;
  commandTimeout: string;
  provider?: string;
  session?: string;
  continue?: boolean;
  verbose?: boolean;
  workspace?: string;
}

async function runChatAction(options: ChatOptions) {
  const globalConfig = await loadGlobalConfig();
  process.env.FORGE_CLI_ROOT = globalConfig.forgePath || homedir();

  const workspacePath = path.resolve(process.cwd(), await promptWorkspace(options.workspace));
  await mkdir(workspacePath, { recursive: true });
  const apiKey = process.env.FORGE_API_KEY;
  let currentModel = process.env.FORGE_MODEL ?? "";
  let currentProvider = (options.provider ??
    process.env.FORGE_PROVIDER ??
    "openrouter") as ProviderKind;
  if (!currentModel) throw new Error("Set FORGE_MODEL before using the agent command.");
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) {
    registry.register(tool);
  }
  await loadExternalTools(registry, workspacePath);
  let agent = new CodingAgent(
    createProvider({
      provider: currentProvider,
      ...(apiKey ? { apiKey } : {}),
      model: currentModel,
      ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}),
    }),
    registry,
  );

  const defaultPerms = globalConfig.defaultPermissions || [];
  const hasAllowWrite = options.allowWrite ?? defaultPerms.includes("write");
  const hasAllowExecute = options.allowExecute ?? defaultPerms.includes("execute");

  const permissions = [
    "read",
    hasAllowWrite ? "write" : undefined,
    hasAllowExecute ? "execute" : undefined,
  ].filter((value): value is "read" | "write" | "execute" => value !== undefined);

  const store = new SessionStore(workspacePath);
  let sessionId: string = crypto.randomUUID();
  let loadedSession: StoredSession | undefined;

  if (options.continue && !options.session) {
    const sessions = await store.list();
    const currentPath = path.resolve(process.cwd());
    const matched = sessions.filter(
      (s) => s.repositoryPath && path.resolve(s.repositoryPath) === currentPath,
    );
    const latest = matched.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0];
    if (latest) {
      options.session = latest.id;
    } else {
      log.warn("⚠️ No saved sessions found to resume. Starting a new session.");
    }
  }

  if (options.session) {
    try {
      loadedSession = await store.load(options.session);
      sessionId = options.session;
      agent.messages = loadedSession.messages ?? [];
      agent.totalInputTokens = loadedSession.totalInputTokens ?? 0;
      agent.totalOutputTokens = loadedSession.totalOutputTokens ?? 0;
      log.info(
        `🌿 Resumed session ${pc.dim(sessionId.slice(0, 8))}… ${pc.gray(`"${loadedSession.task}"`)}`,
      );
    } catch (error) {
      console.error(`Error: Saved session "${options.session}" not found or failed to load.`);
      process.exitCode = 1;
      return;
    }
  }

  const runtime = new AgentRuntime();
  const taskId = sessionId;

  // Persist events to .events.jsonl file
  runtime.events.subscribe(async (event) => {
    await store.appendEvent(sessionId, event).catch(() => {});
  });

  let activeController: AbortController | undefined;
  let isAgentRunning = false;
  let lastCheckpoint: string | undefined = undefined;
  let historyLengthBefore = 0;

  const stepPermissions: ("write" | "execute")[] = [];
  const approvalPermissions = permissions.filter((p): p is "write" | "execute" => p !== "read");
  const onApproveCommand = makeOnApproveCommand(approvalPermissions, stepPermissions);
  const onApproveFileChange = makeOnApproveFileChange(approvalPermissions, stepPermissions);

  const sigintHandler = () => {
    process.stdout.write("\x1b[?2004l"); // Disable paste mode
    if (isAgentRunning && activeController) {
      log.warn("🛑 Cancelling agent run...");
      activeController.abort();
      activeController = undefined;
    }
  };
  process.on("SIGINT", sigintHandler);
  process.on("exit", () => {
    process.stdout.write("\x1b[?2004l"); // Disable paste mode
  });

  try {
    const ctxResult = await new RepositoryContextBuilder().buildStructured(workspacePath);
    const repositoryContext = ctxResult.text;
    const bannerParts = [
      pc.dim(currentModel),
      ctxResult.gitBranch ? pc.gray(`⎇ ${ctxResult.gitBranch}`) : null,
      ctxResult.testCommand ? pc.dim(ctxResult.testCommand) : null,
    ].filter(Boolean) as string[];

    intro(
      `${pc.bold(pc.cyanBright("⚡ forge"))}  ${pc.gray("│")}  ${bannerParts.join(`  ${pc.gray("│")}  `)}`,
    );
    log.info(`${pc.dim(`Session ${pc.gray(`${taskId.slice(0, 8)}…`)}`)}`);

    // REPL loop
    while (true) {
      const input = await getPastedMultilineInput();
      if (isCancel(input)) {
        outro("Exit chat session.");
        break;
      }
      if (typeof input !== "string") continue;

      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("/")) {
        if (input === "/exit" || input === "/quit") {
          outro("Exit chat session.");
          break;
        }
        if (input === "/help") {
          note(
            [
              `${pc.cyan("/exit")}, ${pc.cyan("/quit")}   Exit the chat session`,
              `${pc.cyan("/new")}           Start a new clean session`,
              `${pc.cyan("/resume")} [id]   List saved sessions or restore one`,
              `${pc.cyan("/provider")} [p] [m]  Switch provider/model`,
              `${pc.cyan("/model")} [name]  Switch model for current provider`,
              `${pc.cyan("/status")}        Show session info & memory facts`,
              `${pc.cyan("/compact")}       Manually compress older history`,
              `${pc.cyan("/cost")}          Show cumulative session token usage/costs`,
              `${pc.cyan("/history")}       Print active message history`,
              `${pc.cyan("/diff")}          View unstaged git changes`,
              `${pc.cyan("/commit")}        Auto-generate a commit message`,
              `${pc.cyan("/undo")}          Revert last prompt's workspace changes`,
              `${pc.cyan("/reset")}         Clear active chat history`,
            ].join("\n"),
            "⚡ forge  commands",
          );
          continue;
        }
        if (input === "/status") {
          const msgCount = agent.messages.length;
          const { MemoryStore: MS } = await import("@forge/memory");
          const facts = await MS.load(workspacePath);
          const factCount = Object.keys(facts).length;
          const config = await loadConfig(workspacePath);
          const pricing = getModelPricing(currentModel, config.pricing);
          const cost = calculateCost(agent.totalInputTokens, agent.totalOutputTokens, pricing);
          log.info(
            `📊 Session Status\n  Session ID : ${sessionId}\n  Provider   : ${currentProvider}\n  Model      : ${currentModel}\n  Messages   : ${msgCount}\n  Branch     : ${ctxResult.gitBranch ?? "(not a git repo)"}\n  Memory     : ${factCount} fact(s) stored\n  Session Cost: $${cost.toFixed(4)} (${agent.totalInputTokens.toLocaleString()} in / ${agent.totalOutputTokens.toLocaleString()} out)`,
          );
          continue;
        }
        if (input === "/compact") {
          const { beforeCount, afterCount } = agent.compactHistory();
          if (beforeCount === afterCount) {
            log.info("No older message pairs available for context compaction.");
          } else {
            log.success(
              `Context compacted! Reduced active history from ${beforeCount} to ${afterCount} messages.`,
            );
          }
          continue;
        }
        if (input === "/cost") {
          const config = await loadConfig(workspacePath);
          const pricing = getModelPricing(currentModel, config.pricing);
          const cost = calculateCost(agent.totalInputTokens, agent.totalOutputTokens, pricing);
          log.info(
            `💸 Session Cost Summary (${currentModel})\n` +
              `  Input Tokens  : ${agent.totalInputTokens.toLocaleString()} ($${pricing.inputPerMillion.toFixed(2)}/M) -> $${((agent.totalInputTokens / 1_000_000) * pricing.inputPerMillion).toFixed(4)}\n` +
              `  Output Tokens : ${agent.totalOutputTokens.toLocaleString()} ($${pricing.outputPerMillion.toFixed(2)}/M) -> $${((agent.totalOutputTokens / 1_000_000) * pricing.outputPerMillion).toFixed(4)}\n` +
              `  Estimated Cost: $${cost.toFixed(4)}`,
          );
          continue;
        }
        if (input.startsWith("/provider")) {
          const parts = input.split(" ");
          let nextProvider = parts[1]?.trim() as ProviderKind | undefined;
          let nextModel = parts[2]?.trim();
          let nextApiKey = apiKey;
          let nextUrl = process.env.FORGE_BASE_URL || "";

          if (!nextProvider) {
            // Interactive setup!
            const chosenProvider = await select({
              message: "Select provider",
              options: [
                { value: "openrouter", label: "OpenRouter" },
                { value: "openai", label: "OpenAI" },
                { value: "grok", label: "Grok (xAI)" },
                { value: "anthropic", label: "Anthropic" },
                { value: "ollama", label: "Ollama (Local)" },
                { value: "groq", label: "Groq" },
              ],
              initialValue: currentProvider,
            });
            if (isCancel(chosenProvider)) continue;
            nextProvider = chosenProvider as ProviderKind;

            // Model name
            let defaultModel = currentModel;
            if (nextProvider !== currentProvider) {
              if (nextProvider === "openrouter") defaultModel = "openrouter/auto";
              else if (nextProvider === "openai") defaultModel = "gpt-4o";
              else if (nextProvider === "anthropic") defaultModel = "claude-3-5-sonnet-20241022";
              else if (nextProvider === "grok") defaultModel = "grok-beta";
              else if (nextProvider === "ollama") defaultModel = "llama3";
              else if (nextProvider === "groq") defaultModel = "mixtral-8x7b-32768";
            }

            const chosenModel = await text({
              message: "Enter model name",
              defaultValue: defaultModel,
              placeholder: defaultModel,
            });
            if (isCancel(chosenModel)) continue;
            nextModel = String(chosenModel).trim();

            // API Key (skip for ollama)
            if (nextProvider !== "ollama") {
              const envVar = `FORGE_${nextProvider.toUpperCase()}_API_KEY`;
              const existingKey = process.env[envVar] || apiKey || "";
              const keyInput = await text({
                message: `Enter API Key (prefilled with ${envVar} if set)`,
                defaultValue: existingKey,
                placeholder: existingKey ? "••••••••" : "paste your key here",
              });
              if (isCancel(keyInput)) continue;
              nextApiKey = String(keyInput).trim();
            }

            // Custom Base URL / Endpoint
            let defaultBaseUrl = nextUrl;
            if (nextProvider !== currentProvider || !defaultBaseUrl) {
              if (nextProvider === "openrouter") defaultBaseUrl = "https://openrouter.ai/api/v1";
              else if (nextProvider === "openai") defaultBaseUrl = "https://api.openai.com/v1";
              else if (nextProvider === "grok") defaultBaseUrl = "https://api.x.ai/v1";
              else if (nextProvider === "anthropic")
                defaultBaseUrl = "https://api.anthropic.com/v1";
              else if (nextProvider === "ollama") defaultBaseUrl = "http://localhost:11434/v1";
              else if (nextProvider === "groq") defaultBaseUrl = "https://api.groq.com/openai/v1";
            }

            const urlInput = await text({
              message: "Enter custom Base URL / Endpoint (optional)",
              defaultValue: defaultBaseUrl,
              placeholder: defaultBaseUrl,
            });
            if (isCancel(urlInput)) continue;
            nextUrl = String(urlInput).trim();
          }

          currentProvider = nextProvider;
          if (nextModel) currentModel = nextModel;

          // Re-instantiate agent with new provider details
          const oldMessages = agent.messages;
          const oldInput = agent.totalInputTokens;
          const oldOutput = agent.totalOutputTokens;
          agent = new CodingAgent(
            createProvider({
              provider: currentProvider,
              model: currentModel,
              ...(nextApiKey ? { apiKey: nextApiKey } : {}),
              ...(nextUrl ? { baseUrl: nextUrl } : {}),
            }),
            registry,
          );
          agent.messages = oldMessages;
          agent.totalInputTokens = oldInput;
          agent.totalOutputTokens = oldOutput;
          log.success(`🔌 Switched provider to ${currentProvider} (Model: ${currentModel})`);
          continue;
        }
        if (input.startsWith("/model")) {
          const parts = input.split(" ");
          let nextModel = parts[1]?.trim();

          if (!nextModel) {
            const modelInput = await text({
              message: "Enter model name",
              defaultValue: currentModel,
              placeholder: currentModel,
            });
            if (isCancel(modelInput)) continue;
            nextModel = String(modelInput).trim();
          }

          currentModel = nextModel;

          // Re-instantiate agent with new model
          const oldMessages = agent.messages;
          const oldInput = agent.totalInputTokens;
          const oldOutput = agent.totalOutputTokens;
          agent = new CodingAgent(
            createProvider({
              provider: currentProvider,
              model: currentModel,
              ...(apiKey ? { apiKey } : {}),
              ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}),
            }),
            registry,
          );
          agent.messages = oldMessages;
          agent.totalInputTokens = oldInput;
          agent.totalOutputTokens = oldOutput;
          log.success(`🧠 Switched model to ${currentModel}`);
          continue;
        }
        if (input === "/new") {
          agent.messages = [];
          agent.totalInputTokens = 0;
          agent.totalOutputTokens = 0;
          sessionId = crypto.randomUUID();
          loadedSession = undefined;
          log.success(`✨ New session started (ID: ${sessionId}).`);
          continue;
        }
        if (input.startsWith("/resume")) {
          const parts = input.split(" ");
          const targetId = parts[1]?.trim();
          if (targetId) {
            try {
              const resumedSession = await store.load(targetId);
              agent.messages = resumedSession.messages ?? [];
              agent.totalInputTokens = resumedSession.totalInputTokens ?? 0;
              agent.totalOutputTokens = resumedSession.totalOutputTokens ?? 0;
              sessionId = targetId;
              loadedSession = resumedSession;
              log.success(`🌿 Resumed session ${targetId}`);
            } catch {
              log.error(`⚠️ Saved session "${targetId}" not found.`);
            }
          } else {
            const sessions = await store.list();
            if (sessions.length === 0) {
              log.info("No saved sessions.");
            } else {
              log.info("Saved sessions (use '/resume <id>'):");
              for (const s of sessions) {
                console.log(`  ${s.id} - ${s.updatedAt} - ${s.task}`);
              }
            }
          }
          continue;
        }
        if (input === "/history") {
          if (agent.messages.length === 0) {
            log.info("(no messages in current session)");
          } else {
            console.log(`\n📜 Session history (${agent.messages.length} messages):`);
            for (const [idx, msg] of agent.messages.entries()) {
              const role = msg.role.padEnd(10);
              const preview =
                typeof msg.content === "string"
                  ? msg.content.slice(0, 120).replace(/\n/g, " ")
                  : msg.toolCalls
                    ? `[${msg.toolCalls.map((c) => c.name).join(", ")}]`
                    : "(empty)";
              console.log(
                `  ${String(idx + 1).padStart(3)}. [${role}] ${preview}${(msg.content?.length ?? 0) > 120 ? "…" : ""}`,
              );
            }
          }
          continue;
        }
        if (input === "/diff") {
          const diffResult = await registry.execute(
            "git_diff",
            { staged: false },
            { repositoryPath: workspacePath },
          );
          const d = diffResult.data as { stdout?: string; stderr?: string } | undefined;
          const diffText = d?.stdout?.trim();
          if (!diffText) {
            log.info("No unstaged changes.");
          } else {
            note(diffText, "git diff");
          }
          continue;
        }
        if (input === "/reset") {
          agent.messages = [];
          agent.totalInputTokens = 0;
          agent.totalOutputTokens = 0;
          log.success("Chat history and token counts cleared.");
          continue;
        }
        if (input === "/commit") {
          const diff = await execGit(workspacePath, ["diff", "HEAD"]);
          if (!diff) {
            log.info("No changes to commit.");
            continue;
          }

          const commitSpinner = spinner();
          commitSpinner.start("generating commit message…");
          try {
            const response = await agent.model.complete({
              messages: [
                {
                  role: "system",
                  content:
                    "You are an expert Git commit message generator. Generate a concise Conventional Commit message (one line) based on the provided diff. Output ONLY the raw message string with no surrounding quotes, markdown block, prefix, or explanation.",
                },
                {
                  role: "user",
                  content: `Here is the git diff:\n\n${diff}`,
                },
              ],
              tools: [],
            });
            commitSpinner.stop();
            const commitMsg = response.content.trim().replace(/^["']|["']$/g, "");
            if (!commitMsg) {
              log.error("⚠️ Could not generate a commit message.");
            } else {
              const confirmed = await ynPrompt(
                `⚠️ Proposing commit: "${commitMsg}"\nCommit all changes?`,
              );
              if (confirmed) {
                await execGit(workspacePath, ["add", "-A"]);
                const commitRes = await execGit(workspacePath, ["commit", "-m", commitMsg]);
                log.success(commitRes || "Changes committed successfully.");
              } else {
                log.info("Commit aborted.");
              }
            }
          } catch (err) {
            commitSpinner.stop();
            log.error(
              `⚠️ Error generating commit message: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          continue;
        }
        if (input === "/undo") {
          if (!lastCheckpoint) {
            log.info("No checkpoint available to revert to.");
          } else {
            const confirmed = await ynPrompt(
              "⚠️ Revert all recent changes and REPL history from the last prompt?",
            );
            if (confirmed) {
              // Revert workspace
              await execGit(workspacePath, ["reset", "--hard", "HEAD"]);
              await execGit(workspacePath, ["clean", "-fd"]);
              if (lastCheckpoint !== "clean") {
                await execGit(workspacePath, ["stash", "apply", lastCheckpoint]);
              }
              // Revert chat history
              agent.messages = agent.messages.slice(0, historyLengthBefore);
              log.success("Workspace and chat history reverted successfully.");
            } else {
              log.info("Undo aborted.");
            }
          }
          continue;
        }

        log.warn(`⚠️ Unknown command: ${trimmed}`);
        continue;
      }

      // Save checkpoints before the agent run starts
      historyLengthBefore = agent.messages.length;
      lastCheckpoint = await execGit(workspacePath, ["stash", "create"]).then((h) => h || "clean");

      // Save initial session state so it is immediately listable and resumable
      await store
        .save({
          id: sessionId,
          task: loadedSession?.task ?? input,
          repositoryPath: workspacePath,
          createdAt: loadedSession?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: agent.messages,
          totalInputTokens: agent.totalInputTokens,
          totalOutputTokens: agent.totalOutputTokens,
        })
        .catch(() => {});

      runtime.events.publish({
        type: "task.created",
        taskId,
        goal: input,
        timestamp: new Date().toISOString(),
      });

      stepPermissions.length = 0;
      isAgentRunning = true;
      activeController = new AbortController();
      let chatStepHadContent = false;
      let chatStreamedText = "";
      const taskSpinner = spinner();

      try {
        const config = await loadConfig(workspacePath);
        const pricing = getModelPricing(currentModel, config.pricing);

        const answer = await agent.run(
          input,
          {
            repositoryPath: workspacePath,
            allowedPermissions: permissions,
            commandTimeoutMs: Number(options.commandTimeout) * 1000,
            signal: activeController.signal,
            taskId,
            onApproveCommand,
            onApproveFileChange,
          },
          {
            maxSteps: Number(options.maxSteps),
            repositoryContext,
            history: agent.messages,
            continueChat: true,
            pricing,
            onStepLimitReached: makeOnStepLimitReached(taskSpinner),
            onEvent: makeOnEventHandler(taskSpinner, runtime, taskId, {
              getStreamedText: () => chatStreamedText,
              setStreamedText: (t) => {
                chatStreamedText = t;
              },
              hadContent: () => chatStepHadContent,
              setHadContent: (v) => {
                chatStepHadContent = v;
              },
            }),
          },
        );
        runtime.events.publish({
          type: "task.completed",
          taskId,
          result: answer,
          timestamp: new Date().toISOString(),
        });

        loadedSession = {
          id: sessionId,
          task: loadedSession?.task ?? input,
          repositoryPath: workspacePath,
          result: answer,
          createdAt: loadedSession?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: agent.messages,
          totalInputTokens: agent.totalInputTokens,
          totalOutputTokens: agent.totalOutputTokens,
        };
        await store.save(loadedSession);

        // Content was already streamed live; show only metadata
        const chatTokensMatch = answer.match(/\*\*Tokens used:\*\*.+/);
        if (chatTokensMatch) {
          log.info(`📊 ${chatTokensMatch[0].replace(/\*\*/g, "")}`);
        }
        const chatFilesMatch = answer.match(
          /\*\*Files modified:\*\*\n([\s\S]*?)(?=\n\n|\n\*\*Tokens|$)/,
        );
        if (chatFilesMatch) {
          console.log(renderMarkdown(chatFilesMatch[0]));
        }
      } catch (error) {
        // Suppress AbortError from Ctrl+C cancellation
        if (error instanceof DOMException && error.name === "AbortError") {
          log.info("🛑 Agent run cancelled.");
        } else {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`⚠️ Error running task: ${errorMsg}`);
          runtime.events.publish({
            type: "task.failed",
            taskId,
            error: errorMsg,
            timestamp: new Date().toISOString(),
          });
        }
      } finally {
        taskSpinner.stop();
        isAgentRunning = false;
        activeController = undefined;
        const sessionToSave: StoredSession = {
          id: sessionId,
          task: loadedSession?.task ?? input,
          repositoryPath: workspacePath,
          createdAt: loadedSession?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: agent.messages,
          totalInputTokens: agent.totalInputTokens,
          totalOutputTokens: agent.totalOutputTokens,
        };
        if (loadedSession?.result) {
          sessionToSave.result = loadedSession.result;
        }
        await store.save(sessionToSave).catch(() => {});
      }
    }
  } finally {
    process.off("SIGINT", sigintHandler);
  }
}

program
  .command("init")
  .description("Scaffold a FORGE.md project-guidelines file in the current directory")
  .option("--force", "overwrite existing guidelines file without prompting")
  .action(async (options: { force?: boolean }) => {
    const { handleInitCommand } = await import("./init");
    await handleInitCommand(options);
  });

program
  .command("health")
  .description("Report Forge runtime, configuration, and repository health")
  .action(async () => {
    const runtime = new AgentRuntime();
    const report = await runtime.healthCheck(process.cwd());
    intro(`${pc.bold(pc.cyanBright("⚡ forge"))}  ${pc.gray("│")}  health`);
    for (const check of report.checks) {
      const detail = `${pc.bold(check.name)}: ${pc.dim(check.detail)}`;
      if (check.status === "pass") log.success(detail);
      else if (check.status === "warn") log.warn(detail);
      else log.error(detail);
    }
    if (report.status === "unhealthy") {
      outro(pc.red("Status: unhealthy"));
      process.exitCode = 1;
    } else {
      outro(pc.green("Status: healthy"));
    }
  });

program
  .command("sessions")
  .description("List saved Forge sessions")
  .action(async () => {
    const sessions = await new SessionStore(sessionsRoot()).list();
    if (sessions.length === 0) {
      log.info("No saved sessions.");
      return;
    }
    const sorted = sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const rows = sorted
      .map(
        (s) =>
          `${pc.dim(s.id.slice(0, 8))}…  ${pc.gray(s.updatedAt.slice(0, 10))}  ${pc.cyan(s.task.slice(0, 60))}`,
      )
      .join("\n");
    note(rows, `${sorted.length} saved session(s)`);
  });

program
  .command("session <id>")
  .description("Show a saved Forge session")
  .action(async (id: string) => {
    try {
      const session = await new SessionStore(sessionsRoot()).load(id);
      note(JSON.stringify(session, null, 2), `Session ${id.slice(0, 8)}…`);
    } catch (err) {
      log.error(
        `Session "${id}" not found or corrupt: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  });

program.parse();
