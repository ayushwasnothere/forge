import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { MemoryStore } from "@forge/memory";
import type { Tool, ToolExecutionContext, ToolResult } from "@forge/types";
import ts from "typescript";
import { z } from "zod";

// ─── Shared skip-directory set (C6) ──────────────────────────────────────────
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
]);

if (typeof Bun === "undefined") {
  // biome-ignore lint/suspicious/noExplicitAny: polyfill
  (globalThis as any).Bun = {
    // biome-ignore lint/suspicious/noExplicitAny: polyfill
    spawn(command: string[], options: any = {}) {
      const proc = nodeSpawn(command[0] as string, command.slice(1), {
        // biome-ignore lint/suspicious/noExplicitAny: polyfill
        cwd: options.cwd as any,
        env: process.env,
        // biome-ignore lint/suspicious/noExplicitAny: polyfill
      }) as any;
      return {
        exited: new Promise<number>((resolve) => {
          proc.on("exit", (code: number | null) => resolve(code ?? 0));
          proc.on("error", () => resolve(1));
        }),
        stdout: proc.stdout ? Readable.toWeb(proc.stdout) : new ReadableStream(),
        stderr: proc.stderr ? Readable.toWeb(proc.stderr) : new ReadableStream(),
        kill() {
          proc.kill();
        },
      };
    },
  };
}

export interface RegisteredTool<TInput = unknown, TData = unknown> extends Tool<TInput, TData> {
  readonly inputSchema: z.ZodType<TInput>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`A tool named "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): readonly Pick<RegisteredTool, "name" | "description" | "permission">[] {
    return [...this.tools.values()].map(({ name, description, permission }) => ({
      name,
      description,
      permission,
    }));
  }

  definitions(): readonly {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
    }));
  }

  async execute(name: string, input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return failure(`Unknown tool: ${name}`);
    }

    // A7: Central permission enforcement — check before delegating to tool.
    // Allow proceeding if the appropriate approval callback is available.
    const perm = tool.permission;
    if (perm === "write" && !hasPermission(context, "write") && !context.onApproveFileChange) {
      return failure(`Write permission is required to use ${name}.`);
    }
    if (perm === "execute" && !hasPermission(context, "execute") && !context.onApproveCommand) {
      return failure(`Execute permission is required to use ${name}.`);
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return failure(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
    }

    try {
      return await tool.execute(parsed.data, context);
    } catch (err) {
      return failure(`Tool ${name} threw an error: ${toMessage(err)}`);
    }
  }
}

// ─── Input schemas ────────────────────────────────────────────────────────────

const pathInputSchema = z.object({ path: z.string().min(1) });

const readFileInputSchema = z.object({
  path: z.string().min(1).describe("Repository-relative or absolute path to the file."),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based first line to read (inclusive). Omit to start from line 1."),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based last line to read (inclusive). Omit to read to end of file."),
});

const listDirectoryInputSchema = z.object({
  path: z.string().min(1).describe("Repository-relative path to the directory."),
  recursive: z
    .boolean()
    .default(false)
    .describe(
      "When true, list recursively up to 3 levels deep. Skips node_modules/.git/dist/build.",
    ),
});

const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().default(false),
});

const applyPatchInputSchema = z.object({
  patch: z
    .string()
    .min(1)
    .describe(
      "A unified diff string (--- a/file +++ b/file format). Applied relative to repository root.",
    ),
});

const findFilesInputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "Glob pattern relative to repository root. Examples: '**/*.ts', 'src/**/*.test.ts', '*.json'.",
    ),
  excludePatterns: z
    .array(z.string())
    .default([])
    .describe("Additional glob patterns to exclude. node_modules, .git, dist are always excluded."),
  maxResults: z.number().int().positive().max(500).default(100),
});

const listSymbolsInputSchema = z.object({
  path: z.string().min(1).describe("Repository-relative path to the source file."),
});

const runCommandInputSchema = z.object({
  command: z.string().min(1),
});

const searchCodeInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Literal text or regex pattern to search for. Use this before reading files to find the right location.",
    ),
  path: z.string().default(".").describe("Repository-relative path to search under."),
  filePattern: z
    .string()
    .optional()
    .describe("Restrict search to files matching this glob, e.g. '*.ts'."),
  maxResults: z.number().int().positive().max(200).default(50),
  caseSensitive: z.boolean().default(true),
  isRegex: z.boolean().default(false),
});

const rememberFactInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe("The unique name/key for this memory, e.g. 'python_path' or 'user_preferences'."),
  value: z.string().min(1).describe("The facts, settings, or learnings to store for this key."),
});

const forgetFactInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe("The key to delete from memory. Use recall_facts first to see all stored keys."),
});

const recallFactsInputSchema = z.object({});

const gitCommitInputSchema = z.object({
  message: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});

const gitDiffInputSchema = z.object({
  path: z.string().optional().describe("Limit diff to this repository-relative path."),
  staged: z.boolean().default(false).describe("Show staged (cached) changes instead of unstaged."),
});

const gitLogInputSchema = z.object({
  maxCommits: z.number().int().positive().max(50).default(10),
  path: z.string().optional().describe("Limit log to commits touching this path."),
});

const gitBlameInputSchema = z.object({
  path: z.string().min(1).describe("Repository-relative path to annotate."),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

const replaceTextInputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
});

// ─── Tools ────────────────────────────────────────────────────────────────────

export const readFileTool: RegisteredTool<
  { path: string; startLine?: number | undefined; endLine?: number | undefined },
  ReadFileData
> = {
  name: "read_file",
  description:
    "Read a UTF-8 source file. Optionally specify startLine/endLine (1-based) to read a slice. Always shows line numbers so you can reference exact locations.",
  permission: "read",
  inputSchema: readFileInputSchema as z.ZodType<{
    path: string;
    startLine?: number | undefined;
    endLine?: number | undefined;
  }>,
  async execute({ path, startLine, endLine }, context) {
    const startedAt = performance.now();
    try {
      const absolutePath = resolveRepositoryPath(context.repositoryPath, path);
      const fileInfo = await stat(absolutePath);
      if (!fileInfo.isFile()) {
        return failure<ReadFileData>(`${path} is not a file.`, startedAt);
      }
      const rawContent = await readFile(absolutePath, "utf8");
      const allLines = rawContent.split("\n");
      const totalLines = allLines.length;

      const from = Math.max(1, startLine ?? 1);
      const to = Math.min(totalLines, endLine ?? totalLines);
      const slicedLines = allLines.slice(from - 1, to);

      // Prepend 1-based line numbers padded to width
      const width = String(to).length;
      const numberedContent = slicedLines
        .map((line, i) => `${String(from + i).padStart(width, " ")} │ ${line}`)
        .join("\n");

      const budget = context.tokenBudget ?? 80_000;
      const maxChars = Math.min(40_000, budget * 4);
      const content =
        numberedContent.length > maxChars
          ? `${numberedContent.slice(0, maxChars)}\n… (truncated — use startLine/endLine to read a specific range)`
          : numberedContent;

      return success<ReadFileData>(
        { path: absolutePath, content, totalLines, fromLine: from, toLine: to },
        startedAt,
      );
    } catch (error) {
      return failure<ReadFileData>(toMessage(error), startedAt);
    }
  },
};

export interface ReadFileData {
  path: string;
  content: string;
  totalLines: number;
  fromLine: number;
  toLine: number;
}

export const listDirectoryTool: RegisteredTool<
  { path: string; recursive: boolean },
  { path: string; entries: readonly DirectoryEntry[] }
> = {
  name: "list_directory",
  description:
    "List the contents of a directory. Set recursive=true to list up to 3 levels deep. Prefer find_files or search_code when looking for specific files.",
  permission: "read",
  inputSchema: listDirectoryInputSchema,
  async execute({ path, recursive }, context) {
    const startedAt = performance.now();
    try {
      const absolutePath = resolveRepositoryPath(context.repositoryPath, path);
      const directoryInfo = await stat(absolutePath);
      if (!directoryInfo.isDirectory()) {
        return failure<{ path: string; entries: readonly DirectoryEntry[] }>(
          `${path} is not a directory.`,
          startedAt,
        );
      }
      const entries = recursive
        ? await collectRecursive(absolutePath, absolutePath, 0, 3, SKIP_DIRS)
        : (await readdir(absolutePath, { withFileTypes: true }))
            .map((e) => ({
              name: e.name,
              relativePath: e.name,
              type: directoryEntryType(e),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

      return success({ path: absolutePath, entries }, startedAt);
    } catch (error) {
      return failure<{ path: string; entries: readonly DirectoryEntry[] }>(
        toMessage(error),
        startedAt,
      );
    }
  },
};

async function collectRecursive(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  skip: Set<string>,
): Promise<DirectoryEntry[]> {
  if (depth >= maxDepth) return [];
  const rawEntries = await readdir(dir, { withFileTypes: true });
  const result: DirectoryEntry[] = [];
  for (const e of rawEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.has(e.name)) continue;
    const rel = relative(root, join(dir, e.name));
    const type = directoryEntryType(e);
    result.push({ name: e.name, relativePath: rel, type });
    if (type === "directory" && depth + 1 < maxDepth) {
      const children = await collectRecursive(root, join(dir, e.name), depth + 1, maxDepth, skip);
      result.push(...children);
    }
  }
  return result;
}

export const findFilesTool: RegisteredTool<
  { pattern: string; excludePatterns: string[]; maxResults: number },
  { files: string[]; total: number }
> = {
  name: "find_files",
  description:
    "Find files matching a glob pattern across the repository. More efficient than recursively listing directories. Example patterns: '**/*.ts', 'src/**/*.test.ts', '**/package.json'.",
  permission: "read",
  inputSchema: findFilesInputSchema,
  async execute({ pattern, excludePatterns, maxResults }, context) {
    const startedAt = performance.now();
    try {
      const repoRoot = context.repositoryPath;
      let files: string[] = [];

      if (typeof Bun !== "undefined" && typeof Bun.Glob !== "undefined") {
        // G5: Use Bun.Glob for correct and fast glob matching when available
        const glob = new Bun.Glob(pattern);
        const excludeRegexes = excludePatterns.map(globToRegExp);

        for await (const file of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
          const normalized = file.replace(/\\/g, "/");
          const parts = normalized.split("/");
          if (parts.some((p) => SKIP_DIRS.has(p))) continue;
          if (excludeRegexes.some((rx) => rx.test(normalized))) continue;
          files.push(normalized);
        }
      } else {
        // Fallback: manual glob search in non-Bun environments (e.g. Node/Vitest)
        files = await globMatch(repoRoot, pattern, SKIP_DIRS, excludePatterns);
      }

      files.sort();
      const limited = files.slice(0, maxResults);
      return success({ files: limited, total: files.length }, startedAt);
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

async function globMatch(
  root: string,
  pattern: string,
  skipDirs: Set<string>,
  extraExclude: string[],
): Promise<string[]> {
  const regex = globToRegExp(pattern);
  const excludeRegexes = extraExclude.map(globToRegExp);

  const results: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (skipDirs.has(e.name)) continue;
      const fullPath = join(dir, e.name);
      const rel = relative(root, fullPath).replace(/\\/g, "/");
      if (excludeRegexes.some((rx) => rx.test(rel))) continue;
      if (e.isDirectory()) {
        await walk(fullPath);
      } else if (regex.test(rel)) {
        results.push(rel);
      }
    }
  }
  await walk(root);
  return results.sort();
}

/**
 * Translate a glob pattern to an anchored RegExp. A leading `**​/` (or `/**​/`)
 * matches zero or more directories, so `**​/*.ts` also matches a root-level
 * `index.ts`. `**` matches across path separators, `*` within a segment.
 */
function globToRegExp(pattern: string): RegExp {
  const DSTAR_SLASH = " DSS ";
  const DSTAR = " DS ";
  const body = pattern
    .replace(/\*\*\//g, DSTAR_SLASH)
    .replace(/\*\*/g, DSTAR)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(new RegExp(DSTAR_SLASH, "g"), "(?:.*/)?")
    .replace(new RegExp(DSTAR, "g"), ".*");
  return new RegExp(`^${body}$`);
}
export const listSymbolsTool: RegisteredTool<
  { path: string },
  { path: string; symbols: SymbolEntry[] }
> = {
  name: "list_symbols",
  description:
    "Extract function, class, interface, type alias, and variable declarations from a source file. Faster than reading the whole file to find where something is defined.",
  permission: "read",
  inputSchema: listSymbolsInputSchema,
  async execute({ path }, context) {
    const startedAt = performance.now();
    try {
      const absolutePath = resolveRepositoryPath(context.repositoryPath, path);
      const content = await readFile(absolutePath, "utf8").catch(() => null);
      if (content === null) return failure(`Could not read file: ${path}`, startedAt);
      const ext = extname(path).toLowerCase();
      const symbols = extractSymbols(content, ext);
      return success({ path: absolutePath, symbols }, startedAt);
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

export interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "export" | "other";
  line: number;
}

function extractSymbols(content: string, ext: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  // JS / TS / TSX / JSX - AST compiler API parser
  if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs"].includes(ext)) {
    try {
      const sourceFile = ts.createSourceFile(`file${ext}`, content, ts.ScriptTarget.Latest, true);

      function visit(node: ts.Node) {
        let name = "";
        let kind: SymbolEntry["kind"] | null = null;

        if (ts.isFunctionDeclaration(node) && node.name) {
          name = node.name.text;
          kind = "function";
        } else if (ts.isClassDeclaration(node) && node.name) {
          name = node.name.text;
          kind = "class";
        } else if (ts.isInterfaceDeclaration(node) && node.name) {
          name = node.name.text;
          kind = "interface";
        } else if (ts.isTypeAliasDeclaration(node) && node.name) {
          name = node.name.text;
          kind = "type";
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          // Verify it's a top-level exported/assigned declaration
          const varList = node.parent;
          if (ts.isVariableDeclarationList(varList) && ts.isVariableStatement(varList.parent)) {
            name = node.name.text;
            kind = "variable";
          }
        }

        if (kind && name) {
          const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
          symbols.push({ name, kind, line: line + 1 });
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      return symbols.sort((a, b) => a.line - b.line);
    } catch {
      // Fall through to regex if AST parser fails
    }
  }

  // Fallback regex matching (Python, Rust, Go, or failed JS/TS parse)
  const lines = content.split("\n");
  const patterns: Array<{ rx: RegExp; kind: SymbolEntry["kind"] }> = [];

  if (ext === ".py") {
    patterns.push(
      { rx: /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "function" },
      { rx: /^class\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "class" },
    );
  } else if (ext === ".rs") {
    patterns.push(
      {
        rx: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: "function",
      },
      { rx: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "class" },
      { rx: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "interface" },
      { rx: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "type" },
      { rx: /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "type" },
    );
  } else if (ext === ".go") {
    patterns.push(
      { rx: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/, kind: "function" },
      { rx: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct/, kind: "class" },
      { rx: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface/, kind: "interface" },
      { rx: /^type\s+([A-Za-z_][A-Za-z0-9_]*)/, kind: "type" },
    );
  }

  for (let i = 0; i < lines.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: loop index is in bounds
    const line = lines[i]!.trimStart();
    for (const { rx, kind } of patterns) {
      const match = rx.exec(line);
      if (match?.[1]) {
        symbols.push({ name: match[1].trim(), kind, line: i + 1 });
        break;
      }
    }
  }
  return symbols;
}

export const replaceTextTool: RegisteredTool<
  { path: string; oldText: string; newText: string },
  { path: string; replacements: 1; preview?: string }
> = {
  name: "replace_text",
  description:
    "Safely replace exactly one occurrence of a text block in a file. The oldText must match exactly (including whitespace/indentation). Use this for targeted edits rather than rewriting whole files.",
  permission: "write",
  inputSchema: replaceTextInputSchema,
  async execute({ path, oldText, newText }, context) {
    const startedAt = performance.now();
    // A8: Use shared hasPermission() helper instead of inline check, allowing override if onApproveFileChange is present
    if (!hasPermission(context, "write") && !context.onApproveFileChange) {
      return failure<{ path: string; replacements: 1 }>(
        "Write permission is required to use replace_text.",
        startedAt,
      );
    }

    try {
      const absolutePath = resolveRepositoryPath(context.repositoryPath, path);
      const fileInfo = await stat(absolutePath);
      if (!fileInfo.isFile()) {
        return failure<{ path: string; replacements: 1 }>(`${path} is not a file.`, startedAt);
      }

      const content = await readFile(absolutePath, "utf8");
      const matches = content.split(oldText).length - 1;
      if (matches !== 1) {
        return failure<{ path: string; replacements: 1 }>(
          `Expected exactly one matching text segment in ${path}; found ${matches}.`,
          startedAt,
        );
      }

      const oldMatchStart = content.indexOf(oldText);
      const newContent = content.split(oldText).join(newText);
      if (context.onApproveFileChange) {
        const approved = await context.onApproveFileChange(path, newContent, content);
        if (!approved) {
          return failure<{ path: string; replacements: 1; preview: string }>(
            "File replacement request was rejected by the user.",
            startedAt,
          );
        }
      }

      await writeFile(absolutePath, newContent, "utf8");

      // Build a ±3-line context snippet around the changed region so the model
      // can self-verify the edit without a follow-up read_file call.
      const newLines = newContent.split("\n");
      const linesBefore = content.slice(0, Math.max(0, oldMatchStart)).split("\n").length - 1;
      const contextFrom = Math.max(0, linesBefore - 3);
      const contextTo = Math.min(newLines.length, linesBefore + newText.split("\n").length + 3);
      const snippet = newLines
        .slice(contextFrom, contextTo)
        .map((l, i) => `${String(contextFrom + i + 1).padStart(4)} │ ${l}`)
        .join("\n");

      return success({ path: absolutePath, replacements: 1 as const, preview: snippet }, startedAt);
    } catch (error) {
      return failure<{ path: string; replacements: 1; preview: string }>(
        toMessage(error),
        startedAt,
      );
    }
  },
};

export const writeFileTool: RegisteredTool<
  { path: string; content: string; overwrite: boolean },
  { path: string; bytesWritten: number; preview?: string }
> = {
  name: "write_file",
  description:
    "Create a UTF-8 file, or overwrite an existing file only when explicitly requested. Parent directories are created automatically. Prefer replace_text for targeted edits.",
  permission: "write",
  inputSchema: writeFileInputSchema,
  async execute({ path, content, overwrite }, context) {
    const startedAt = performance.now();
    if (!hasPermission(context, "write") && !context.onApproveFileChange)
      return failure("Write permission is required to use write_file.", startedAt);
    try {
      const absolutePath = resolveRepositoryPath(context.repositoryPath, path);
      const exists = await stat(absolutePath)
        .then(() => true)
        .catch(() => false);
      if (exists && !overwrite)
        return failure(`${path} already exists; set overwrite to true to replace it.`, startedAt);

      const originalContent = exists
        ? await readFile(absolutePath, "utf8").catch(() => undefined)
        : undefined;
      if (context.onApproveFileChange) {
        const approved = await context.onApproveFileChange(path, content, originalContent);
        if (!approved) {
          return failure("File write request was rejected by the user.", startedAt);
        }
      }

      // Auto-create parent directories
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
      // Return a preview of the first 20 lines so the model can confirm the
      // file looks correct without a follow-up read_file call.
      const previewLines = content.split("\n").slice(0, 20);
      const preview =
        previewLines.map((l, i) => `${String(i + 1).padStart(4)} │ ${l}`).join("\n") +
        (content.split("\n").length > 20 ? "\n     … (truncated)" : "");
      return success(
        { path: absolutePath, bytesWritten: Buffer.byteLength(content), preview },
        startedAt,
      );
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

export const applyPatchTool: RegisteredTool<{ patch: string }, ApplyPatchResult> = {
  name: "apply_patch",
  description:
    "Apply a unified diff (--- a/file +++ b/file format) to files in the repository. This is the preferred way to make multi-line edits — generate a diff and apply it instead of rewriting the whole file.",
  permission: "write",
  inputSchema: applyPatchInputSchema,
  async execute({ patch }, context) {
    const startedAt = performance.now();
    if (!hasPermission(context, "write") && !context.onApproveFileChange)
      return failure("Write permission is required to use apply_patch.", startedAt);
    try {
      const result = await applyUnifiedDiff(patch, context.repositoryPath, context);
      return success(result, startedAt);
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

export interface ApplyPatchResult {
  filesPatched: string[];
  hunksApplied: number;
  hunksRejected: number;
}

async function applyUnifiedDiff(
  patchText: string,
  repositoryPath: string,
  context?: ToolExecutionContext,
): Promise<ApplyPatchResult> {
  const fileBlocks = splitFileBlocks(patchText);
  const result: ApplyPatchResult = { filesPatched: [], hunksApplied: 0, hunksRejected: 0 };

  for (const block of fileBlocks) {
    const lines = block.split("\n");
    // Find target file path from +++ line
    const targetLine = lines.find((l) => l.startsWith("+++ "));
    if (!targetLine) continue;
    const targetPath = targetLine
      .replace(/^\+\+\+ /, "")
      .replace(/^[ab]\//, "")
      .split("\t")[0];
    if (!targetPath || targetPath === "/dev/null") continue;

    try {
      // Route through the shared confinement helper (symlink + drive checks).
      const absolutePath = resolveRepositoryPath(repositoryPath, targetPath);
      const rel = relative(resolve(repositoryPath), absolutePath);

      const originalContent = await readFile(absolutePath, "utf8").catch(() => "");
      const contentLines = originalContent.replace(/\r\n/g, "\n").split("\n");

      // Apply hunks all-or-nothing: verify every hunk against the file first.
      // If any hunk fails context/removal verification we reject the whole file
      // rather than write a half-applied (corrupt) result.
      const hunks = parseHunks(lines);
      let offset = 0;
      let allApplied = true;
      for (const hunk of hunks) {
        const applied = applyHunk(contentLines, hunk, offset);
        if (applied.success) {
          offset += applied.offset;
        } else {
          allApplied = false;
          break;
        }
      }

      if (!allApplied) {
        result.hunksRejected += hunks.length;
        continue;
      }

      const content = contentLines.join("\n");
      if (context?.onApproveFileChange) {
        const approved = await context.onApproveFileChange(
          targetPath,
          content,
          originalContent || undefined,
        );
        if (!approved) {
          result.hunksRejected += hunks.length;
          continue;
        }
      }

      result.hunksApplied += hunks.length;
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
      result.filesPatched.push(rel.replace(/\\/g, "/"));
    } catch {
      result.hunksRejected++;
    }
  }
  return result;
}

/**
 * Split a unified diff into per-file blocks. A `--- ` line only begins a new
 * block when the following line is a `+++ ` header — this avoids splitting on
 * removed content lines that happen to start with "--- ".
 */
function splitFileBlocks(patchText: string): string[] {
  const lines = patchText.split("\n");
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const isHeader = line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ");
    if (isHeader) {
      if (current?.join("\n").trim()) blocks.push(current.join("\n"));
      current = [];
    }
    if (current) current.push(line);
  }
  if (current?.join("\n").trim()) blocks.push(current.join("\n"));
  return blocks;
}

interface Hunk {
  startLine: number; // 1-based original
  lines: string[];
}

function parseHunks(diffLines: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of diffLines) {
    const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunkHeader) {
      current = { startLine: Number.parseInt(hunkHeader[1] ?? "0", 10), lines: [] };
      hunks.push(current);
    } else if (current && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/**
 * Apply one hunk by walking its body in order against `fileLines`, starting near
 * the hunk's declared start position. Context (" ") and removal ("-") lines must
 * match the current file line; additions ("+") are inserted. If any context or
 * removal line fails to match — even after a small ±offset search — the hunk is
 * rejected and `fileLines` is left untouched.
 */
function applyHunk(
  fileLines: string[],
  hunk: Hunk,
  offset: number,
): { success: boolean; offset: number } {
  // Locate the actual start: the first context/removal line may have drifted
  // from startLine due to earlier hunks, so search a ±5 window for alignment.
  const anchor = firstAnchorLine(hunk.lines);
  let start = hunk.startLine - 1 + offset;
  if (anchor !== null) {
    const found = findAnchor(fileLines, anchor, start);
    if (found === -1) return { success: false, offset: 0 };
    start = found;
  } else {
    // Pure-insertion hunk (no context/removals): clamp to a valid position.
    if (start < 0) start = 0;
    if (start > fileLines.length) start = fileLines.length;
  }

  // Verify and build the replacement by walking the hunk body in order.
  const patched: string[] = [];
  let cursor = start;
  for (const line of hunk.lines) {
    const kind = line[0];
    const text = line.slice(1);
    if (kind === " ") {
      if (fileLines[cursor] !== text) return { success: false, offset: 0 };
      patched.push(text);
      cursor++;
    } else if (kind === "-") {
      if (fileLines[cursor] !== text) return { success: false, offset: 0 };
      cursor++; // drop the removed line
    } else if (kind === "+") {
      patched.push(text);
    }
  }

  const removedCount = cursor - start;
  fileLines.splice(start, removedCount, ...patched);
  return { success: true, offset: patched.length - removedCount };
}

/** First context/removal line text of a hunk (the alignment anchor), or null. */
function firstAnchorLine(hunkLines: string[]): string | null {
  for (const line of hunkLines) {
    if (line.startsWith(" ") || line.startsWith("-")) return line.slice(1);
  }
  return null;
}

/** Find `anchor` in `fileLines` near `guess` (exact hit first, then ±5 window). */
function findAnchor(fileLines: string[], anchor: string, guess: number): number {
  if (fileLines[guess] === anchor) return guess;
  for (let delta = 1; delta <= 5; delta++) {
    if (guess - delta >= 0 && fileLines[guess - delta] === anchor) return guess - delta;
    if (guess + delta < fileLines.length && fileLines[guess + delta] === anchor)
      return guess + delta;
  }
  return -1;
}

export const runCommandTool: RegisteredTool<{ command: string }, CommandResult> = {
  name: "run_command",
  description:
    "Run a shell command in the repository root and capture output. Use for build, test, lint commands. Requires execute permission or interactive approval.",
  permission: "execute",
  inputSchema: runCommandInputSchema,
  async execute({ command }, context) {
    const startedAt = performance.now();
    if (!hasPermission(context, "execute")) {
      if (context.onApproveCommand) {
        const approved = await context.onApproveCommand(command);
        if (!approved) {
          return failure("Execute permission was denied by the user.", startedAt);
        }
      } else {
        return failure("Execute permission is required to use run_command.", startedAt);
      }
    }
    try {
      if (context.sandbox) {
        const res = await context.sandbox.execute(
          shellCommand(command),
          context.repositoryPath,
          context.commandTimeoutMs,
          context.signal,
        );
        return success(
          {
            exitCode: res.exitCode,
            stdout: truncate(res.stdout),
            stderr: truncate(res.stderr),
          } as unknown as CommandResult,
          startedAt,
        );
      }
      return success(await runProcess(shellCommand(command), context), startedAt);
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

export const searchCodeTool: RegisteredTool<
  {
    query: string;
    path: string;
    filePattern?: string | undefined;
    maxResults: number;
    caseSensitive: boolean;
    isRegex: boolean;
  },
  SearchResult
> = {
  name: "search_code",
  description:
    "Search repository source code with ripgrep. Returns file:line:content matches. Always search before reading files — it is much faster than listing directories.",
  permission: "read",
  inputSchema: searchCodeInputSchema as z.ZodType<{
    query: string;
    path: string;
    filePattern?: string | undefined;
    maxResults: number;
    caseSensitive: boolean;
    isRegex: boolean;
  }>,
  async execute({ query, path, filePattern, maxResults, caseSensitive, isRegex }, context) {
    const startedAt = performance.now();
    try {
      const absolutePath = resolveRepositoryPath(context.repositoryPath, path);
      const args = ["rg", "--json", "--max-count", String(maxResults), "--max-filesize", "500K"];
      if (!caseSensitive) args.push("--ignore-case");
      if (!isRegex) args.push("--fixed-strings");
      if (filePattern) args.push("--glob", filePattern);
      args.push(query, absolutePath);

      // Attempt ripgrep. A missing binary makes Bun.spawn throw (ENOENT) or exit
      // non-zero with a "not found" message — either way we fall back to a
      // pure-JS search rather than surfacing a failure to the model.
      let raw: CommandResult | null = null;
      try {
        raw = await runProcess(args, context);
      } catch {
        raw = null;
      }

      const matches: SearchMatch[] = [];
      const rgUsable =
        raw !== null &&
        !(
          raw.exitCode !== 0 &&
          (raw.stderr.includes("not found") ||
            raw.stderr.includes("not recognized") ||
            raw.stderr.includes("ENOENT") ||
            raw.stderr.includes("No such file or directory") ||
            raw.stderr.includes("cannot find"))
        );

      if (rgUsable && raw) {
        // Parse ripgrep JSON output
        for (const line of raw.stdout.split("\n")) {
          if (!line.trim()) continue;
          if (matches.length >= maxResults) break;
          try {
            const obj = JSON.parse(line) as RipgrepMessage;
            if (obj.type === "match") {
              const filePath = relative(context.repositoryPath, obj.data.path.text).replace(
                /\\/g,
                "/",
              );
              for (const subMatch of obj.data.submatches) {
                matches.push({
                  file: filePath,
                  line: obj.data.line_number,
                  column: subMatch.start + 1,
                  text: obj.data.lines.text.trimEnd(),
                });
              }
            }
          } catch {
            // not JSON (e.g. error output) — skip
          }
        }

        const truncated = matches.length >= maxResults;
        return success<SearchResult>(
          { matches: matches.slice(0, maxResults), total: matches.length, truncated },
          startedAt,
        );
      }

      // Fallback: pure-JS text search (ripgrep unavailable).
      const fallbackMatches = await textSearch(
        context.repositoryPath,
        absolutePath,
        query,
        caseSensitive,
        isRegex,
        maxResults,
      );
      return success<SearchResult>(
        {
          matches: fallbackMatches,
          total: fallbackMatches.length,
          truncated: fallbackMatches.length >= maxResults,
        },
        startedAt,
      );
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

interface RipgrepMessage {
  type: string;
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
    submatches: Array<{ start: number; end: number; match: { text: string } }>;
  };
}

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  total: number;
  truncated: boolean;
}

async function textSearch(
  repoRoot: string,
  searchRoot: string,
  query: string,
  caseSensitive: boolean,
  isRegex: boolean,
  maxResults: number,
): Promise<SearchMatch[]> {
  const results: SearchMatch[] = [];
  // G4: Use shared SKIP_DIRS set
  const rx = isRegex
    ? new RegExp(query, caseSensitive ? "g" : "gi")
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");

  const MAX_FILE_SIZE = 500 * 1024; // 500 KB

  async function walk(dir: string) {
    if (results.length >= maxResults) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        // G4: Skip files larger than 500 KB to avoid loading huge files
        const fileInfo = await stat(full).catch(() => null);
        if (!fileInfo || fileInfo.size > MAX_FILE_SIZE) continue;
        const text = await readFile(full, "utf8").catch(() => null);
        if (!text) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          rx.lastIndex = 0;
          // biome-ignore lint/style/noNonNullAssertion: loop index is in bounds
          if (rx.test(lines[i]!)) {
            results.push({
              file: relative(repoRoot, full).replace(/\\/g, "/"),
              line: i + 1,
              column: 1,
              // biome-ignore lint/style/noNonNullAssertion: loop index is in bounds
              text: lines[i]!.trimEnd(),
            });
          }
        }
      }
    }
  }
  await walk(searchRoot);
  return results;
}

export const gitStatusTool: RegisteredTool<Record<string, never>, CommandResult> = {
  name: "git_status",
  description: "Show concise Git repository status (branch, staged, unstaged, untracked files).",
  permission: "read",
  inputSchema: z.object({}),
  async execute(_input, context) {
    const startedAt = performance.now();
    return success(await runProcess(["git", "status", "--short", "--branch"], context), startedAt);
  },
};

export const gitDiffTool: RegisteredTool<
  { path?: string | undefined; staged: boolean },
  CommandResult
> = {
  name: "git_diff",
  description:
    "Show Git changes. Optionally limit to a specific path. Set staged=true to see staged (cached) changes.",
  permission: "read",
  inputSchema: gitDiffInputSchema as z.ZodType<{ path?: string | undefined; staged: boolean }>,
  async execute({ path, staged }, context) {
    const startedAt = performance.now();
    const args = ["git", "diff", "--no-ext-diff"];
    if (staged) args.push("--cached");
    if (path) {
      const abs = resolveRepositoryPath(context.repositoryPath, path);
      args.push("--", abs);
    }
    return success(await runProcess(args, context), startedAt);
  },
};

export const gitLogTool: RegisteredTool<
  { maxCommits: number; path?: string | undefined },
  CommandResult
> = {
  name: "git_log",
  description:
    "Show recent Git commit history. Optionally filter by path to see commits touching a specific file or directory.",
  permission: "read",
  inputSchema: gitLogInputSchema as z.ZodType<{ maxCommits: number; path?: string | undefined }>,
  async execute({ maxCommits, path }, context) {
    const startedAt = performance.now();
    const args = ["git", "log", `--max-count=${maxCommits}`, "--oneline", "--decorate", "--graph"];
    if (path) {
      const abs = resolveRepositoryPath(context.repositoryPath, path);
      args.push("--", abs);
    }
    return success(await runProcess(args, context), startedAt);
  },
};

export const gitBlameTool: RegisteredTool<
  { path: string; startLine?: number | undefined; endLine?: number | undefined },
  CommandResult
> = {
  name: "git_blame",
  description:
    "Show who last modified each line of a file (git blame). Useful for understanding context around a bug.",
  permission: "read",
  inputSchema: gitBlameInputSchema as z.ZodType<{
    path: string;
    startLine?: number | undefined;
    endLine?: number | undefined;
  }>,
  async execute({ path, startLine, endLine }, context) {
    const startedAt = performance.now();
    const absolutePath = resolveRepositoryPath(context.repositoryPath, path);
    const args = ["git", "blame", "--line-porcelain"];
    if (startLine !== undefined && endLine !== undefined) {
      args.push(`-L${startLine},${endLine}`);
    } else if (startLine !== undefined) {
      args.push(`-L${startLine},+20`);
    }
    args.push(absolutePath);
    return success(await runProcess(args, context), startedAt);
  },
};

export const gitCommitTool: RegisteredTool<{ message: string; paths: string[] }, CommandResult> = {
  name: "git_commit",
  description: "Stage specific repository-relative paths and create a Git commit.",
  permission: "write",
  inputSchema: gitCommitInputSchema,
  async execute({ message, paths }, context) {
    const startedAt = performance.now();
    if (!hasPermission(context, "write"))
      return failure("Write permission is required to use git_commit.", startedAt);
    try {
      for (const path of paths) resolveRepositoryPath(context.repositoryPath, path);
      const staged = await runProcess(["git", "add", "--", ...paths], context);
      if (staged.exitCode !== 0) return success(staged, startedAt);
      return success(await runProcess(["git", "commit", "-m", message], context), startedAt);
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

export const rememberFactTool: RegisteredTool<
  { key: string; value: string },
  Record<string, string>
> = {
  name: "remember_fact",
  description:
    "Save a key fact, instruction, preference, or environment detail to the persistent memory.",
  permission: "write",
  inputSchema: rememberFactInputSchema,
  async execute({ key, value }, context) {
    const startedAt = performance.now();
    try {
      const facts = await MemoryStore.remember(context.repositoryPath, key, value);
      return success(facts, startedAt);
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

export const recallFactsTool: RegisteredTool<Record<string, never>, Record<string, string>> = {
  name: "recall_facts",
  description: "Recall all stored key facts, instructions, preferences, and environment details.",
  permission: "read",
  inputSchema: recallFactsInputSchema,
  async execute(_, context) {
    const startedAt = performance.now();
    try {
      const facts = await MemoryStore.load(context.repositoryPath);
      return success(facts, startedAt);
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

export const forgetFactTool: RegisteredTool<{ key: string }, Record<string, string>> = {
  name: "forget_fact",
  description:
    "Delete a stored fact or setting from persistent memory by its key. Use recall_facts first to see what is stored.",
  permission: "write",
  inputSchema: forgetFactInputSchema,
  async execute({ key }, context) {
    const startedAt = performance.now();
    try {
      const facts = await MemoryStore.forget(context.repositoryPath, key);
      return success(facts, startedAt);
    } catch (error) {
      return failure(toMessage(error), startedAt);
    }
  },
};

// ─── Tool result formatting for LLM consumption ──────────────────────────────

/**
 * Convert a raw ToolResult into a compact, human-readable string for LLM messages.
 * Prevents the LLM from drowning in raw JSON or massive stdout blobs.
 */
export function formatToolResult(
  toolName: string,
  result: ToolResult,
  repositoryPath?: string,
): string {
  if (!result.success) {
    return `❌ ${toolName} failed: ${result.error ?? "Unknown error"}`;
  }

  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return `✅ ${toolName} succeeded.`;

  const getDisplayPath = (p: string) => {
    if (!p) return "";
    return repositoryPath ? relative(repositoryPath, p) || "." : relative("", p) || p;
  };

  switch (toolName) {
    case "remember_fact": {
      const facts = data as Record<string, string>;
      return `🧠 Saved fact. Current stored facts:\n${Object.entries(facts)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")}`;
    }

    case "recall_facts": {
      const facts = data as Record<string, string>;
      if (Object.keys(facts).length === 0) return "🧠 No facts stored in memory yet.";
      return `🧠 Recalled facts:\n${Object.entries(facts)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")}`;
    }

    case "forget_fact": {
      const facts = data as Record<string, string>;
      if (Object.keys(facts).length === 0) return "🧠 Fact deleted. Memory is now empty.";
      return `🧠 Fact deleted. Remaining facts:\n${Object.entries(facts)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")}`;
    }

    case "read_file": {
      const d = data as unknown as ReadFileData;
      const rangeNote =
        d.fromLine === 1 && d.toLine === d.totalLines
          ? `${d.totalLines} lines`
          : `lines ${d.fromLine}–${d.toLine} of ${d.totalLines}`;
      return `📄 ${getDisplayPath(d.path)} (${rangeNote}):\n\`\`\`\n${d.content}\n\`\`\``;
    }

    case "list_directory": {
      const entries = data.entries as DirectoryEntry[];
      const dirs = entries.filter((e) => e.type === "directory");
      const files = entries.filter((e) => e.type === "file");
      const lines = [
        `📁 ${getDisplayPath(String(data.path))} — ${dirs.length} dirs, ${files.length} files:`,
        ...entries.map(
          (e) => `  ${e.type === "directory" ? "📂" : "📄"} ${e.relativePath ?? e.name}`,
        ),
      ];
      return lines.join("\n");
    }

    case "find_files": {
      const files = data.files as string[];
      const total = data.total as number;
      const truncNote = total > files.length ? ` (showing ${files.length}/${total})` : "";
      return `🔍 Found ${total} file(s)${truncNote}:\n${files.map((f) => `  ${f}`).join("\n")}`;
    }

    case "list_symbols": {
      const symbols = data.symbols as SymbolEntry[];
      if (symbols.length === 0)
        return `📋 No symbols found in ${getDisplayPath(String(data.path))}.`;
      const lines = symbols.map(
        (s) => `  ${s.line.toString().padStart(4)} │ [${s.kind.padEnd(9)}] ${s.name}`,
      );
      return `📋 Symbols in ${getDisplayPath(String(data.path))}:\n${lines.join("\n")}`;
    }

    case "search_code": {
      const sr = data as unknown as SearchResult;
      if (sr.matches.length === 0) return "🔍 No matches found.";
      const grouped = new Map<string, SearchMatch[]>();
      for (const m of sr.matches) {
        if (!grouped.has(m.file)) grouped.set(m.file, []);
        grouped.get(m.file)?.push(m);
      }
      const lines: string[] = [`🔍 ${sr.total} match(es)${sr.truncated ? " (truncated)" : ""}:`];
      for (const [file, matches] of grouped) {
        lines.push(`\n  ${file}:`);
        for (const m of matches) {
          lines.push(`    ${m.line}: ${m.text.trimStart()}`);
        }
      }
      return lines.join("\n");
    }

    case "write_file": {
      const preview = data.preview as string | undefined;
      const base = `✅ Wrote ${data.bytesWritten} bytes to ${getDisplayPath(String(data.path))}`;
      return preview ? `${base}\n\`\`\`\n${preview}\n\`\`\`` : base;
    }

    case "replace_text": {
      const preview = data.preview as string | undefined;
      const base = `✅ Applied 1 replacement in ${getDisplayPath(String(data.path))}`;
      return preview ? `${base} — result around edit:\n\`\`\`\n${preview}\n\`\`\`` : base;
    }

    case "apply_patch": {
      const r = data as unknown as ApplyPatchResult;
      const files = r.filesPatched.map((f) => getDisplayPath(f));
      return `✅ Patch applied: ${r.filesPatched.length} file(s) patched, ${r.hunksApplied} hunk(s) applied${r.hunksRejected > 0 ? `, ${r.hunksRejected} rejected` : ""}.\nFiles: ${files.join(", ")}`;
    }

    case "run_command":
    case "git_status":
    case "git_diff":
    case "git_log":
    case "git_blame":
    case "git_commit": {
      const r = data as unknown as CommandResult;
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
      const exitNote = r.exitCode !== 0 ? ` (exit ${r.exitCode})` : "";
      if (!out) return `✅ ${toolName}${exitNote}: (no output)`;
      return `${r.exitCode === 0 ? "✅" : "⚠️"} ${toolName}${exitNote}:\n\`\`\`\n${truncate(out, 8000)}\n\`\`\``;
    }

    default: {
      const json = JSON.stringify(data, null, 2);
      return `✅ ${toolName}:\n${truncate(json, 4000)}`;
    }
  }
}

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface DirectoryEntry {
  name: string;
  relativePath?: string;
  type: "directory" | "file" | "other";
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function resolveRepositoryPath(repositoryPath: string, requestedPath: string): string {
  const root = resolve(repositoryPath);
  const repoName = basename(root);

  let normalizedPath = requestedPath;
  const normalizedLower = requestedPath.replace(/\\/g, "/").toLowerCase();

  if (
    repoName &&
    (normalizedLower.startsWith(`${repoName.toLowerCase()}/`) ||
      normalizedLower === repoName.toLowerCase())
  ) {
    // If the repository name prefix was supplied (e.g. "sandbox/index.html"),
    // check if there is an actual folder with that name inside the workspace.
    // If not, it's a doubled path from the model and we strip the prefix.
    const internalDir = join(root, repoName);
    const hasInternalDir = existsSync(internalDir) && statSync(internalDir).isDirectory();
    if (!hasInternalDir) {
      normalizedPath = requestedPath.slice(repoName.length + 1);
    }
  }

  const candidate = resolve(root, normalizedPath);

  // Reject absolute paths that resolve onto a different Windows drive or UNC
  // share. `path.relative` returns the raw target (e.g. "D:\evil") in that
  // case, which does NOT start with "..", so the string check below would
  // wrongly accept it. Compare the filesystem roots explicitly.
  if (parse(candidate).root.toLowerCase() !== parse(root).root.toLowerCase()) {
    throw new Error(
      `Path must remain within the repository root (${root}). Rejected path: ${candidate} (different filesystem root).`,
    );
  }

  assertWithinRoot(root, candidate);

  // Defend against symlink escapes: resolve the real path of the candidate (or
  // its nearest existing ancestor, for files not yet created) and re-check.
  const real = realPathOrNearest(candidate);
  if (real !== candidate) {
    assertWithinRoot(realPathOrNearest(root), real);
  }

  return candidate;
}

/** Throw unless `candidate` is the root itself or a descendant of it (lexically). */
function assertWithinRoot(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  const inside =
    relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
  if (!inside) {
    throw new Error(
      `Path must remain within the repository root (${root}). Rejected path: ${candidate}. Use a path relative to the repository root, e.g. "sandbox/todo.py".`,
    );
  }
}

/**
 * Return the canonical (symlink-resolved) path of `target`. When `target` does
 * not exist yet (e.g. a write destination), resolve the closest existing
 * ancestor and re-append the remaining segments, so a symlinked parent
 * directory cannot be used to escape the repository root.
 */
function realPathOrNearest(target: string): string {
  let current = target;
  const trailing: string[] = [];
  while (true) {
    try {
      const resolved = realpathSync(current);
      return trailing.length > 0 ? join(resolved, ...trailing.reverse()) : resolved;
    } catch {
      const parent = dirname(current);
      if (parent === current) return target; // reached filesystem root; give up
      trailing.push(basename(current));
      current = parent;
    }
  }
}

function success<TData>(data: TData, startedAt: number): ToolResult<TData> {
  return { success: true, data, durationMs: performance.now() - startedAt, metadata: {} };
}

function failure<TData = unknown>(error: string, startedAt = performance.now()): ToolResult<TData> {
  return { success: false, error, durationMs: performance.now() - startedAt, metadata: {} };
}

function hasPermission(context: ToolExecutionContext, permission: "write" | "execute"): boolean {
  return context.allowedPermissions?.includes(permission) ?? false;
}

async function runProcess(
  command: string[],
  context: ToolExecutionContext,
): Promise<CommandResult> {
  const parentDir = dirname(context.repositoryPath);
  const proc = Bun.spawn(command, {
    cwd: context.repositoryPath,
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: parentDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let terminationReason: "timeout" | "cancelled" | undefined;
  const cancel = () => {
    terminationReason = "cancelled";
    proc.kill();
  };
  const timeoutMs = context.commandTimeoutMs ?? 60_000;
  const timeout = setTimeout(() => {
    terminationReason = "timeout";
    proc.kill();
  }, timeoutMs);
  context.signal?.addEventListener("abort", cancel, { once: true });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timeout);
  context.signal?.removeEventListener("abort", cancel);
  // E5: Use dynamic timeout value instead of hardcoded 60 seconds
  if (terminationReason === "timeout")
    throw new Error(`Command timed out after ${timeoutMs / 1000} seconds.`);
  if (terminationReason === "cancelled") throw new Error("Command was cancelled.");
  return { exitCode, stdout: truncate(stdout), stderr: truncate(stderr) };
}

function shellCommand(command: string): string[] {
  return process.platform === "win32"
    ? [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ]
    : ["sh", "-lc", command];
}

function truncate(value: string, maximumLength = 20_000): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength)}\n…output truncated`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function directoryEntryType(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
}): DirectoryEntry["type"] {
  if (entry.isDirectory()) {
    return "directory";
  }
  return entry.isFile() ? "file" : "other";
}
