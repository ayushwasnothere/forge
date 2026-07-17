import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirm, log } from "@clack/prompts";
import pc from "picocolors";

export async function handleInitCommand(options: { force?: boolean }): Promise<void> {
  const root = process.cwd();
  const forgeMdPath = join(root, "FORGE.md");

  // Check if FORGE.md or CLAUDE.md already exists
  const existing =
    (await readFile(forgeMdPath, "utf8").catch(() => null)) ||
    (await readFile(join(root, "CLAUDE.md"), "utf8").catch(() => null));

  if (existing && !options.force) {
    const overwrite = await confirm({
      message: "⚠️ A project guidelines file (FORGE.md or CLAUDE.md) already exists. Overwrite it?",
      initialValue: false,
    });
    if (!overwrite || typeof overwrite !== "boolean") {
      log.info("Aborted.");
      return;
    }
  }

  // Detect project details
  const languages: string[] = [];
  let testCommand = "";
  let buildCommand = "";

  // 1. Node.js/Bun check
  const pkgJsonContent = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (pkgJsonContent) {
    try {
      const pkg = JSON.parse(pkgJsonContent) as { scripts?: Record<string, string> };
      languages.push("JavaScript/TypeScript");
      if (pkg.scripts?.test) {
        const hasBun =
          (await readFile(join(root, "bun.lockb"), "utf8").catch(() => null)) ||
          (await readFile(join(root, "bunfig.toml"), "utf8").catch(() => null));
        testCommand = hasBun ? "bun run test" : "npm test";
      }
      if (pkg.scripts?.build) {
        const hasBun = await readFile(join(root, "bun.lockb"), "utf8").catch(() => null);
        buildCommand = hasBun ? "bun run build" : "npm run build";
      }
    } catch {
      // ignore
    }
  }

  // 2. Python check
  const hasRequirements = await readFile(join(root, "requirements.txt"), "utf8").catch(() => null);
  const hasPyproject = await readFile(join(root, "pyproject.toml"), "utf8").catch(() => null);
  if (hasRequirements || hasPyproject) {
    languages.push("Python");
    if (!testCommand) testCommand = "pytest";
  }

  // 3. Rust check
  const cargoToml = await readFile(join(root, "Cargo.toml"), "utf8").catch(() => null);
  if (cargoToml) {
    languages.push("Rust");
    if (!testCommand) testCommand = "cargo test";
    if (!buildCommand) buildCommand = "cargo build";
  }

  // 4. Go check
  const goMod = await readFile(join(root, "go.mod"), "utf8").catch(() => null);
  if (goMod) {
    languages.push("Go");
    if (!testCommand) testCommand = "go test ./...";
    if (!buildCommand) buildCommand = "go build";
  }

  // Fallback defaults if none detected
  if (languages.length === 0) {
    languages.push("Plain text / Unknown");
  }

  // Scaffold content
  const content = `# Project Guidelines (FORGE.md)

This file contains coding conventions, project structure details, and commands for the Forge agent.

## Technology Stack
- **Languages**: ${languages.join(", ")}
- **Style/Linting**: Biome / ESLint / Prettier

## Commands
${buildCommand ? `- **Build**: \`${buildCommand}\`\n` : ""}${testCommand ? `- **Test**: \`${testCommand}\`\n` : ""}- **Verify/Lint**: \`bun run check\` or equivalent

## Coding Conventions
- Write clean, type-safe, and self-documenting code.
- Add descriptive unit tests for all new features.
- Avoid repeating existing utility functions; reuse the codebase structures.
`;

  await writeFile(forgeMdPath, content, "utf8");
  log.success(`✨ Successfully generated project guidelines template at ${pc.cyan("FORGE.md")}`);
}
