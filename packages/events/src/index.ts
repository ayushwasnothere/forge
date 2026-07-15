export type ForgeEvent =
  | { type: "task.created"; taskId: string; timestamp: Date }
  | { type: "task.completed"; taskId: string; timestamp: Date }
  | { type: "task.failed"; taskId: string; error: string; timestamp: Date }
  | { type: "tool.started"; toolName: string; timestamp: Date }
  | {
      type: "tool.finished";
      toolName: string;
      success: boolean;
      timestamp: Date;
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
