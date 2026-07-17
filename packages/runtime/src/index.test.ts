import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  DockerSandboxRunner,
  aggregateHealth,
  configurationCheck,
  detectTestCommand,
} from "./index";

describe("aggregateHealth", () => {
  it("reports healthy when every check passes", () => {
    expect(
      aggregateHealth([
        { name: "a", status: "pass", detail: "ok" },
        { name: "b", status: "pass", detail: "ok" },
      ]),
    ).toBe("healthy");
  });

  it("reports degraded when at least one check warns and none fail", () => {
    expect(
      aggregateHealth([
        { name: "a", status: "pass", detail: "ok" },
        { name: "b", status: "warn", detail: "missing" },
      ]),
    ).toBe("degraded");
  });

  it("reports unhealthy when any check fails, regardless of warnings", () => {
    expect(
      aggregateHealth([
        { name: "a", status: "pass", detail: "ok" },
        { name: "b", status: "warn", detail: "missing" },
        { name: "c", status: "fail", detail: "broken" },
      ]),
    ).toBe("unhealthy");
  });
});

describe("configurationCheck", () => {
  it("passes when the API key and model are configured", () => {
    const check = configurationCheck({ FORGE_API_KEY: "k", FORGE_MODEL: "m" });
    expect(check).toMatchObject({ name: "configuration", status: "pass" });
  });

  it("warns and lists every missing variable", () => {
    const check = configurationCheck({});
    expect(check).toMatchObject({ name: "configuration", status: "warn" });
    expect(check.detail).toContain("FORGE_API_KEY");
    expect(check.detail).toContain("FORGE_MODEL");
  });
});

describe("AgentRuntime.healthCheck", () => {
  it("reports the runtime and git checks for a Git repository", async () => {
    const runtime = new AgentRuntime();
    const report = await runtime.healthCheck(process.cwd());

    expect(report.status).toMatch(/healthy|degraded/);
    expect(report).toHaveProperty("checkedAt");
    expect(report.checks.some((check) => check.name === "runtime")).toBe(true);
    expect(report.checks.some((check) => check.name === "git")).toBe(true);
  });
});

describe("detectTestCommand", () => {
  async function createFixtureRepo(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "forge-test-"));
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(root, relativePath);
      const dir = join(fullPath, "..");
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }
    return root;
  }

  it("detects bun run test when bun.lockb exists", async () => {
    const repo = await createFixtureRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "bun.lockb": "",
    });
    expect(await detectTestCommand(repo)).toBe("bun run test");
  });

  it("detects yarn test when yarn.lock exists", async () => {
    const repo = await createFixtureRepo({
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      "yarn.lock": "",
    });
    expect(await detectTestCommand(repo)).toBe("yarn test");
  });

  it("detects pnpm test when pnpm-lock.yaml exists", async () => {
    const repo = await createFixtureRepo({
      "package.json": JSON.stringify({ scripts: { test: "playwright test" } }),
      "pnpm-lock.yaml": "",
    });
    expect(await detectTestCommand(repo)).toBe("pnpm test");
  });

  it("detects npm test when package-lock.json exists", async () => {
    const repo = await createFixtureRepo({
      "package.json": JSON.stringify({ scripts: { test: "mocha" } }),
      "package-lock.json": "",
    });
    expect(await detectTestCommand(repo)).toBe("npm test");
  });

  it("detects cargo test for Cargo.toml", async () => {
    const repo = await createFixtureRepo({
      "Cargo.toml": '[package]\nname = "test"',
    });
    expect(await detectTestCommand(repo)).toBe("cargo test");
  });

  it("detects go test ./... for go.mod", async () => {
    const repo = await createFixtureRepo({
      "go.mod": "module test",
    });
    expect(await detectTestCommand(repo)).toBe("go test ./...");
  });

  it("detects pytest for python configuration files", async () => {
    const repo = await createFixtureRepo({
      "pyproject.toml": "",
    });
    expect(await detectTestCommand(repo)).toBe("pytest");
  });

  it("returns null for an empty directory with no recognizable test setup", async () => {
    const repo = await createFixtureRepo({});
    expect(await detectTestCommand(repo)).toBeNull();
  });
});

describe("DockerSandboxRunner", () => {
  it("initializes with options", () => {
    const sandbox = new DockerSandboxRunner({ image: "node:latest", fallbackToHost: false });
    expect(sandbox).toBeDefined();
  });

  it("checks docker availability", async () => {
    const sandbox = new DockerSandboxRunner();
    const available = await sandbox.checkDocker();
    expect(typeof available).toBe("boolean");
  });

  it("falls back to host execution when docker is missing", async () => {
    const sandbox = new DockerSandboxRunner({ fallbackToHost: true });
    // Mock checkDocker to return false
    sandbox.checkDocker = async () => false;

    const result = await sandbox.execute(["node", "-e", "console.log('hello')"], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("rejects execution if docker is missing and fallback is disabled", async () => {
    const sandbox = new DockerSandboxRunner({ fallbackToHost: false });
    sandbox.checkDocker = async () => false;

    await expect(
      sandbox.execute(["node", "-e", "console.log('hello')"], process.cwd()),
    ).rejects.toThrow("Docker sandbox required");
  });
});
