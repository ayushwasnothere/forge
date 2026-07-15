import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeEvent } from "@forge/events";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./index";

async function createTempRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "forge-session-test-"));
}

describe("SessionStore", () => {
  it("saves, loads, and lists sessions including message history", async () => {
    const repoPath = await createTempRepo();
    const store = new SessionStore(repoPath);

    const session = {
      id: "session-1",
      task: "Test task",
      plan: "1. Do work",
      result: "Success",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: "user" as const, content: "hello" }],
    };

    await store.save(session);
    const loaded = await store.load("session-1");
    expect(loaded).toEqual(session);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(session);

    await rm(repoPath, { recursive: true, force: true });
  });

  it("appends and retrieves structured events", async () => {
    const repoPath = await createTempRepo();
    const store = new SessionStore(repoPath);

    const event1: ForgeEvent = {
      type: "task.created",
      taskId: "session-1",
      goal: "Run tests",
      timestamp: new Date().toISOString(),
    };
    const event2: ForgeEvent = {
      type: "tool.started",
      taskId: "session-1",
      step: 1,
      toolName: "read_file",
      timestamp: new Date().toISOString(),
    };

    await store.appendEvent("session-1", event1);
    await store.appendEvent("session-1", event2);

    const events = await store.getEvents("session-1");
    expect(events).toEqual([event1, event2]);

    // listing sessions shouldn't return events files
    const list = await store.list();
    expect(list).toHaveLength(0);

    await rm(repoPath, { recursive: true, force: true });
  });
});
