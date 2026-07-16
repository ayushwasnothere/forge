import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ToolRegistry,
  findFilesTool,
  formatToolResult,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitStatusTool,
  listDirectoryTool,
  listSymbolsTool,
  readFileTool,
  replaceTextTool,
  runCommandTool,
  searchCodeTool,
  writeFileTool,
} from "./index";

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "forge-tools-"));
  await writeFile(join(repositoryPath, "README.md"), "# Test repository\n");
  await mkdir(join(repositoryPath, "src"));
  return repositoryPath;
}

describe("ToolRegistry", () => {
  it("validates input before executing a tool", async () => {
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const result = await registry.execute(
      "read_file",
      {},
      { repositoryPath: await createRepository() },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid input");
  });

  it("reads files with line numbers and supports startLine/endLine", async () => {
    const repositoryPath = await createRepository();
    const content = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
    await writeFile(join(repositoryPath, "multi.txt"), content, "utf8");

    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const fullResult = await registry.execute(
      "read_file",
      { path: "multi.txt" },
      { repositoryPath },
    );
    expect(fullResult.success).toBe(true);
    const data = fullResult.data as {
      content: string;
      totalLines: number;
      fromLine: number;
      toLine: number;
    };
    expect(data.totalLines).toBe(5);
    expect(data.fromLine).toBe(1);
    expect(data.toLine).toBe(5);
    expect(data.content).toContain("│ line 1");
    expect(data.content).toContain("│ line 3");

    const sliceResult = await registry.execute(
      "read_file",
      { path: "multi.txt", startLine: 2, endLine: 3 },
      { repositoryPath },
    );
    expect(sliceResult.success).toBe(true);
    const sliceData = sliceResult.data as { content: string; fromLine: number; toLine: number };
    expect(sliceData.fromLine).toBe(2);
    expect(sliceData.toLine).toBe(3);
    expect(sliceData.content).toContain("│ line 2");
    expect(sliceData.content).toContain("│ line 3");
    expect(sliceData.content).not.toContain("│ line 1");
  });

  it("rejects paths outside the repository", async () => {
    const repositoryPath = await createRepository();
    const registry = new ToolRegistry();
    registry.register(readFileTool);

    const escapeResult = await registry.execute(
      "read_file",
      { path: "../outside.txt" },
      { repositoryPath },
    );
    expect(escapeResult).toMatchObject({
      success: false,
      error: "Path must remain within the active repository.",
    });
  });

  it("lists directories in a stable order with recursive support", async () => {
    const repositoryPath = await createRepository();
    await writeFile(join(repositoryPath, "src", "index.ts"), "export {};");
    const registry = new ToolRegistry();
    registry.register(listDirectoryTool);

    const flat = await registry.execute(
      "list_directory",
      { path: ".", recursive: false },
      { repositoryPath },
    );
    expect(flat).toMatchObject({
      success: true,
      data: {
        entries: expect.arrayContaining([
          expect.objectContaining({ name: "README.md", type: "file" }),
          expect.objectContaining({ name: "src", type: "directory" }),
        ]),
      },
    });

    const recursive = await registry.execute(
      "list_directory",
      { path: ".", recursive: true },
      { repositoryPath },
    );
    expect(recursive.success).toBe(true);
    const entries = (recursive.data as { entries: Array<{ relativePath?: string }> }).entries;
    expect(entries.some((e) => e.relativePath?.includes("index.ts"))).toBe(true);
  });

  it("requires explicit permission and one exact match before writing", async () => {
    const repositoryPath = await createRepository();
    const registry = new ToolRegistry();
    registry.register(replaceTextTool);

    const denied = await registry.execute(
      "replace_text",
      { path: "README.md", oldText: "Test", newText: "Forge" },
      { repositoryPath },
    );
    const applied = await registry.execute(
      "replace_text",
      { path: "README.md", oldText: "Test", newText: "Forge" },
      { repositoryPath, allowedPermissions: ["write"] },
    );
    const repeated = await registry.execute(
      "replace_text",
      { path: "README.md", oldText: "missing", newText: "value" },
      { repositoryPath, allowedPermissions: ["write"] },
    );

    expect(denied).toMatchObject({
      success: false,
      error: "Write permission is required to use replace_text.",
    });
    expect(applied).toMatchObject({ success: true, data: { replacements: 1 } });
    expect(repeated).toMatchObject({ success: false, error: expect.stringContaining("found 0") });
    await expect(readFile(join(repositoryPath, "README.md"), "utf8")).resolves.toBe(
      "# Forge repository\n",
    );
  });

  it("write_file creates parent directories automatically", async () => {
    const repositoryPath = await createRepository();
    const registry = new ToolRegistry();
    registry.register(writeFileTool);

    const result = await registry.execute(
      "write_file",
      { path: "deep/nested/dir/file.ts", content: "export const x = 1;", overwrite: false },
      { repositoryPath, allowedPermissions: ["write"] },
    );
    expect(result.success).toBe(true);
    const written = await readFile(join(repositoryPath, "deep/nested/dir/file.ts"), "utf8");
    expect(written).toBe("export const x = 1;");
  });

  it("find_files matches glob patterns", async () => {
    const repositoryPath = await createRepository();
    await writeFile(join(repositoryPath, "src", "index.ts"), "export {};");
    await writeFile(join(repositoryPath, "src", "helper.ts"), "export {};");
    await writeFile(join(repositoryPath, "src", "helper.test.ts"), "import {};");

    const registry = new ToolRegistry();
    registry.register(findFilesTool);

    const tsResult = await registry.execute(
      "find_files",
      { pattern: "**/*.ts", excludePatterns: [], maxResults: 100 },
      { repositoryPath },
    );
    expect(tsResult.success).toBe(true);
    const files = (tsResult.data as { files: string[] }).files;
    expect(files.some((f) => f.includes("index.ts"))).toBe(true);
    expect(files.some((f) => f.includes("helper.ts"))).toBe(true);

    const testResult = await registry.execute(
      "find_files",
      { pattern: "**/*.test.ts", excludePatterns: [], maxResults: 100 },
      { repositoryPath },
    );
    const testFiles = (testResult.data as { files: string[] }).files;
    expect(testFiles.length).toBe(1);
    expect(testFiles[0]).toContain("helper.test.ts");
  });

  it("list_symbols extracts TypeScript symbols", async () => {
    const repositoryPath = await createRepository();
    const code = [
      "export interface Foo { name: string; }",
      "export type Bar = string | number;",
      "export class Baz { constructor() {} }",
      "export async function doThing(): Promise<void> {}",
      "export const CONSTANT = 42;",
    ].join("\n");
    await writeFile(join(repositoryPath, "src", "symbols.ts"), code);

    const registry = new ToolRegistry();
    registry.register(listSymbolsTool);

    const result = await registry.execute(
      "list_symbols",
      { path: "src/symbols.ts" },
      { repositoryPath },
    );
    expect(result.success).toBe(true);
    const symbols = (result.data as { symbols: Array<{ name: string; kind: string }> }).symbols;
    expect(symbols.some((s) => s.name === "Foo" && s.kind === "interface")).toBe(true);
    expect(symbols.some((s) => s.name === "Bar" && s.kind === "type")).toBe(true);
    expect(symbols.some((s) => s.name === "Baz" && s.kind === "class")).toBe(true);
    expect(symbols.some((s) => s.name === "doThing" && s.kind === "function")).toBe(true);
    expect(symbols.some((s) => s.name === "CONSTANT" && s.kind === "variable")).toBe(true);
  });

  it("list_symbols AST ignores comments and string variable contents", async () => {
    const repositoryPath = await createRepository();
    const code = [
      "// export class CommentedClass {}",
      "/* export interface CommentedInterface {} */",
      "export const myString = 'export class StringClass {}';",
    ].join("\n");
    await writeFile(join(repositoryPath, "src/ignore.ts"), code);

    const registry = new ToolRegistry();
    registry.register(listSymbolsTool);

    const result = await registry.execute(
      "list_symbols",
      { path: "src/ignore.ts" },
      { repositoryPath },
    );
    expect(result.success).toBe(true);
    const symbols = (result.data as { symbols: Array<{ name: string; kind: string }> }).symbols;
    // Commented out declarations should be ignored
    expect(symbols.some((s) => s.name === "CommentedClass")).toBe(false);
    expect(symbols.some((s) => s.name === "CommentedInterface")).toBe(false);
    // Declarations inside strings should be ignored
    expect(symbols.some((s) => s.name === "StringClass")).toBe(false);
    // The variable itself should be captured
    expect(symbols.some((s) => s.name === "myString" && s.kind === "variable")).toBe(true);
  });

  it("handles run_command permissions and onApproveCommand callback", async () => {
    const repositoryPath = await createRepository();
    const registry = new ToolRegistry();
    registry.register(runCommandTool);

    const denied = await registry.execute(
      "run_command",
      { command: "echo hello" },
      { repositoryPath },
    );
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("Execute permission is required");

    let approveResult = false;
    const approveCallback = async (cmd: string) => {
      expect(cmd).toBe("echo hello");
      return approveResult;
    };

    const deniedByApproval = await registry.execute(
      "run_command",
      { command: "echo hello" },
      { repositoryPath, onApproveCommand: approveCallback },
    );
    expect(deniedByApproval.success).toBe(false);
    expect(deniedByApproval.error).toContain("Execute permission was denied by the user");

    approveResult = true;
    const allowedByApproval = await registry.execute(
      "run_command",
      { command: "echo hello" },
      { repositoryPath, onApproveCommand: approveCallback },
    );
    expect(allowedByApproval.success).toBe(true);
    expect(allowedByApproval.data).toMatchObject({ exitCode: 0 });

    const allowedDirectly = await registry.execute(
      "run_command",
      { command: "echo hello" },
      { repositoryPath, allowedPermissions: ["execute"] },
    );
    expect(allowedDirectly.success).toBe(true);
    expect(allowedDirectly.data).toMatchObject({ exitCode: 0 });
  });

  it("searches code using searchCodeTool (ripgrep JSON fallback)", async () => {
    const repositoryPath = await createRepository();
    const registry = new ToolRegistry();
    registry.register(searchCodeTool);

    const originalSpawn = Bun.spawn;
    // biome-ignore lint/suspicious/noExplicitAny: mock Bun.spawn for testing
    const spy = vi.spyOn(Bun, "spawn").mockImplementation((command: any, options: any): any => {
      if (command[0] === "rg") {
        // Return ripgrep JSON format
        const jsonLine = JSON.stringify({
          type: "match",
          data: {
            path: { text: `${repositoryPath}/README.md` },
            line_number: 1,
            lines: { text: "# Test repository\n" },
            submatches: [{ start: 2, end: 6, match: { text: "Test" } }],
          },
        });
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`${jsonLine}\n`).body,
          stderr: new Response("").body,
          kill: () => {},
        };
      }
      return originalSpawn(command, options);
    });

    try {
      const searchResult = await registry.execute(
        "search_code",
        { query: "Test", path: ".", maxResults: 50, caseSensitive: true, isRegex: false },
        { repositoryPath },
      );
      expect(searchResult.success).toBe(true);
      const data = searchResult.data as {
        matches: Array<{ file: string; line: number; text: string }>;
      };
      expect(data.matches.length).toBe(1);
      expect(data.matches[0]?.file).toContain("README.md");
      expect(data.matches[0]?.line).toBe(1);
      expect(data.matches[0]?.text).toContain("Test repository");
    } finally {
      spy.mockRestore();
    }
  });

  it("formatToolResult produces readable output for each tool type", () => {
    const readResult = {
      success: true as const,
      data: {
        path: "/repo/src/index.ts",
        content: "  1 │ export {};",
        totalLines: 1,
        fromLine: 1,
        toLine: 1,
      },
      durationMs: 5,
      metadata: {},
    };
    const formatted = formatToolResult("read_file", readResult);
    expect(formatted).toContain("index.ts");
    expect(formatted).toContain("1 line");
    expect(formatted).toContain("export {}");

    const searchResult = {
      success: true as const,
      data: {
        matches: [{ file: "src/foo.ts", line: 10, column: 1, text: "const foo = 1;" }],
        total: 1,
        truncated: false,
      },
      durationMs: 12,
      metadata: {},
    };
    const searchFormatted = formatToolResult("search_code", searchResult);
    expect(searchFormatted).toContain("src/foo.ts");
    expect(searchFormatted).toContain("10:");
    expect(searchFormatted).toContain("const foo = 1;");

    const failResult = {
      success: false as const,
      error: "file not found",
      durationMs: 1,
      metadata: {},
    };
    const failFormatted = formatToolResult("read_file", failResult);
    expect(failFormatted).toContain("❌");
    expect(failFormatted).toContain("file not found");
  });

  it("handles Git status, diff, log and commit tools", async () => {
    const repositoryPath = await createRepository();
    // Initialize git
    execSync("git init", { cwd: repositoryPath });
    execSync("git config user.name 'Test Agent'", { cwd: repositoryPath });
    execSync("git config user.email 'agent@forge.test'", { cwd: repositoryPath });

    const registry = new ToolRegistry();
    registry.register(gitStatusTool);
    registry.register(gitDiffTool);
    registry.register(gitLogTool);
    registry.register(gitCommitTool);

    // Initial status check
    const status1 = await registry.execute("git_status", {}, { repositoryPath });
    expect(status1.success).toBe(true);
    expect((status1.data as { stdout: string }).stdout).toContain("README.md");

    // Commit requires write permission
    const commitDenied = await registry.execute(
      "git_commit",
      { message: "Initial commit", paths: ["README.md"] },
      { repositoryPath },
    );
    expect(commitDenied.success).toBe(false);
    expect(commitDenied.error).toContain("Write permission is required");

    // Success commit
    const commitAllowed = await registry.execute(
      "git_commit",
      { message: "Initial commit", paths: ["README.md"] },
      { repositoryPath, allowedPermissions: ["write"] },
    );
    expect(commitAllowed.success).toBe(true);
    expect((commitAllowed.data as { exitCode: number }).exitCode).toBe(0);

    // git log should show the commit
    const logResult = await registry.execute("git_log", { maxCommits: 5 }, { repositoryPath });
    expect(logResult.success).toBe(true);
    expect((logResult.data as { stdout: string }).stdout).toContain("Initial commit");

    // No unstaged changes
    const status2 = await registry.execute("git_status", {}, { repositoryPath });
    expect((status2.data as { stdout: string }).stdout).not.toContain("README.md");
  });
});
