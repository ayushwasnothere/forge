import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./index";

const TEST_REPO = join(process.cwd(), "temp_test_memory_repo");

describe("MemoryStore", () => {
  beforeEach(async () => {
    await rm(TEST_REPO, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await rm(TEST_REPO, { recursive: true, force: true }).catch(() => {});
  });

  it("loads empty facts if file doesn't exist", async () => {
    const facts = await MemoryStore.load(TEST_REPO);
    expect(facts).toEqual({});
  });

  it("saves, loads, and forgets facts", async () => {
    let facts = await MemoryStore.remember(TEST_REPO, "pythonPath", "python3.11");
    expect(facts).toEqual({ pythonPath: "python3.11" });

    // load
    const loaded = await MemoryStore.load(TEST_REPO);
    expect(loaded).toEqual({ pythonPath: "python3.11" });

    // forget
    facts = await MemoryStore.forget(TEST_REPO, "pythonPath");
    expect(facts).toEqual({});

    const afterForget = await MemoryStore.load(TEST_REPO);
    expect(afterForget).toEqual({});
  });
});
