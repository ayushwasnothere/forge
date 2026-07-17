import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RepositoryContextBuilder } from "./index";

async function createTestRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forge-context-"));
  await writeFile(join(root, "README.md"), "# My Project\nA test project for Forge.\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "my-project", scripts: { test: "vitest", build: "tsc" } }, null, 2),
    "utf8",
  );
  return root;
}

describe("RepositoryContextBuilder", () => {
  it("build() returns a non-empty string with repository structure", async () => {
    const root = await createTestRepository();
    const builder = new RepositoryContextBuilder();
    const context = await builder.build(root);

    expect(typeof context).toBe("string");
    expect(context.length).toBeGreaterThan(50);
    expect(context).toContain("Repository");
  });

  it("buildStructured() includes package scripts and README excerpt", async () => {
    const root = await createTestRepository();
    const builder = new RepositoryContextBuilder();
    const result = await builder.buildStructured(root);

    expect(result.text).toContain("my-project");
    expect(result.text).toContain("vitest");
    expect(result.text).toContain("My Project");
    expect(result.testCommand).toBeTruthy();
    expect(typeof result.testCommand).toBe("string");
  });

  it("buildStructured() skips node_modules and .git in tree", async () => {
    const root = await createTestRepository();
    const builder = new RepositoryContextBuilder();
    const result = await builder.buildStructured(root);

    expect(result.text).not.toContain("node_modules");
    expect(result.text).not.toContain(".git/");
  });

  it("buildStructured() includes project guidelines from FORGE.md", async () => {
    const root = await createTestRepository();
    await writeFile(join(root, "FORGE.md"), "# Guidelines\nDo not use callbacks.\n", "utf8");
    const builder = new RepositoryContextBuilder();
    const result = await builder.buildStructured(root);

    expect(result.text).toContain("Project Guidelines (from FORGE.md)");
    expect(result.text).toContain("Do not use callbacks.");
  });
});
