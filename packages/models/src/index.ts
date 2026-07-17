import type { ModelProvider, ModelRequest, ModelResponse } from "@forge/types";

export type ProviderKind = "openai" | "openrouter" | "grok" | "anthropic" | "ollama" | "groq";

export interface ProviderConfig {
  provider: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) throw new Error("FORGE_API_KEY is required for Anthropic.");
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
    case "ollama":
      return new OllamaProvider({
        model: config.model,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
    case "openai":
    case "openrouter":
    case "grok":
    case "groq":
      if (!config.apiKey) throw new Error(`FORGE_API_KEY is required for ${config.provider}.`);
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl ?? defaultBaseUrl(config.provider),
      });
  }
}

// ---------------------------------------------------------------------------
// Shared SSE helper (C8)
// ---------------------------------------------------------------------------

/**
 * Reads an SSE stream from `reader` line-by-line and calls `onLine` for each
 * non-empty data line (the raw string after "data:").  Stops when the stream
 * ends or the "[DONE]" sentinel is received.
 */
async function readSSEStream(
  // biome-ignore lint/suspicious/noExplicitAny: Bun's ReadableStreamDefaultReader type differs from lib.dom
  reader: ReadableStreamDefaultReader<any>,
  onLine: (dataStr: string) => void,
): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") return;
      onLine(dataStr);
    }
  }
}

// ---------------------------------------------------------------------------
// Safe JSON.parse helper (E1)
// ---------------------------------------------------------------------------

/** Parse JSON; returns `fallback` (default `{}`) on any error. */
function safeJsonParse(
  raw: string,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Merge Signals helper
// ---------------------------------------------------------------------------

function mergeSignals(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);

  const onAbort = () => {
    clearTimeout(timeoutId);
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", onAbort);
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly config: { apiKey: string; baseUrl: string; model: string }) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.onToken) {
      const { signal, cleanup } = mergeSignals(90000, request.signal);
      try {
        const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: this.config.model,
            messages: request.messages,
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            stream: true,
            stream_options: { include_usage: true },
          }),
        });

        if (!response.ok)
          throw new Error(`Model request failed (${response.status}): ${await response.text()}`);

        const reader = response.body?.getReader() as
          | ReadableStreamDefaultReader<Uint8Array>
          | undefined;
        if (!reader) throw new Error("Response body is not readable.");

        let content = "";
        let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

        await readSSEStream(reader, (dataStr) => {
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.usage) {
              usage = {
                inputTokens: parsed.usage.prompt_tokens,
                outputTokens: parsed.usage.completion_tokens,
              };
            }
            const choice = parsed.choices?.[0];
            if (choice) {
              if (choice.finish_reason) {
                finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
              }
              const delta = choice.delta;
              if (delta) {
                if (delta.content) {
                  content += delta.content;
                  // biome-ignore lint/style/noNonNullAssertion: guarded by outer if (request.onToken)
                  request.onToken!(delta.content);
                }
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    let existing = toolCallsMap.get(idx);
                    if (!existing) {
                      existing = { id: "", name: "", arguments: "" };
                      toolCallsMap.set(idx, existing);
                    }
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name = tc.function.name;
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                  }
                }
              }
            }
          } catch {
            // ignore malformed SSE line
          }
        });

        // E1: use safeJsonParse for streaming tool call arguments
        const toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments ? safeJsonParse(tc.arguments) : {},
        }));

        return {
          content,
          toolCalls,
          finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
          ...(usage ? { usage } : {}),
        };
      } finally {
        cleanup();
      }
    }

    const { signal, cleanup } = mergeSignals(90000, request.signal);
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
      });
      if (!response.ok)
        throw new Error(`Model request failed (${response.status}): ${await response.text()}`);
      const payload = (await response.json()) as OpenAIResponse;
      const choice = payload.choices[0];
      if (!choice) throw new Error("Model response did not contain a choice.");
      return {
        content: choice.message.content ?? "",
        // E1: use safeJsonParse for non-streaming tool call arguments
        toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: safeJsonParse(call.function.arguments),
        })),
        finishReason: choice.finish_reason === "tool_calls" ? "tool_calls" : "stop",
        ...(payload.usage
          ? {
              usage: {
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: payload.usage.completion_tokens,
              },
            }
          : {}),
      };
    } finally {
      cleanup();
    }
  }
}

interface OpenAIResponse {
  choices: Array<{
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

export class OllamaProvider implements ModelProvider {
  constructor(private readonly config: { model: string; baseUrl?: string }) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const baseUrl = (this.config.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");

    if (request.onToken) {
      const { signal, cleanup } = mergeSignals(90000, request.signal);
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            model: this.config.model,
            messages: request.messages,
            tools: asOpenAITools(request),
            stream: true,
          }),
        });
        if (!response.ok)
          throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);

        const reader = response.body?.getReader() as
          | ReadableStreamDefaultReader<Uint8Array>
          | undefined;
        if (!reader) throw new Error("Response body is not readable.");

        let content = "";
        let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

        await readSSEStream(reader, (dataStr) => {
          try {
            const parsed = JSON.parse(dataStr);
            const choice = parsed.choices?.[0];
            if (choice) {
              if (choice.finish_reason) {
                finishReason = choice.finish_reason === "tool_calls" ? "tool_calls" : "stop";
              }
              const delta = choice.delta;
              if (delta) {
                if (delta.content) {
                  content += delta.content;
                  // biome-ignore lint/style/noNonNullAssertion: guarded by outer if (request.onToken)
                  request.onToken!(delta.content);
                }
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    let existing = toolCallsMap.get(idx);
                    if (!existing) {
                      existing = { id: "", name: "", arguments: "" };
                      toolCallsMap.set(idx, existing);
                    }
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name = tc.function.name;
                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                  }
                }
              }
            }
          } catch {
            // ignore malformed SSE line
          }
        });

        // E1: use safeJsonParse for streaming tool call arguments
        const toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments ? safeJsonParse(tc.arguments) : {},
        }));

        return {
          content,
          toolCalls,
          finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
        };
      } finally {
        cleanup();
      }
    }

    const { signal, cleanup } = mergeSignals(90000, request.signal);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          tools: asOpenAITools(request),
        }),
      });
      if (!response.ok)
        throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
      return parseOpenAIResponse((await response.json()) as OpenAIResponse);
    } finally {
      cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements ModelProvider {
  constructor(private readonly config: { apiKey: string; model: string; baseUrl?: string }) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.onToken) {
      // F5: use `?? ""` so null content becomes empty string, not "null"
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((m) => m.content ?? "")
        .join("\n");
      const { signal, cleanup } = mergeSignals(90000, request.signal);
      try {
        const response = await fetch(
          `${(this.config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": this.config.apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": "prompt-caching-2024-07-31",
              "content-type": "application/json",
            },
            signal,
            body: JSON.stringify({
              model: this.config.model,
              max_tokens: 4096,
              system: [
                {
                  type: "text",
                  text: system,
                  cache_control: { type: "ephemeral" },
                },
              ],
              messages: toAnthropicMessagesWithCaching(request.messages),
              tools: request.tools.map((tool, idx) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
                ...(idx === request.tools.length - 1
                  ? { cache_control: { type: "ephemeral" } }
                  : {}),
              })),
              stream: true,
            }),
          },
        );
        if (!response.ok) {
          throw new Error(
            `Anthropic request failed (${response.status}): ${await response.text()}`,
          );
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("Response body is not readable.");
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let content = "";
        let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
        let inputTokens = 0;
        let outputTokens = 0;
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

        // Anthropic SSE uses event-typed lines, not [DONE], so we keep a manual loop
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            try {
              const event = JSON.parse(dataStr);
              if (event.type === "message_start") {
                if (event.message?.usage) {
                  inputTokens = event.message.usage.input_tokens;
                }
              } else if (event.type === "content_block_start") {
                if (event.content_block?.type === "tool_use") {
                  toolCallsMap.set(event.index, {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    arguments: "",
                  });
                }
              } else if (event.type === "content_block_delta") {
                if (event.delta?.type === "text_delta") {
                  content += event.delta.text;
                  // biome-ignore lint/style/noNonNullAssertion: guarded by outer if (request.onToken)
                  request.onToken!(event.delta.text);
                } else if (event.delta?.type === "input_json_delta") {
                  const tc = toolCallsMap.get(event.index);
                  if (tc) {
                    tc.arguments += event.delta.partial_json;
                  }
                }
              } else if (event.type === "message_delta") {
                if (event.usage) {
                  outputTokens = event.usage.output_tokens;
                }
                if (event.delta?.stop_reason) {
                  finishReason = event.delta.stop_reason === "tool_use" ? "tool_calls" : "stop";
                }
              }
            } catch {}
          }
        }

        // E1: use safeJsonParse for streaming tool call arguments
        const toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments ? safeJsonParse(tc.arguments) : {},
        }));

        return {
          content,
          toolCalls,
          finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
          usage: {
            inputTokens,
            outputTokens,
          },
        };
      } finally {
        cleanup();
      }
    }

    // F5: use `?? ""` so null content becomes empty string, not "null"
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((m) => m.content ?? "")
      .join("\n");
    const { signal, cleanup } = mergeSignals(90000, request.signal);
    try {
      const response = await fetch(
        `${(this.config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`,
        {
          method: "POST",
          headers: {
            "x-api-key": this.config.apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "prompt-caching-2024-07-31",
            "content-type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: 4096,
            system: [
              {
                type: "text",
                text: system,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: toAnthropicMessagesWithCaching(request.messages),
            tools: request.tools.map((tool, idx) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
              ...(idx === request.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
            })),
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Anthropic request failed (${response.status}): ${await response.text()}`);
      const payload = (await response.json()) as AnthropicResponse;
      return {
        content: payload.content
          .filter((block): block is AnthropicTextBlock => block.type === "text")
          .map((block) => block.text)
          .join(""),
        toolCalls: payload.content
          .filter((block): block is AnthropicToolUseBlock => block.type === "tool_use")
          .map((block) => ({ id: block.id, name: block.name, arguments: block.input })),
        finishReason: payload.stop_reason === "tool_use" ? "tool_calls" : "stop",
        ...(payload.usage
          ? {
              usage: {
                inputTokens: payload.usage.input_tokens,
                outputTokens: payload.usage.output_tokens,
              },
            }
          : {}),
      };
    } finally {
      cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultBaseUrl(provider: "openai" | "openrouter" | "grok" | "groq"): string {
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "grok") return "https://api.x.ai/v1";
  if (provider === "groq") return "https://api.groq.com/openai/v1";
  return "https://api.openai.com/v1";
}

function asOpenAITools(request: ModelRequest): unknown[] {
  return request.tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function parseOpenAIResponse(payload: OpenAIResponse): ModelResponse {
  const choice = payload.choices[0];
  if (!choice) throw new Error("Model response did not contain a choice.");
  return {
    content: choice.message.content ?? "",
    // E1: use safeJsonParse for non-streaming tool call arguments
    toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: safeJsonParse(call.function.arguments),
    })),
    finishReason: choice.finish_reason === "tool_calls" ? "tool_calls" : "stop",
    ...(payload.usage
      ? {
          usage: {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
          },
        }
      : {}),
  };
}

function toAnthropicMessagesWithCaching(
  messages: readonly import("@forge/types").ModelMessage[],
): unknown[] {
  const filtered = messages.filter((m) => m.role !== "system");
  return filtered.map((m, idx) => {
    // biome-ignore lint/suspicious/noExplicitAny: cast to assign cache_control
    const converted = toAnthropicMessage(m) as any;

    // Mark two cache breakpoints per turn:
    //  1. The second-to-last message → caches the entire prior conversation on every new turn
    //  2. The last message           → caches the current user input for any retry/re-rank
    // This mirrors OpenCode's strategy and gives us monotonically growing cache hits.
    const isLastOrPenultimate = idx === filtered.length - 1 || idx === filtered.length - 2;

    if (isLastOrPenultimate && typeof converted === "object" && converted !== null) {
      if (typeof converted.content === "string") {
        converted.content = [
          {
            type: "text",
            text: converted.content,
            cache_control: { type: "ephemeral" },
          },
        ];
      } else if (Array.isArray(converted.content)) {
        const lastIdx = converted.content.length - 1;
        const orig = converted.content[lastIdx];
        if (orig && typeof orig === "object") {
          // Clone the block so we don't mutate the original message stored in session history
          converted.content[lastIdx] = { ...orig, cache_control: { type: "ephemeral" } };
        }
      }
    }
    return converted;
  });
}

function toAnthropicMessage(message: import("@forge/types").ModelMessage): unknown {
  if (message.role === "tool")
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
    };
  if (message.role === "assistant" && message.toolCalls?.length)
    return {
      role: "assistant",
      content: message.toolCalls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments,
      })),
    };
  return { role: message.role, content: message.content ?? "" };
}

// ---------------------------------------------------------------------------
// Anthropic response types (F2: discriminated union)
// ---------------------------------------------------------------------------

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicResponse {
  stop_reason: string;
  content: AnthropicContentBlock[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Pricing model and calculations (Cost command support)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-3-5-sonnet": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-3-5-haiku": { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  "claude-3-opus": { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  "claude-3-sonnet": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  "claude-3-haiku": { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  // OpenAI
  "gpt-4o": { inputPerMillion: 5.0, outputPerMillion: 15.0 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "o1-preview": { inputPerMillion: 15.0, outputPerMillion: 60.0 },
  "o1-mini": { inputPerMillion: 3.0, outputPerMillion: 12.0 },
  "gpt-4-turbo": { inputPerMillion: 10.0, outputPerMillion: 30.0 },
  "gpt-4": { inputPerMillion: 30.0, outputPerMillion: 60.0 },
  "gpt-3.5-turbo": { inputPerMillion: 0.5, outputPerMillion: 1.5 },
  // Grok
  "grok-2": { inputPerMillion: 2.0, outputPerMillion: 10.0 },
  "grok-2-beta": { inputPerMillion: 2.0, outputPerMillion: 10.0 },
  // Fallbacks
  default: { inputPerMillion: 5.0, outputPerMillion: 15.0 },
  free: { inputPerMillion: 0.0, outputPerMillion: 0.0 },
};

export function getModelPricing(
  model: string,
  customPricing?: Record<string, ModelPricing>,
): ModelPricing {
  const cleanModel = model.toLowerCase();

  if (customPricing) {
    const sortedCustom = Object.entries(customPricing).sort((a, b) => b[0].length - a[0].length);
    for (const [key, price] of sortedCustom) {
      if (cleanModel.includes(key.toLowerCase())) {
        return price;
      }
    }
  }

  const sortedDefault = Object.entries(DEFAULT_PRICING).sort((a, b) => b[0].length - a[0].length);
  for (const [key, price] of sortedDefault) {
    if (key !== "default" && key !== "free" && cleanModel.includes(key)) {
      return price;
    }
  }

  if (cleanModel.includes("free")) {
    return DEFAULT_PRICING.free ?? { inputPerMillion: 0, outputPerMillion: 0 };
  }

  return DEFAULT_PRICING.default ?? { inputPerMillion: 5.0, outputPerMillion: 15.0 };
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}
