#!/usr/bin/env bun

import * as readline from "node:readline";
import { CodingAgent } from "@forge/agent";
import { RepositoryContextBuilder } from "@forge/context";
import { type ProviderKind, createProvider } from "@forge/models";
import { AgentRuntime } from "@forge/runtime";
import { SessionStore, type StoredSession } from "@forge/session";
import {
  ToolRegistry,
  applyPatchTool,
  findFilesTool,
  formatToolResult,
  gitBlameTool,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
  listDirectoryTool,
  listSymbolsTool,
  readFileTool,
  replaceTextTool,
  runCommandTool,
  searchCodeTool,
  writeFileTool,
} from "@forge/tools";
import type { ModelMessage } from "@forge/types";
import { Command } from "commander";
import { printHeader, printThinking, printToolEnd, printToolStart, renderMarkdown } from "./tui";

const program = new Command();

program
  .name("forge")
  .description("A modular, terminal-first AI coding-agent runtime")
  .version("0.1.0")
  .action(() => {
    const runtime = new AgentRuntime();
    console.log(`Forge v0.1.0\n\n${runtime.statusMessage()}`);
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
      console.log(formatToolResult("list_symbols", result));
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

program
  .command("agent [task]")
  .description("Run the coding agent with an OpenAI-compatible model provider")
  .option("--allow-write", "allow file writes")
  .option("--allow-execute", "allow shell commands")
  .option("--max-steps <number>", "maximum agent steps", "20")
  .option("--command-timeout <seconds>", "shell-command timeout", "60")
  .option("--provider <name>", "openrouter, openai, grok, anthropic, or ollama")
  .option("--session <id>", "resume a saved Forge session")
  .option("--verbose", "print raw tool output alongside formatted summaries")
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
      },
    ) => {
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
      const tools = [
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
      ];
      for (const tool of tools) {
        registry.register(tool);
      }
      const agent = new CodingAgent(
        createProvider({
          provider,
          ...(apiKey ? { apiKey } : {}),
          model,
          ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}),
        }),
        registry,
      );
      const permissions = [
        options.allowWrite ? "write" : undefined,
        options.allowExecute ? "execute" : undefined,
      ].filter((value): value is "write" | "execute" => value !== undefined);

      const store = new SessionStore(process.cwd());
      const sessionId = options.session ?? crypto.randomUUID();
      let loadedSession: StoredSession | undefined;
      let history: ModelMessage[] = [];
      let plan = "";

      if (options.session) {
        try {
          loadedSession = await store.load(options.session);
          plan = loadedSession.plan;
          history = loadedSession.messages ?? [];
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

      // Interactive command approval callback if not pre-approved
      const onApproveCommand = options.allowExecute
        ? undefined
        : async (cmd: string) => {
            if (!process.stdin.isTTY) {
              return false;
            }
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            return new Promise<boolean>((resolve) => {
              rl.question(
                `\n⚠️  Forge wants to execute command: "${cmd}"\nAllow execution? (y/N): `,
                (answer) => {
                  rl.close();
                  resolve(answer.trim().toLowerCase() === "y");
                },
              );
            });
          };

      const controller = new AbortController();
      const cancel = () => {
        console.log("\nCancelling agent…");
        controller.abort();
      };
      process.once("SIGINT", cancel);

      try {
        const ctxResult = await new RepositoryContextBuilder().buildStructured(process.cwd());
        const repositoryContext = ctxResult.text;
        if (ctxResult.gitBranch) {
          console.log(`🌿 Branch: ${ctxResult.gitBranch}`);
        }
        console.log(`🔬 Test command: ${ctxResult.testCommand}`);

        runtime.events.publish({
          type: "task.created",
          taskId,
          goal: agentTask,
          timestamp: new Date().toISOString(),
        });

        const answer = await agent.run(
          agentTask,
          {
            repositoryPath: process.cwd(),
            allowedPermissions: permissions,
            commandTimeoutMs: Number(options.commandTimeout) * 1000,
            signal: controller.signal,
            taskId,
            ...(onApproveCommand ? { onApproveCommand } : {}),
          },
          {
            maxSteps: Number(options.maxSteps),
            repositoryContext,
            history,
            onEvent: (event) => {
              const now = new Date().toISOString();
              if (event.type === "plan.started") {
                printHeader("Planning Phase");
                runtime.events.publish({ type: "plan.started", taskId, timestamp: now });
              }
              if (event.type === "plan.finished") {
                plan = event.plan;
                console.log(renderMarkdown(plan));
                runtime.events.publish({
                  type: "plan.finished",
                  taskId,
                  plan: event.plan,
                  timestamp: now,
                });
              }
              if (event.type === "model.started") {
                printThinking(event.step);
                runtime.events.publish({
                  type: "model.started",
                  taskId,
                  step: event.step,
                  timestamp: now,
                });
              }
              if (event.type === "model.finished") {
                runtime.events.publish({
                  type: "model.finished",
                  taskId,
                  step: event.step,
                  toolCallCount: event.toolCallCount,
                  timestamp: now,
                });
              }
              if (event.type === "tool.started") {
                printToolStart(event.step, event.toolName);
                runtime.events.publish({
                  type: "tool.started",
                  taskId,
                  step: event.step,
                  toolName: event.toolName,
                  timestamp: now,
                });
              }
              if (event.type === "tool.finished") {
                printToolEnd(event.success);
                runtime.events.publish({
                  type: "tool.finished",
                  taskId,
                  step: event.step,
                  toolName: event.toolName,
                  success: event.success,
                  timestamp: now,
                });
              }
            },
          },
        );

        runtime.events.publish({
          type: "task.completed",
          taskId,
          result: answer,
          timestamp: new Date().toISOString(),
        });

        await store.save({
          id: sessionId,
          task: loadedSession?.task ?? agentTask,
          plan,
          result: answer,
          createdAt: loadedSession?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: agent.messages,
        });

        printHeader("Answer");
        console.log(renderMarkdown(answer));
        console.log(`\nSession saved: .forge/sessions/${sessionId}.json`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        runtime.events.publish({
          type: "task.failed",
          taskId,
          error: errorMsg,
          timestamp: new Date().toISOString(),
        });
        throw error;
      } finally {
        process.removeListener("SIGINT", cancel);
      }
    },
  );

program
  .command("chat")
  .description("Start an interactive chat session with the coding agent")
  .option("--allow-write", "allow file writes")
  .option("--allow-execute", "allow shell commands")
  .option("--max-steps <number>", "maximum agent steps per prompt", "20")
  .option("--command-timeout <seconds>", "shell-command timeout", "60")
  .option("--provider <name>", "openrouter, openai, grok, anthropic, or ollama")
  .option("--session <id>", "resume a saved Forge session")
  .option("--verbose", "print raw tool output alongside formatted summaries")
  .action(
    async (options: {
      allowWrite?: boolean;
      allowExecute?: boolean;
      maxSteps: string;
      commandTimeout: string;
      provider?: string;
      session?: string;
      verbose?: boolean;
    }) => {
      const apiKey = process.env.FORGE_API_KEY;
      const model = process.env.FORGE_MODEL;
      const provider = (options.provider ??
        process.env.FORGE_PROVIDER ??
        "openrouter") as ProviderKind;
      if (!model) throw new Error("Set FORGE_MODEL before using the agent command.");
      const registry = new ToolRegistry();
      const tools = [
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
      ];
      for (const tool of tools) {
        registry.register(tool);
      }
      const agent = new CodingAgent(
        createProvider({
          provider,
          ...(apiKey ? { apiKey } : {}),
          model,
          ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}),
        }),
        registry,
      );
      const permissions = [
        options.allowWrite ? "write" : undefined,
        options.allowExecute ? "execute" : undefined,
      ].filter((value): value is "write" | "execute" => value !== undefined);

      const store = new SessionStore(process.cwd());
      const sessionId = options.session ?? crypto.randomUUID();
      let loadedSession: StoredSession | undefined;
      let plan = "";

      if (options.session) {
        try {
          loadedSession = await store.load(options.session);
          plan = loadedSession.plan;
          agent.messages = loadedSession.messages ?? [];
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

      // Interactive command approval callback if not pre-approved
      const onApproveCommand = options.allowExecute
        ? undefined
        : async (cmd: string) => {
            if (!process.stdin.isTTY) {
              return false;
            }
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            return new Promise<boolean>((resolve) => {
              rl.question(
                `\n⚠️  Forge wants to execute command: "${cmd}"\nAllow execution? (y/N): `,
                (answer) => {
                  rl.close();
                  resolve(answer.trim().toLowerCase() === "y");
                },
              );
            });
          };

      const controller = new AbortController();
      const cancel = () => {
        console.log("\nCancelling agent…");
        controller.abort();
      };
      process.once("SIGINT", cancel);

      try {
        const ctxResult = await new RepositoryContextBuilder().buildStructured(process.cwd());
        const repositoryContext = ctxResult.text;
        if (ctxResult.gitBranch) {
          console.log(`🌿 Branch: ${ctxResult.gitBranch}`);
        }
        console.log(`🔬 Test command: ${ctxResult.testCommand}`);

        console.log(`\n💬 Forge Interactive Chat (Session ID: ${sessionId})`);
        console.log(
          "Type your prompt and press Enter. Special commands: /exit, /quit, /history, /diff, /reset, /help\n",
        );

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const promptUser = () => {
          rl.question("\nForge> ", async (userInput) => {
            const input = userInput.trim();
            if (!input) {
              promptUser();
              return;
            }
            if (input === "/exit" || input === "/quit") {
              rl.close();
              return;
            }
            if (input === "/help") {
              console.log(
                "Available REPL commands:\n" +
                  "  /exit, /quit - Exit the chat session\n" +
                  "  /history     - Print active messages in current chat\n" +
                  "  /diff        - View unstaged repository changes\n" +
                  "  /reset       - Clear active chat history",
              );
              promptUser();
              return;
            }
            if (input === "/history") {
              console.log(JSON.stringify(agent.messages, null, 2));
              promptUser();
              return;
            }
            if (input === "/diff") {
              const diffResult = await registry.execute(
                "git_diff",
                { staged: false },
                { repositoryPath: process.cwd() },
              );
              console.log(formatToolResult("git_diff", diffResult));
              promptUser();
              return;
            }
            if (input === "/reset") {
              agent.messages = [];
              console.log("Chat history cleared.");
              promptUser();
              return;
            }

            runtime.events.publish({
              type: "task.created",
              taskId,
              goal: input,
              timestamp: new Date().toISOString(),
            });

            try {
              const answer = await agent.run(
                input,
                {
                  repositoryPath: process.cwd(),
                  allowedPermissions: permissions,
                  commandTimeoutMs: Number(options.commandTimeout) * 1000,
                  signal: controller.signal,
                  taskId,
                  ...(onApproveCommand ? { onApproveCommand } : {}),
                },
                {
                  maxSteps: Number(options.maxSteps),
                  repositoryContext,
                  history: agent.messages,
                  onEvent: (event) => {
                    const now = new Date().toISOString();
                    if (event.type === "plan.started") {
                      printHeader("Planning Phase");
                      runtime.events.publish({ type: "plan.started", taskId, timestamp: now });
                    }
                    if (event.type === "plan.finished") {
                      plan = event.plan;
                      console.log(renderMarkdown(plan));
                      runtime.events.publish({
                        type: "plan.finished",
                        taskId,
                        plan: event.plan,
                        timestamp: now,
                      });
                    }
                    if (event.type === "model.started") {
                      printThinking(event.step);
                      runtime.events.publish({
                        type: "model.started",
                        taskId,
                        step: event.step,
                        timestamp: now,
                      });
                    }
                    if (event.type === "model.finished") {
                      runtime.events.publish({
                        type: "model.finished",
                        taskId,
                        step: event.step,
                        toolCallCount: event.toolCallCount,
                        timestamp: now,
                      });
                    }
                    if (event.type === "tool.started") {
                      printToolStart(event.step, event.toolName);
                      runtime.events.publish({
                        type: "tool.started",
                        taskId,
                        step: event.step,
                        toolName: event.toolName,
                        timestamp: now,
                      });
                    }
                    if (event.type === "tool.finished") {
                      printToolEnd(event.success);
                      runtime.events.publish({
                        type: "tool.finished",
                        taskId,
                        step: event.step,
                        toolName: event.toolName,
                        success: event.success,
                        timestamp: now,
                      });
                    }
                  },
                },
              );

              runtime.events.publish({
                type: "task.completed",
                taskId,
                result: answer,
                timestamp: new Date().toISOString(),
              });

              await store.save({
                id: sessionId,
                task: loadedSession?.task ?? input,
                plan,
                result: answer,
                createdAt: loadedSession?.createdAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                messages: agent.messages,
              });

              printHeader("Answer");
              console.log(renderMarkdown(answer));
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              console.error(`⚠️ Error running task: ${errorMsg}`);
              runtime.events.publish({
                type: "task.failed",
                taskId,
                error: errorMsg,
                timestamp: new Date().toISOString(),
              });
            }
            promptUser();
          });
        };

        promptUser();

        // Keep process alive during REPL
        await new Promise<void>((resolve) => {
          rl.on("close", resolve);
        });
      } finally {
        process.removeListener("SIGINT", cancel);
      }
    },
  );

program
  .command("health")
  .description("Report Forge runtime, configuration, and repository health")
  .action(async () => {
    const runtime = new AgentRuntime();
    const report = await runtime.healthCheck(process.cwd());
    console.log(`Health: ${report.status}`);
    for (const check of report.checks) {
      const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
      console.log(`  [${marker}] ${check.name}: ${check.detail}`);
    }
    if (report.status === "unhealthy") process.exitCode = 1;
  });

program
  .command("sessions")
  .description("List saved Forge sessions")
  .action(async () => {
    const sessions = await new SessionStore(process.cwd()).list();
    if (sessions.length === 0) {
      console.log("No saved sessions.");
      return;
    }
    for (const session of sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )) {
      console.log(`${session.id}  ${session.updatedAt}  ${session.task}`);
    }
  });

program
  .command("session <id>")
  .description("Show a saved Forge session")
  .action(async (id: string) => {
    console.log(JSON.stringify(await new SessionStore(process.cwd()).load(id), null, 2));
  });

program.parse();
