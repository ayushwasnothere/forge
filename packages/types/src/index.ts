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

export type ToolPermission = "read" | "write" | "execute";

export interface SandboxRunner {
  execute(
    command: string[],
    cwd: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface ToolExecutionContext {
  repositoryPath: string;
  allowedPermissions?: readonly ToolPermission[];
  commandTimeoutMs?: number;
  signal?: AbortSignal;
  taskId?: string;
  /** Approximate remaining token budget — tools should trim output when low. */
  tokenBudget?: number;
  sandbox?: SandboxRunner;
  onApproveCommand?: (command: string) => Promise<boolean>;
  onApproveFileChange?: (
    path: string,
    newContent: string,
    currentContent?: string,
  ) => Promise<boolean>;
}

export interface Tool<TInput = unknown, TData = unknown> {
  readonly name: string;
  readonly description: string;
  readonly permission: ToolPermission;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TData>>;
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

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  toolCalls?: readonly ModelToolCall[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly ModelToolDefinition[];
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
