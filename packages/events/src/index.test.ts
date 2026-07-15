import { describe, expect, it } from "vitest";
import { EventBus } from "./index";

describe("EventBus", () => {
  it("delivers published events to subscribers", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.subscribe((event) => received.push(event.type));

    bus.publish({ type: "task.created", taskId: "task-1", timestamp: new Date() });

    expect(received).toEqual(["task.created"]);
  });
});
