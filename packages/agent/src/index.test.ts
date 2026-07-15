import { type RegisteredTool, ToolRegistry, runCommandTool, writeFileTool } from "@forge/tools";
import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ToolExecutionContext,
  ToolResult,
} from "@forge/types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CodingAgent } from "./index";

class ScriptedProvider implements ModelProvider {
  private calls = 0;
  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_request: ModelRequest): Promise<ModelResponse> {
    const response = this.responses[this.calls];
    this.calls += 1;
    return response || { content: "Fallback stop", toolCalls: [], finishReason: "stop" };
  }
}

const echoTool: RegisteredTool<{ value: string }, { value: string }> = {
  name: "echo",
  description: "Return a string.",
  permission: "read",
  inputSchema: z.object({ value: z.string() }),
  async execute(
    input: { value: string },
    _context: ToolExecutionContext,
  ): Promise<ToolResult<{ value: string }>> {
    return { success: true, data: input, durationMs: 0, metadata: {} };
  },
};

describe("CodingAgent", () => {
  it("executes model-requested tools and returns the final response", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const events: string[] = [];

    // New agent: no separate planning call — plan.started/finished emitted at start of run()
    const provider = new ScriptedProvider([
      {
        content: "",
        toolCalls: [{ id: "tool-1", name: "echo", arguments: { value: "hello" } }],
        finishReason: "tool_calls",
      },
      { content: "Completed successfully.", toolCalls: [], finishReason: "stop" },
    ]);

    const result = await new CodingAgent(provider, tools).run(
      "Echo hello",
      { repositoryPath: process.cwd() },
      { onEvent: (event) => events.push(event.type) },
    );

    expect(result).toContain("Completed successfully.");
    expect(events).toEqual([
      "plan.started",
      "plan.finished",
      "model.started",
      "model.finished",
      "tool.started",
      "tool.finished",
      "model.started",
      "model.finished",
    ]);
  });

  it("recovers from permission-denial errors by presenting them to the model", async () => {
    const tools = new ToolRegistry();
    tools.register(writeFileTool);

    const provider = new ScriptedProvider([
      {
        content: "Trying to write a file.",
        toolCalls: [
          {
            id: "tool-write",
            name: "write_file",
            arguments: { path: "test.txt", content: "hello" },
          },
        ],
        finishReason: "tool_calls",
      },
      {
        content: "I got a permission denial. I will respond to user.",
        toolCalls: [],
        finishReason: "stop",
      },
    ]);

    // run without write permission
    const result = await new CodingAgent(provider, tools).run("Write test.txt", {
      repositoryPath: process.cwd(),
      allowedPermissions: [],
    });

    expect(result).toContain("permission denial");
  });

  it("respects AbortSignal and aborts execution", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const provider = new ScriptedProvider([]);

    const controller = new AbortController();
    controller.abort();

    const agent = new CodingAgent(provider, tools);
    await expect(
      agent.run("Echo hello", { repositoryPath: process.cwd(), signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("enforces maxSteps step limit", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);

    // Keep returning tool calls endlessly (no planning call needed now)
    const endlessResponses: ModelResponse[] = [];
    for (let i = 0; i < 10; i++) {
      endlessResponses.push({
        content: `Loop ${i}`,
        toolCalls: [{ id: `t-${i}`, name: "echo", arguments: { value: "x" } }],
        finishReason: "tool_calls",
      });
    }

    const provider = new ScriptedProvider(endlessResponses);
    const agent = new CodingAgent(provider, tools);

    await expect(
      agent.run("Loop", { repositoryPath: process.cwd() }, { maxSteps: 3 }),
    ).rejects.toThrow("Agent exceeded its 3-step limit.");
  });

  it("handles the verification loop on file changes", async () => {
    const tools = new ToolRegistry();
    tools.register(writeFileTool);
    tools.register(runCommandTool);

    // Mock Bun.spawn so that run_command succeeds or fails based on exitCode variable
    const originalSpawn = Bun.spawn;
    let exitCode = 1;
    // biome-ignore lint/suspicious/noExplicitAny: mock Bun.spawn for testing
    const spy = vi.spyOn(Bun, "spawn").mockImplementation((_command: any, _options: any): any => {
      return {
        exited: Promise.resolve(exitCode),
        stdout: new Response("").body,
        stderr: new Response(exitCode !== 0 ? "Tests failed" : "").body,
        kill: () => {},
      };
    });

    try {
      const toolsWithMock = new ToolRegistry();
      toolsWithMock.register(writeFileTool);
      toolsWithMock.register(runCommandTool);

      let modelCalls = 0;
      const verifyProvider: ModelProvider = {
        async complete(_request: ModelRequest): Promise<ModelResponse> {
          modelCalls += 1;
          if (modelCalls === 1) {
            // Write a file to trigger verification
            return {
              content: "Write",
              toolCalls: [
                {
                  id: "write-1",
                  name: "write_file",
                  arguments: { path: "temp.txt", content: "data", overwrite: true },
                },
              ],
              finishReason: "tool_calls",
            };
          }
          if (modelCalls === 2) {
            // Verification failed — model fixes it and wants to stop
            exitCode = 0; // verification will pass next time
            return { content: "Fixed.", toolCalls: [], finishReason: "stop" };
          }
          // After verification passes, done
          return { content: "Done.", toolCalls: [], finishReason: "stop" };
        },
      };

      const agent = new CodingAgent(verifyProvider, toolsWithMock);
      const response = await agent.run(
        "Write file",
        { repositoryPath: process.cwd(), allowedPermissions: ["write", "execute"] },
        { verifyCommand: "bun run test" },
      );
      expect(response).toContain("Fixed.");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("resumes execution from history without an extra plan call", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);

    const provider = new ScriptedProvider([
      { content: "Resumed final answer", toolCalls: [], finishReason: "stop" },
    ]);

    const history: ModelMessage[] = [
      { role: "system", content: "System message" },
      { role: "user", content: "Original task" },
      {
        role: "assistant",
        content: "Plan",
        toolCalls: [{ id: "t-1", name: "echo", arguments: { value: "a" } }],
      },
      {
        role: "tool",
        toolCallId: "t-1",
        content: JSON.stringify({ success: true, data: { value: "a" } }),
      },
    ];

    const events: string[] = [];
    const agent = new CodingAgent(provider, tools);
    const result = await agent.run(
      "Continue task",
      { repositoryPath: process.cwd() },
      { history, onEvent: (e) => events.push(e.type) },
    );

    expect(result).toContain("Resumed final answer");
    // Should not emit plan events when resuming from history
    expect(events).not.toContain("plan.started");
  });

  it("includes token usage in final answer when provider returns it", async () => {
    const tools = new ToolRegistry();
    tools.register(echoTool);

    const provider = new ScriptedProvider([
      {
        content: "Done.",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 1000, outputTokens: 200 },
      },
    ]);

    const agent = new CodingAgent(provider, tools);
    const result = await agent.run("Simple task", { repositoryPath: process.cwd() });

    expect(result).toContain("1,000");
    expect(result).toContain("200");
  });
});
