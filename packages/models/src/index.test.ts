import type { ModelMessage } from "@forge/types";
import { describe, expect, it } from "vitest";
import {
  StreamingToolCalls,
  buildAnthropicMessages,
  calculateCost,
  getModelPricing,
  mapOpenAIFinishReason,
} from "./index";

describe("Pricing and Cost calculations", () => {
  it("resolves default prices for common models", () => {
    const sonnet = getModelPricing("anthropic/claude-3-5-sonnet");
    expect(sonnet.inputPerMillion).toBe(3.0);
    expect(sonnet.outputPerMillion).toBe(15.0);

    const mini = getModelPricing("openai/gpt-4o-mini");
    expect(mini.inputPerMillion).toBe(0.15);
    expect(mini.outputPerMillion).toBe(0.6);

    const unknown = getModelPricing("unknown-provider/super-smart-model");
    expect(unknown.inputPerMillion).toBe(5.0);
    expect(unknown.outputPerMillion).toBe(15.0);

    const freeModel = getModelPricing("ollama/free-model");
    expect(freeModel.inputPerMillion).toBe(0.0);
    expect(freeModel.outputPerMillion).toBe(0.0);

    const geminiFlash = getModelPricing("gemini/gemini-2.5-flash");
    expect(geminiFlash.inputPerMillion).toBe(0.075);
    expect(geminiFlash.outputPerMillion).toBe(0.3);
  });

  it("resolves pricing overrides", () => {
    const custom = {
      "custom-model": { inputPerMillion: 1.25, outputPerMillion: 3.75 },
    };
    const resolved = getModelPricing("provider/my-custom-model-v2", custom);
    expect(resolved.inputPerMillion).toBe(1.25);
    expect(resolved.outputPerMillion).toBe(3.75);
  });

  it("calculates cost accurately", () => {
    const pricing = { inputPerMillion: 2.0, outputPerMillion: 10.0 };
    const cost = calculateCost(500_000, 100_000, pricing);
    // (500,000 / 1,000,000) * 2.0 + (100,000 / 1,000,000) * 10.0 = 1.0 + 1.0 = 2.0
    expect(cost).toBe(2.0);
  });
});

describe("mapOpenAIFinishReason", () => {
  it("preserves length so truncation is not reported as a clean stop", () => {
    expect(mapOpenAIFinishReason("length")).toBe("length");
    expect(mapOpenAIFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapOpenAIFinishReason("function_call")).toBe("tool_calls");
    expect(mapOpenAIFinishReason("stop")).toBe("stop");
    expect(mapOpenAIFinishReason(undefined)).toBe("stop");
  });
});

describe("StreamingToolCalls", () => {
  it("assembles fragmented tool-call deltas keyed by index", () => {
    const acc = new StreamingToolCalls();
    acc.ingest([{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"pa' } }]);
    acc.ingest([{ index: 0, function: { arguments: 'th":"a.ts"}' } }]);
    const calls = acc.finalize();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "call_1", name: "read_file", arguments: { path: "a.ts" } });
  });

  it("falls back to a positional key when index is omitted", () => {
    const acc = new StreamingToolCalls();
    acc.ingest([{ id: "a", function: { name: "one", arguments: "{}" } }]);
    acc.ingest([{ id: "b", function: { name: "two", arguments: "{}" } }]);
    const calls = acc.finalize();
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(["one", "two"]);
  });

  it("preserves Gemini thought_signature on tool calls", () => {
    const acc = new StreamingToolCalls();
    acc.ingest([
      {
        index: 0,
        id: "call_1",
        thought_signature: "sig_abc123",
        function: { name: "find_files", arguments: "{}" },
      },
    ]);
    const calls = acc.finalize();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.thoughtSignature).toBe("sig_abc123");
  });
});

describe("buildAnthropicMessages", () => {
  it("merges consecutive tool results into one user message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "t1", name: "read_file", arguments: {} },
          { id: "t2", name: "read_file", arguments: {} },
        ],
      },
      { role: "tool", toolCallId: "t1", content: "result 1" },
      { role: "tool", toolCallId: "t2", content: "result 2" },
    ];
    const out = buildAnthropicMessages(messages);
    // user, assistant(tool_use x2), user(tool_result x2) — roles must alternate.
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const toolResults = out[2]?.content as Array<Record<string, unknown>>;
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]?.tool_use_id).toBe("t1");
    expect(toolResults[1]?.tool_use_id).toBe("t2");
  });

  it("keeps assistant text alongside tool_use blocks", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "Let me read the file first.",
        toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a.ts" } }],
      },
      { role: "tool", toolCallId: "t1", content: "contents" },
    ];
    const out = buildAnthropicMessages(messages);
    const assistantBlocks = out[1]?.content as Array<Record<string, unknown>>;
    expect(assistantBlocks[0]).toEqual({ type: "text", text: "Let me read the file first." });
    expect(assistantBlocks[1]?.type).toBe("tool_use");
  });

  it("drops system messages", () => {
    const out = buildAnthropicMessages([
      { role: "system", content: "you are forge" },
      { role: "user", content: "hi" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });
});

describe("createProvider with Custom Providers", () => {
  it("creates OpenAICompatibleProvider for custom provider", async () => {
    const { createProvider, OpenAICompatibleProvider } = await import("./index");
    const provider = createProvider({
      provider: "agentrouter",
      type: "openai",
      apiKey: "sk-test",
      baseUrl: "https://agentrouter.org/v1",
      model: "claude-opus-4-6",
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("creates AnthropicProvider for custom anthropic-compatible provider", async () => {
    const { createProvider, AnthropicProvider } = await import("./index");
    const provider = createProvider({
      provider: "enterprise-proxy",
      type: "anthropic",
      apiKey: "sk-ant-test",
      baseUrl: "https://proxy.internal/v1",
      model: "claude-3-5-sonnet",
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });
});
