#!/usr/bin/env bun

import * as path from "node:path";
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
import {
  Spinner,
  clearStreamedText,
  printBanner,
  printHeader,
  printPlanningFooter,
  printPlanningHeader,
  printToolResult,
  renderMarkdown,
  toolArgPreview,
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

function printVisualDiff(filename: string, newContent: string, oldContent?: string): void {
  // Styles
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const cyan = "\x1b[36m";
  const red = "\x1b[31m";
  const green = "\x1b[32m";
  const dim = "\x1b[2m";

  console.log(`\n📄 ${bold}${cyan}Proposed changes to ${filename}:${reset}`);
  if (oldContent === undefined) {
    console.log(`${green}+ (New File: ${Buffer.byteLength(newContent)} bytes)${reset}`);
    return;
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let i = 0;
  let j = 0;
  let printedLines = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (printedLines > 25) {
      console.log(`${dim}... (remaining changes omitted for brevity)${reset}`);
      break;
    }

    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else {
      // Look ahead to find matching lines
      let matchIdx = -1;
      for (let k = j; k < newLines.length; k++) {
        if (newLines[k] === oldLines[i]) {
          matchIdx = k;
          break;
        }
      }

      if (matchIdx !== -1) {
        // Elements from j to matchIdx were added
        for (let k = j; k < matchIdx; k++) {
          if (printedLines <= 25) {
            // biome-ignore lint/style/noNonNullAssertion: bounds checked
            console.log(`${green}+ ${newLines[k]!}${reset}`);
            printedLines++;
          }
        }
        j = matchIdx;
      } else {
        // Element at i was removed/modified
        if (oldLines[i] !== undefined) {
          if (printedLines <= 25) {
            console.log(`${red}- ${oldLines[i]}${reset}`);
            printedLines++;
          }
        }
        if (newLines[j] !== undefined) {
          if (printedLines <= 25) {
            console.log(`${green}+ ${newLines[j]}${reset}`);
            printedLines++;
          }
        }
        i++;
        j++;
      }
    }
  }
}

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
  .option("--workspace <path>", "root workspace directory", "sandbox")
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
        workspace: string;
      },
    ) => {
      const workspacePath = path.resolve(process.cwd(), options.workspace);
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
        rememberFactTool,
        recallFactsTool,
        forgetFactTool,
      ];
      for (const tool of tools) {
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
      const permissions = [
        options.allowWrite ? "write" : undefined,
        options.allowExecute ? "execute" : undefined,
      ].filter((value): value is "write" | "execute" => value !== undefined);

      const store = new SessionStore(workspacePath);
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

      const onApproveFileChange = options.allowWrite
        ? undefined
        : async (path: string, newContent: string, currentContent?: string) => {
            if (!process.stdin.isTTY) {
              return false;
            }
            printVisualDiff(path, newContent, currentContent);
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            return new Promise<boolean>((resolve) => {
              rl.question(`⚠️  Allow file changes to "${path}"? (y/N): `, (answer) => {
                rl.close();
                resolve(answer.trim().toLowerCase() === "y");
              });
            });
          };

      const controller = new AbortController();
      const cancel = () => {
        console.log("\nCancelling agent…");
        controller.abort();
      };
      process.once("SIGINT", cancel);

      try {
        const ctxResult = await new RepositoryContextBuilder().buildStructured(workspacePath);
        const repositoryContext = ctxResult.text;
        printBanner({
          model,
          ...(ctxResult.gitBranch ? { branch: ctxResult.gitBranch } : {}),
          ...(ctxResult.testCommand ? { testCommand: ctxResult.testCommand } : {}),
          sessionId: taskId,
        });

        runtime.events.publish({
          type: "task.created",
          taskId,
          goal: agentTask,
          timestamp: new Date().toISOString(),
        });

        let stepHadContent = false;
        let agentStreamedText = "";
        const spinner = new Spinner();
        const toolTimers = new Map<string, number>();
        const toolArgs = new Map<string, Record<string, unknown>>();

        const answer = await agent.run(
          agentTask,
          {
            repositoryPath: workspacePath,
            allowedPermissions: permissions,
            commandTimeoutMs: Number(options.commandTimeout) * 1000,
            signal: controller.signal,
            taskId,
            ...(onApproveCommand ? { onApproveCommand } : {}),
            ...(onApproveFileChange ? { onApproveFileChange } : {}),
          },
          {
            maxSteps: Number(options.maxSteps),
            repositoryContext,
            history,
            enablePlanning: true,
            onEvent: (event) => {
              const now = new Date().toISOString();
              if (event.type === "plan.started") {
                printPlanningHeader();
                runtime.events.publish({ type: "plan.started", taskId, timestamp: now });
              }
              if (event.type === "plan.finished") {
                plan = event.plan;
                printPlanningFooter(agentStreamedText, plan);
                runtime.events.publish({
                  type: "plan.finished",
                  taskId,
                  plan: event.plan,
                  timestamp: now,
                });
              }
              if (event.type === "model.started") {
                stepHadContent = false;
                agentStreamedText = "";
                spinner.start(event.step > 0 ? "thinking…" : "analyzing request…");
                runtime.events.publish({
                  type: "model.started",
                  taskId,
                  step: event.step,
                  timestamp: now,
                });
              }
              if (event.type === "model.token") {
                spinner.stop();
                stepHadContent = true;
                agentStreamedText += event.token;
                process.stdout.write(event.token);
              }
              if (event.type === "model.finished") {
                spinner.stop();
                if (stepHadContent) {
                  clearStreamedText(agentStreamedText);
                  console.log(renderMarkdown(agentStreamedText));
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
                toolTimers.set(event.toolName, Date.now());
                toolArgs.set(event.toolName, event.args ?? {});
                runtime.events.publish({
                  type: "tool.started",
                  taskId,
                  step: event.step,
                  toolName: event.toolName,
                  timestamp: now,
                });
              }
              if (event.type === "tool.finished") {
                const duration = Date.now() - (toolTimers.get(event.toolName) ?? Date.now());
                const args = toolArgs.get(event.toolName) ?? {};
                printToolResult(
                  event.toolName,
                  toolArgPreview(event.toolName, args),
                  event.success,
                  duration,
                );
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

        // Content was already streamed live; show only the metadata footer
        printHeader("Summary");
        const metaLines: string[] = [];
        const filesMatch = answer.match(
          /\*\*Files modified:\*\*\n([\s\S]*?)(?=\n\n|\n\*\*Tokens|$)/,
        );
        if (filesMatch) metaLines.push(filesMatch[0]);
        const tokensMatch = answer.match(/\*\*Tokens used:\*\*.+/);
        if (tokensMatch) metaLines.push(tokensMatch[0]);
        if (metaLines.length > 0) console.log(renderMarkdown(metaLines.join("\n")));
        else console.log("Done.");
        console.log(`\nSession saved: .forge/sessions/${sessionId}.json`);
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
  .option("--workspace <path>", "root workspace directory", "sandbox")
  .action(
    async (options: {
      allowWrite?: boolean;
      allowExecute?: boolean;
      maxSteps: string;
      commandTimeout: string;
      provider?: string;
      session?: string;
      verbose?: boolean;
      workspace: string;
    }) => {
      const workspacePath = path.resolve(process.cwd(), options.workspace);
      const apiKey = process.env.FORGE_API_KEY;
      let currentModel = process.env.FORGE_MODEL ?? "";
      let currentProvider = (options.provider ??
        process.env.FORGE_PROVIDER ??
        "openrouter") as ProviderKind;
      if (!currentModel) throw new Error("Set FORGE_MODEL before using the agent command.");
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
        rememberFactTool,
        recallFactsTool,
        forgetFactTool,
      ];
      for (const tool of tools) {
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
      const permissions = [
        options.allowWrite ? "write" : undefined,
        options.allowExecute ? "execute" : undefined,
      ].filter((value): value is "write" | "execute" => value !== undefined);

      const store = new SessionStore(workspacePath);
      let sessionId = options.session ?? crypto.randomUUID();
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

      const onApproveFileChange = options.allowWrite
        ? undefined
        : async (path: string, newContent: string, currentContent?: string) => {
            if (!process.stdin.isTTY) {
              return false;
            }
            printVisualDiff(path, newContent, currentContent);
            const rlFile = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            return new Promise<boolean>((resolve) => {
              rlFile.question(`⚠️  Allow file changes to "${path}"? (y/N): `, (answer) => {
                rlFile.close();
                resolve(answer.trim().toLowerCase() === "y");
              });
            });
          };

      let activeController: AbortController | undefined;
      let isAgentRunning = false;
      let hasPlanned = false; // Only plan on the first turn of each session

      const sigintHandler = () => {
        if (isAgentRunning && activeController) {
          console.log("\n🛑 Cancelling agent run...");
          activeController.abort();
          activeController = undefined;
        } else {
          console.log("\nGoodbye!");
          process.exit(0);
        }
      };
      process.on("SIGINT", sigintHandler);

      try {
        const ctxResult = await new RepositoryContextBuilder().buildStructured(workspacePath);
        const repositoryContext = ctxResult.text;
        printBanner({
          model: currentModel,
          ...(ctxResult.gitBranch ? { branch: ctxResult.gitBranch } : {}),
          ...(ctxResult.testCommand ? { testCommand: ctxResult.testCommand } : {}),
          sessionId,
        });

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
                  "  /new         - Start a new clean session\n" +
                  "  /resume [id] - List or load a saved session\n" +
                  "  /provider [p] [m] - Show, switch, or configure model provider\n" +
                  "  /model [name] - Show or change the active LLM model\n" +
                  "  /status      - Show current session status\n" +
                  "  /history     - Print active messages in current chat\n" +
                  "  /diff        - View unstaged repository changes\n" +
                  "  /reset       - Clear active chat history",
              );
              promptUser();
              return;
            }
            if (input === "/status") {
              const msgCount = agent.messages.length;
              const { MemoryStore: MS } = await import("@forge/memory");
              const facts = await MS.load(workspacePath);
              const factCount = Object.keys(facts).length;
              console.log(
                `\n📊 Session Status\n  Session ID : ${sessionId}\n  Provider   : ${currentProvider}\n  Model      : ${currentModel}\n  Messages   : ${msgCount}\n  Branch     : ${ctxResult.gitBranch ?? "(not a git repo)"}\n  Memory     : ${factCount} fact(s) stored\n  Planned    : ${hasPlanned ? "yes" : "no (will plan on next turn)"}`,
              );
              promptUser();
              return;
            }
            if (input.startsWith("/provider")) {
              const parts = input.split(" ");
              const nextProvider = parts[1]?.trim() as ProviderKind | undefined;
              const nextModel = parts[2]?.trim();

              if (!nextProvider) {
                console.log(`Current provider: "${currentProvider}" (Model: "${currentModel}")`);
                console.log("Use: /provider <openrouter|openai|grok|anthropic|ollama> [modelName]");
              } else {
                currentProvider = nextProvider;
                if (nextModel) currentModel = nextModel;

                // Re-instantiate agent with new provider
                const oldMessages = agent.messages;
                agent = new CodingAgent(
                  createProvider({
                    provider: currentProvider,
                    model: currentModel,
                    ...(currentProvider !== "ollama" && apiKey ? { apiKey } : {}),
                    ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}),
                  }),
                  registry,
                );
                agent.messages = oldMessages;
                console.log(`🔌 Switched provider to ${currentProvider} (Model: ${currentModel})`);
              }
              promptUser();
              return;
            }
            if (input.startsWith("/model")) {
              const parts = input.split(" ");
              const nextModel = parts[1]?.trim();

              if (!nextModel) {
                console.log(`Current model: "${currentModel}"`);
                console.log("Use: /model <modelName>");
              } else {
                currentModel = nextModel;

                // Re-instantiate agent with new model
                const oldMessages = agent.messages;
                agent = new CodingAgent(
                  createProvider({
                    provider: currentProvider,
                    model: currentModel,
                    ...(currentProvider !== "ollama" && apiKey ? { apiKey } : {}),
                    ...(process.env.FORGE_BASE_URL ? { baseUrl: process.env.FORGE_BASE_URL } : {}),
                  }),
                  registry,
                );
                agent.messages = oldMessages;
                console.log(`🧠 Switched model to ${currentModel}`);
              }
              promptUser();
              return;
            }
            if (input === "/new") {
              agent.messages = [];
              plan = "";
              hasPlanned = false;
              sessionId = crypto.randomUUID();
              loadedSession = undefined;
              console.log(`✨ New session started (ID: ${sessionId}).`);
              promptUser();
              return;
            }
            if (input.startsWith("/resume")) {
              const parts = input.split(" ");
              const targetId = parts[1]?.trim();
              if (targetId) {
                try {
                  const resumedSession = await store.load(targetId);
                  agent.messages = resumedSession.messages ?? [];
                  plan = resumedSession.plan;
                  console.log(`🌿 Resumed session ${targetId}`);
                } catch {
                  console.log(`⚠️ Saved session "${targetId}" not found.`);
                }
              } else {
                const sessions = await store.list();
                if (sessions.length === 0) {
                  console.log("No saved sessions.");
                } else {
                  console.log("Saved sessions (use '/resume <id>'):");
                  for (const s of sessions) {
                    console.log(`  ${s.id} - ${s.updatedAt} - ${s.task}`);
                  }
                }
              }
              promptUser();
              return;
            }
            if (input === "/history") {
              if (agent.messages.length === 0) {
                console.log("(no messages in current session)");
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
              promptUser();
              return;
            }
            if (input === "/diff") {
              const diffResult = await registry.execute(
                "git_diff",
                { staged: false },
                { repositoryPath: workspacePath },
              );
              console.log(formatToolResult("git_diff", diffResult));
              promptUser();
              return;
            }
            if (input === "/reset") {
              agent.messages = [];
              hasPlanned = false;
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

            isAgentRunning = true;
            activeController = new AbortController();
            let chatStepHadContent = false;
            let chatStreamedText = "";
            const spinner = new Spinner();
            const toolTimers = new Map<string, number>();
            const toolArgs = new Map<string, Record<string, unknown>>();

            try {
              const shouldPlan = !hasPlanned;
              const answer = await agent.run(
                input,
                {
                  repositoryPath: workspacePath,
                  allowedPermissions: permissions,
                  commandTimeoutMs: Number(options.commandTimeout) * 1000,
                  signal: activeController.signal,
                  taskId,
                  ...(onApproveCommand ? { onApproveCommand } : {}),
                  ...(onApproveFileChange ? { onApproveFileChange } : {}),
                },
                {
                  maxSteps: Number(options.maxSteps),
                  repositoryContext,
                  history: [],
                  enablePlanning: shouldPlan,
                  onEvent: (event) => {
                    const now = new Date().toISOString();
                    if (event.type === "plan.started") {
                      printPlanningHeader();
                      runtime.events.publish({ type: "plan.started", taskId, timestamp: now });
                    }
                    if (event.type === "plan.finished") {
                      plan = event.plan;
                      printPlanningFooter(chatStreamedText, plan);
                      runtime.events.publish({
                        type: "plan.finished",
                        taskId,
                        plan: event.plan,
                        timestamp: now,
                      });
                    }
                    if (event.type === "model.started") {
                      chatStepHadContent = false;
                      chatStreamedText = "";
                      spinner.start(event.step > 0 ? "thinking…" : "analyzing request…");
                      runtime.events.publish({
                        type: "model.started",
                        taskId,
                        step: event.step,
                        timestamp: now,
                      });
                    }
                    if (event.type === "model.token") {
                      spinner.stop();
                      chatStepHadContent = true;
                      chatStreamedText += event.token;
                      process.stdout.write(event.token);
                    }
                    if (event.type === "model.finished") {
                      spinner.stop();
                      if (chatStepHadContent) {
                        clearStreamedText(chatStreamedText);
                        console.log(renderMarkdown(chatStreamedText));
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
                      toolTimers.set(event.toolName, Date.now());
                      toolArgs.set(event.toolName, event.args ?? {});
                      runtime.events.publish({
                        type: "tool.started",
                        taskId,
                        step: event.step,
                        toolName: event.toolName,
                        timestamp: now,
                      });
                    }
                    if (event.type === "tool.finished") {
                      const duration = Date.now() - (toolTimers.get(event.toolName) ?? Date.now());
                      const args = toolArgs.get(event.toolName) ?? {};
                      printToolResult(
                        event.toolName,
                        toolArgPreview(event.toolName, args),
                        event.success,
                        duration,
                      );
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

              hasPlanned = true; // Don't plan again for subsequent turns
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

              // Content was already streamed live; show only metadata
              const chatMetaLines: string[] = [];
              const chatFilesMatch = answer.match(
                /\*\*Files modified:\*\*\n([\s\S]*?)(?=\n\n|\n\*\*Tokens|$)/,
              );
              if (chatFilesMatch) chatMetaLines.push(chatFilesMatch[0]);
              const chatTokensMatch = answer.match(/\*\*Tokens used:\*\*.+/);
              if (chatTokensMatch) chatMetaLines.push(chatTokensMatch[0]);
              if (chatMetaLines.length > 0) {
                printHeader("Summary");
                console.log(renderMarkdown(chatMetaLines.join("\n")));
              }
            } catch (error) {
              // Suppress AbortError from Ctrl+C cancellation
              if (error instanceof DOMException && error.name === "AbortError") {
                console.log("\n🛑 Agent run cancelled.");
              } else {
                const errorMsg = error instanceof Error ? error.message : String(error);
                console.error(`⚠️ Error running task: ${errorMsg}`);
                runtime.events.publish({
                  type: "task.failed",
                  taskId,
                  error: errorMsg,
                  timestamp: new Date().toISOString(),
                });
              }
            } finally {
              isAgentRunning = false;
              activeController = undefined;
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
        process.off("SIGINT", sigintHandler);
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
