export type TaskStatus =
  | "idle"
  | "planning"
  | "gathering_context"
  | "executing"
  | "reflecting"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  repositoryPath: string;
  createdAt: Date;
  activeTaskId?: string;
}

export interface ToolResult<TData = unknown> {
  success: boolean;
  data?: TData;
  error?: string;
  durationMs: number;
  metadata: Record<string, unknown>;
}

export interface Tool<TInput = unknown, TData = unknown> {
  readonly name: string;
  readonly description: string;
  execute(input: TInput): Promise<ToolResult<TData>>;
}

export interface ModelResponse {
  content: string;
  toolCalls: readonly ModelToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
