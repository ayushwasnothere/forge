import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
} from "@forge/types";

export type ProviderKind =
  | "openai"
  | "openrouter"
  | "grok"
  | "anthropic"
  | "ollama"
  | "groq"
  | "gemini"
  | (string & {});

export interface ProviderConfig {
  provider: ProviderKind;
  type?: "openai" | "anthropic";
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export function createProvider(config: ProviderConfig): ModelProvider {
  const isAnthropic = config.type === "anthropic" || config.provider === "anthropic";
  if (isAnthropic) {
    if (!config.apiKey)
      throw new Error("FORGE_API_KEY is required for Anthropic-compatible provider.");
    return new AnthropicProvider({
      apiKey: config.apiKey,
      model: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
  }

  if (config.provider === "ollama") {
    return new OpenAICompatibleProvider({
      model: config.model,
      baseUrl: (config.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, ""),
    });
  }

  if (!config.apiKey) {
    throw new Error(`FORGE_API_KEY is required for ${config.provider}.`);
  }

  return new OpenAICompatibleProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl ?? defaultBaseUrl(config.provider),
  });
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

/** Map an OpenAI `finish_reason` onto our narrower finishReason union. */
export function mapOpenAIFinishReason(reason: unknown): ModelResponse["finishReason"] {
  if (reason === "tool_calls" || reason === "function_call") return "tool_calls";
  if (reason === "length") return "length";
  return "stop";
}

/**
 * Streaming tool-call accumulator. OpenAI-compatible deltas arrive fragmented
 * across chunks and keyed by `index`; some providers omit `index` on the first
 * fragment, so we fall back to the running count.
 */
export class StreamingToolCalls {
  private readonly byIndex = new Map<
    number,
    {
      id: string;
      name: string;
      arguments: string;
      thoughtSignature?: string;
      extraContent?: Record<string, unknown>;
      extraFields?: Record<string, unknown>;
    }
  >();

  ingest(deltaToolCalls: Array<Record<string, unknown>>, globalSig?: string): void {
    for (const tc of deltaToolCalls) {
      const idx = typeof tc.index === "number" ? tc.index : this.byIndex.size;
      let existing = this.byIndex.get(idx);
      if (!existing) {
        existing = { id: "", name: "", arguments: "" };
        this.byIndex.set(idx, existing);
      }
      if (typeof tc.id === "string" && tc.id) existing.id = tc.id;

      if (tc.extra_content && typeof tc.extra_content === "object") {
        existing.extraContent = tc.extra_content as Record<string, unknown>;
      }

      // biome-ignore lint/suspicious/noExplicitAny: function field can be typed dynamically
      const rawFn = tc.function as any;
      const sig =
        tc.thought_signature ?? tc.thoughtSignature ?? rawFn?.thought_signature ?? globalSig;
      if (typeof sig === "string" && sig) {
        existing.thoughtSignature = sig;
      }
      if (tc.extra_fields && typeof tc.extra_fields === "object") {
        existing.extraFields = tc.extra_fields as Record<string, unknown>;
      }

      const fn = tc.function as { name?: string; arguments?: string } | undefined;
      if (fn?.name) existing.name = fn.name;
      if (fn?.arguments) existing.arguments += fn.arguments;
    }
  }

  finalize(): ModelToolCall[] {
    return Array.from(this.byIndex.values()).map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments ? safeJsonParse(tc.arguments) : {},
      ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
      ...(tc.extraContent ? { extraContent: tc.extraContent } : {}),
      ...(tc.extraFields ? { extraFields: tc.extraFields } : {}),
    }));
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
// HTTP Error helper
// ---------------------------------------------------------------------------

async function handleHttpError(response: Response, providerName: string): Promise<never> {
  const text = await response.text();
  if (response.status === 401) {
    throw new Error(
      `Invalid or expired API Key for ${providerName} (401 Unauthorized). Please check your API key or update it via /setup. Details: ${text}`,
    );
  }
  if (response.status === 429) {
    throw new Error(
      `Rate limit or quota exceeded for ${providerName} (429 Too Many Requests). Please wait a few seconds before retrying, or switch to another model using /model. Details: ${text}`,
    );
  }
  throw new Error(`Model request failed (${response.status}): ${text}`);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible provider (also serves Ollama, which speaks the same API)
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly config: { apiKey?: string; baseUrl: string; model: string }) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private body(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const hasTools = request.tools && request.tools.length > 0;
    return {
      model: this.config.model,
      messages: asOpenAIMessages(request.messages),
      ...(hasTools ? { tools: asOpenAITools(request) } : {}),
      ...(stream ? { stream: true } : {}),
      // include_usage is supported by OpenAI and OpenRouter for streaming responses;
      // other backends (Ollama, local proxies) reject unknown fields.
      ...(stream &&
      (this.config.baseUrl.includes("api.openai.com") ||
        this.config.baseUrl.includes("openrouter.ai"))
        ? { stream_options: { include_usage: true } }
        : {}),
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    if (request.onToken) {
      const { signal, cleanup } = mergeSignals(90000, request.signal);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: this.headers(),
          signal,
          body: JSON.stringify(this.body(request, true)),
        });

        if (!response.ok) {
          await handleHttpError(response, this.config.baseUrl);
        }

        const reader = response.body?.getReader() as
          | ReadableStreamDefaultReader<Uint8Array>
          | undefined;
        if (!reader) throw new Error("Response body is not readable.");

        let content = "";
        let finishReason: ModelResponse["finishReason"] = "stop";
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        let streamError: string | undefined;
        const toolCalls = new StreamingToolCalls();

        await readSSEStream(reader, (dataStr) => {
          try {
            const parsed = JSON.parse(dataStr);
            // Some providers emit an error object mid-stream over a 200 response.
            if (parsed.error) {
              streamError =
                typeof parsed.error === "string"
                  ? parsed.error
                  : (parsed.error.message ?? JSON.stringify(parsed.error));
              return;
            }
            if (parsed.usage) {
              usage = {
                inputTokens: parsed.usage.prompt_tokens ?? 0,
                outputTokens: parsed.usage.completion_tokens ?? 0,
              };
            }
            const choice = parsed.choices?.[0];
            if (choice) {
              if (choice.finish_reason) {
                finishReason = mapOpenAIFinishReason(choice.finish_reason);
              }
              const delta = choice.delta;
              if (delta) {
                // biome-ignore lint/suspicious/noExplicitAny: delta may carry reasoning_content or thought
                const rawDelta = delta as any;
                const textChunk =
                  rawDelta.content || rawDelta.reasoning_content || rawDelta.thought || "";
                if (textChunk) {
                  content += textChunk;
                  if (request.onToken) request.onToken(textChunk);
                }
                if (delta.tool_calls) toolCalls.ingest(delta.tool_calls);
              }
            }
          } catch {
            // ignore malformed SSE line
          }
        });

        if (streamError) throw new Error(`Model stream error: ${streamError}`);

        const finalToolCalls = toolCalls.finalize();
        return {
          content,
          toolCalls: finalToolCalls,
          finishReason: finalToolCalls.length > 0 ? "tool_calls" : finishReason,
          ...(usage ? { usage } : {}),
        };
      } finally {
        cleanup();
      }
    }

    const { signal, cleanup } = mergeSignals(90000, request.signal);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        signal,
        body: JSON.stringify(this.body(request, false)),
      });
      if (!response.ok) {
        await handleHttpError(response, this.config.baseUrl);
      }
      return parseOpenAIResponse((await response.json()) as OpenAIResponse);
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
// Ollama provider — thin alias kept for backwards compatibility.
// Ollama's /v1 endpoint is OpenAI-compatible, so we reuse the same provider.
// ---------------------------------------------------------------------------

export class OllamaProvider extends OpenAICompatibleProvider {
  constructor(config: { model: string; baseUrl?: string }) {
    super({
      model: config.model,
      baseUrl: (config.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, ""),
    });
  }
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements ModelProvider {
  private readonly maxTokens: number;
  constructor(
    private readonly config: {
      apiKey: string;
      model: string;
      baseUrl?: string;
      maxTokens?: number;
    },
  ) {
    this.maxTokens = config.maxTokens ?? 4096;
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    };
  }

  private url(): string {
    return `${(this.config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`;
  }

  private body(request: ModelRequest, stream: boolean): Record<string, unknown> {
    // F5: use `?? ""` so null content becomes empty string, not "null"
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((m) => m.content ?? "")
      .join("\n")
      .trim();

    return {
      model: this.config.model,
      max_tokens: this.maxTokens,
      // Only send `system` when non-empty: an empty text block is rejected by
      // the API and a below-threshold cache breakpoint is wasted.
      ...(system
        ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] }
        : {}),
      messages: toAnthropicMessagesWithCaching(request.messages),
      tools: request.tools.map((tool, idx) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        ...(idx === request.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      })),
      ...(stream ? { stream: true } : {}),
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.onToken) {
      const { signal, cleanup } = mergeSignals(90000, request.signal);
      try {
        const response = await fetch(this.url(), {
          method: "POST",
          headers: this.headers(),
          signal,
          body: JSON.stringify(this.body(request, true)),
        });
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
        let finishReason: ModelResponse["finishReason"] = "stop";
        let inputTokens = 0;
        let outputTokens = 0;
        let streamError: string | undefined;
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
              if (event.type === "error") {
                streamError = event.error?.message ?? JSON.stringify(event.error ?? event);
              } else if (event.type === "message_start") {
                if (event.message?.usage) {
                  // Include cache tokens so cost/usage reflects true input size.
                  const u = event.message.usage;
                  inputTokens =
                    (u.input_tokens ?? 0) +
                    (u.cache_creation_input_tokens ?? 0) +
                    (u.cache_read_input_tokens ?? 0);
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
                  outputTokens = event.usage.output_tokens ?? outputTokens;
                }
                if (event.delta?.stop_reason) {
                  finishReason =
                    event.delta.stop_reason === "tool_use"
                      ? "tool_calls"
                      : event.delta.stop_reason === "max_tokens"
                        ? "length"
                        : "stop";
                }
              }
            } catch {}
          }
        }

        if (streamError) throw new Error(`Anthropic stream error: ${streamError}`);

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
    const { signal, cleanup } = mergeSignals(90000, request.signal);
    try {
      const response = await fetch(this.url(), {
        method: "POST",
        headers: this.headers(),
        signal,
        body: JSON.stringify(this.body(request, false)),
      });
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
        finishReason:
          payload.stop_reason === "tool_use"
            ? "tool_calls"
            : payload.stop_reason === "max_tokens"
              ? "length"
              : "stop",
        ...(payload.usage
          ? {
              usage: {
                inputTokens:
                  (payload.usage.input_tokens ?? 0) +
                  (payload.usage.cache_creation_input_tokens ?? 0) +
                  (payload.usage.cache_read_input_tokens ?? 0),
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

function defaultBaseUrl(provider: string): string {
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "grok") return "https://api.x.ai/v1";
  if (provider === "groq") return "https://api.groq.com/openai/v1";
  if (provider === "gemini") return "https://generativelanguage.googleapis.com/v1beta/openai";
  return "https://api.openai.com/v1";
}

function asOpenAIMessages(messages: readonly ModelMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "system" || msg.role === "user") {
      return {
        role: msg.role,
        content: msg.content ?? "",
      };
    }

    if (msg.role === "assistant") {
      const formatted: Record<string, unknown> = {
        role: "assistant",
        content: msg.content ?? "",
      };

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        formatted.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          ...(tc.extraContent ? { extra_content: tc.extraContent } : {}),
          ...(tc.thoughtSignature ? { thought_signature: tc.thoughtSignature } : {}),
          ...(tc.extraFields ? { extra_fields: tc.extraFields } : {}),
          function: {
            name: tc.name,
            arguments:
              typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
            ...(tc.thoughtSignature ? { thought_signature: tc.thoughtSignature } : {}),
          },
        }));
      }

      return formatted;
    }

    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId ?? "",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      };
    }

    return msg;
  });
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
    // biome-ignore lint/suspicious/noExplicitAny: response call type can carry non-standard thought_signature
    toolCalls: (choice.message.tool_calls ?? []).map((call: any) => ({
      id: call.id,
      name: call.function.name,
      arguments: safeJsonParse(call.function.arguments),
      extraContent: call.extra_content,
      thoughtSignature:
        call.thought_signature ?? call.thoughtSignature ?? call.function?.thought_signature,
      extraFields: call.extra_fields,
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
  messages: readonly ModelMessage[],
): Array<{ role: string; content: unknown }> {
  const converted = buildAnthropicMessages(messages);

  // Mark up to two cache breakpoints on the most recent message content blocks:
  //  1. The second-to-last message → caches the entire prior conversation
  //  2. The last message           → caches the current user input for retries
  // This mirrors OpenCode's strategy and gives monotonically growing cache hits.
  return converted.map((msg, idx) => {
    const isLastOrPenultimate = idx === converted.length - 1 || idx === converted.length - 2;
    if (!isLastOrPenultimate || !Array.isArray(msg.content) || msg.content.length === 0) {
      return msg;
    }
    const blocks = msg.content as Array<Record<string, unknown>>;
    const lastIdx = blocks.length - 1;
    const orig = blocks[lastIdx];
    if (orig && typeof orig === "object") {
      // Clone so we never mutate objects retained in session history.
      const cloned = blocks.slice();
      cloned[lastIdx] = { ...orig, cache_control: { type: "ephemeral" } };
      return { role: msg.role, content: cloned };
    }
    return msg;
  });
}

/**
 * Convert Forge messages to Anthropic's format, enforcing the API's structural
 * rules:
 *  - `system` messages are dropped (handled separately as the top-level system).
 *  - Consecutive `tool` results are merged into a single `user` message holding
 *    multiple `tool_result` blocks (parallel tool calls would otherwise emit
 *    illegal back-to-back user messages).
 *  - An assistant turn keeps its text *and* its `tool_use` blocks together.
 *
 * Exported for unit testing.
 */
export function buildAnthropicMessages(
  messages: readonly ModelMessage[],
): Array<{ role: string; content: unknown }> {
  const out: Array<{ role: string; content: unknown }> = [];
  let pendingToolResults: Array<Record<string, unknown>> | null = null;

  const flushToolResults = () => {
    if (pendingToolResults && pendingToolResults.length > 0) {
      out.push({ role: "user", content: pendingToolResults });
    }
    pendingToolResults = null;
  };

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content ?? "",
      });
      continue;
    }

    flushToolResults();

    if (message.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (message.content?.trim()) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      // An assistant message must carry at least one block.
      out.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }

    // user
    out.push({ role: "user", content: message.content ?? "" });
  }

  flushToolResults();
  return out;
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
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
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
  // Groq
  "llama-3.3-70b": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  "mixtral-8x7b": { inputPerMillion: 0.24, outputPerMillion: 0.24 },
  "llama-3.1-8b": { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  // Gemini
  "gemini-2.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5.0 },
  "gemini-2.0-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  "gemini-1.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5.0 },
  "gemini-1.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
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
