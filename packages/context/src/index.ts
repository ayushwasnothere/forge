import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { detectTestCommand } from "@forge/runtime";

export interface RepositoryContext {
  /** Full context string to inject into the system prompt */
  text: string;
  /** Detected test command for verification — null when no test setup is found */
  testCommand: string | null;
  /** Git branch name, if in a git repo */
  gitBranch?: string;
}

export class RepositoryContextBuilder {
  async build(root: string): Promise<string> {
    const ctx = await this.buildStructured(root);
    return ctx.text;
  }

  async buildStructured(root: string): Promise<RepositoryContext> {
    const sections: string[] = [];

    // ── Git context ──────────────────────────────────────────────────────────
    const gitBranch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const gitLog = await runGit(root, ["log", "--oneline", "--decorate", "--max-count=5"]);
    const gitStatus = await runGit(root, ["status", "--short"]);

    if (gitBranch) {
      sections.push(
        [
          "## Git Repository",
          `Branch: ${gitBranch.trim()}`,
          gitStatus.trim() ? `\nUncommitted changes:\n${gitStatus.trim()}` : "Working tree clean.",
          gitLog.trim() ? `\nRecent commits:\n${gitLog.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }

    // ── Detected test command ────────────────────────────────────────────────
    const testCommand = await detectTestCommand(root);
    if (testCommand) {
      sections.push(`## Test Command\n${testCommand}`);
    }
    // ── Package.json scripts ─────────────────────────────────────────────────
    const pkgJson = await readFile(join(root, "package.json"), "utf8").catch(() => null);
    if (pkgJson) {
      try {
        const pkg = JSON.parse(pkgJson) as { name?: string; scripts?: Record<string, string> };
        const scriptLines = Object.entries(pkg.scripts ?? {})
          .slice(0, 15)
          .map(([k, v]) => `  ${k}: ${v}`);
        if (scriptLines.length > 0) {
          sections.push(
            `## Package: ${pkg.name ?? "(unnamed)"}\n### Scripts\n${scriptLines.join("\n")}`,
          );
        }
      } catch {
        // malformed JSON — skip
      }
    }

    // ── Directory tree (2 levels) ────────────────────────────────────────────
    const SKIP = new Set([
      ".git",
      ".forge",
      "node_modules",
      "dist",
      "build",
      ".next",
      ".turbo",
      "coverage",
      ".cache",
    ]);
    const treeLines = await buildTree(root, root, 0, 5, SKIP);
    if (treeLines.length > 0) {
      sections.push(`## Repository Structure\n${treeLines.join("\n")}`);
    }

    // ── README ───────────────────────────────────────────────────────────────
    const readme = await readFile(join(root, "README.md"), "utf8").catch(() => null);
    if (readme) {
      sections.push(`## README (excerpt)\n${readme.slice(0, 2000)}`);
    }

    // ── FORGE.md / CLAUDE.md guidelines ──────────────────────────────────────
    let guidelines = await readFile(join(root, "FORGE.md"), "utf8").catch(() => null);
    let guidelinesName = "FORGE.md";
    if (!guidelines) {
      guidelines = await readFile(join(root, "CLAUDE.md"), "utf8").catch(() => null);
      guidelinesName = "CLAUDE.md";
    }
    if (guidelines) {
      sections.push(`## Project Guidelines (from ${guidelinesName})\n${guidelines}`);
    }

    // ── tsconfig / pyproject / Cargo.toml snippet ────────────────────────────
    const configFile = await findConfigFile(root);
    if (configFile) {
      sections.push(`## Project Config (${configFile.name})\n${configFile.content}`);
    }

    const text = [
      "# Repository Context",
      "(Use search_code and find_files to locate specific code before reading files.)",
      "",
      ...sections,
    ].join("\n\n");

    const trimmedBranch = gitBranch?.trim() || undefined;
    return { text, testCommand, ...(trimmedBranch ? { gitBranch: trimmedBranch } : {}) };
  }
}

async function buildTree(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  skip: Set<string>,
): Promise<string[]> {
  if (depth >= maxDepth) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sorted = entries.sort((a, b) => {
    // dirs first, then files
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const e of sorted) {
    if (skip.has(e.name)) continue;
    const rel = relative(root, join(dir, e.name)).replace(/\\/g, "/");
    if (e.isDirectory()) {
      lines.push(`${indent}📂 ${rel}/`);
      lines.push(...(await buildTree(root, join(dir, e.name), depth + 1, maxDepth, skip)));
    } else {
      lines.push(`${indent}📄 ${rel}`);
    }
  }
  return lines;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { spawn } = await import("node:child_process");
    const parentDir = dirname(cwd);
    return await new Promise<string>((resolve) => {
      const proc = spawn("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_CEILING_DIRECTORIES: parentDir,
        },
      });
      let out = "";
      proc.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      proc.stderr?.on("data", () => {}); // swallow stderr
      proc.on("close", () => resolve(out));
      proc.on("error", () => resolve(""));
    });
  } catch {
    return "";
  }
}

async function findConfigFile(root: string): Promise<{ name: string; content: string } | null> {
  const candidates = [
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "biome.json",
    ".eslintrc.json",
  ];
  for (const name of candidates) {
    const content = await readFile(join(root, name), "utf8").catch(() => null);
    if (content !== null) {
      return { name, content: content.slice(0, 1500) };
    }
  }
  return null;
}
