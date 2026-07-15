import { EventBus } from "@forge/events";
import type { Session, Task } from "@forge/types";

export class AgentRuntime {
  readonly events = new EventBus();
  private session: Session | undefined;
  private task: Task | undefined;

  statusMessage(): string {
    if (!this.session) {
      return "No session active.";
    }

    if (!this.task) {
      return `Session ${this.session.id} is ready.`;
    }

    return `Task is ${this.task.status}.`;
  }
}
