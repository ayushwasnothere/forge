import type { ModelProvider, ModelRequest, ModelResponse } from "@forge/types";

export type ProviderKind = "openai" | "openrouter" | "grok" | "anthropic" | "ollama";

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
      if (!config.apiKey) throw new Error(`FORGE_API_KEY is required for ${config.provider}.`);
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl ?? defaultBaseUrl(config.provider),
      });
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly config: { apiKey: string; baseUrl: string; model: string }) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.onToken) {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        ...(request.signal ? { signal: request.signal } : {}),
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

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable.");
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let content = "";
      let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

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
          if (dataStr === "[DONE]") break;
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
                  request.onToken(delta.content);
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
          } catch (e) {
            // ignore malformed line
          }
        }
      }

      const toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {},
      }));

      return {
        content,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
        ...(usage ? { usage } : {}),
      };
    }

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(request.signal ? { signal: request.signal } : {}),
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
      toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
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

export class OllamaProvider implements ModelProvider {
  constructor(private readonly config: { model: string; baseUrl?: string }) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const baseUrl = (this.config.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");

    if (request.onToken) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(request.signal ? { signal: request.signal } : {}),
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages,
          tools: asOpenAITools(request),
          stream: true,
        }),
      });
      if (!response.ok)
        throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable.");
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let content = "";
      let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

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
          if (dataStr === "[DONE]") break;
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
                  request.onToken(delta.content);
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
            // ignore malformed line
          }
        }
      }

      const toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {},
      }));

      return {
        content,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
      };
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(request.signal ? { signal: request.signal } : {}),
      body: JSON.stringify({
        model: this.config.model,
        messages: request.messages,
        tools: asOpenAITools(request),
      }),
    });
    if (!response.ok)
      throw new Error(`Ollama request failed (${response.status}): ${await response.text()}`);
    return parseOpenAIResponse((await response.json()) as OpenAIResponse);
  }
}

export class AnthropicProvider implements ModelProvider {
  constructor(private readonly config: { apiKey: string; model: string; baseUrl?: string }) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.onToken) {
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      const response = await fetch(
        `${(this.config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`,
        {
          method: "POST",
          headers: {
            "x-api-key": this.config.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          ...(request.signal ? { signal: request.signal } : {}),
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: 4096,
            system,
            messages: request.messages
              .filter((message) => message.role !== "system")
              .map(toAnthropicMessage),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
            stream: true,
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Anthropic request failed (${response.status}): ${await response.text()}`);

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body is not readable.");
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let content = "";
      let finishReason: "stop" | "tool_calls" | "length" | "error" = "stop";
      let inputTokens = 0;
      let outputTokens = 0;
      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

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
                request.onToken(event.delta.text);
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

      const toolCalls = Array.from(toolCallsMap.values()).map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {},
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
    }

    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
    const response = await fetch(
      `${(this.config.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "")}/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        ...(request.signal ? { signal: request.signal } : {}),
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 4096,
          system,
          messages: request.messages
            .filter((message) => message.role !== "system")
            .map(toAnthropicMessage),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Anthropic request failed (${response.status}): ${await response.text()}`);
    const payload = (await response.json()) as AnthropicResponse;
    return {
      content: payload.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join(""),
      toolCalls: payload.content
        .filter((block) => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} })),
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
  }
}

function defaultBaseUrl(provider: "openai" | "openrouter" | "grok"): string {
  if (provider === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider === "grok") return "https://api.x.ai/v1";
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
    toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
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

interface AnthropicResponse {
  stop_reason: string;
  content: Array<{
    type: "text" | "tool_use";
    id: string;
    name: string;
    text?: string;
    input?: Record<string, unknown>;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}
