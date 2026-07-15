export type ForgeEvent =
  | { type: "task.created"; taskId: string; goal: string; timestamp: string }
  | { type: "task.completed"; taskId: string; result: string; timestamp: string }
  | { type: "task.failed"; taskId: string; error: string; timestamp: string }
  | { type: "plan.started"; taskId: string; timestamp: string }
  | { type: "plan.finished"; taskId: string; plan: string; timestamp: string }
  | { type: "model.started"; taskId: string; step: number; timestamp: string }
  | {
      type: "model.finished";
      taskId: string;
      step: number;
      toolCallCount: number;
      timestamp: string;
    }
  | { type: "tool.started"; taskId: string; step: number; toolName: string; timestamp: string }
  | {
      type: "tool.finished";
      taskId: string;
      step: number;
      toolName: string;
      success: boolean;
      timestamp: string;
    };

export type EventListener = (event: ForgeEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: ForgeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
