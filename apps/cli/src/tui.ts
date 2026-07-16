/**
 * apps/cli/src/tui.ts
 *
 * Modern terminal UI for Forge.
 * Design inspired by Claude Code / OpenCode:
 *   - Animated braille spinner for model thinking
 *   - Compact tool result lines with icon, preview, timing
 *   - Boxed planning section with live streaming
 *   - Rich markdown rendering (headers, lists, code blocks, inline)
 *   - Clean banner with session metadata
 */

// ─── ANSI escape codes ────────────────────────────────────────────────────────
const rs = "\x1b[0m"; // reset all
const bo = "\x1b[1m"; // bold
const dm = "\x1b[2m"; // dim
const it = "\x1b[3m"; // italic
const un = "\x1b[4m"; // underline

const green = "\x1b[32m";
const cyan = "\x1b[36m";
const gray = "\x1b[90m"; // bright black / dark gray

const bRed = "\x1b[91m";
const bGreen = "\x1b[92m";
const bYellow = "\x1b[93m";
const bCyan = "\x1b[96m";
const bWhite = "\x1b[97m";

const bgGray = "\x1b[100m"; // dark background for inline code

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Effective terminal width, capped at 120 columns for readability. */
const cols = (): number => Math.min(process.stdout.columns || 80, 120);

/** Truncates a string with an ellipsis when it exceeds max characters. */
function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

/**
 * Animated braille dot spinner that overwrites a single terminal line.
 * Used to show that the model is thinking between tool rounds.
 */
export class Spinner {
  private static readonly FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  start(label: string): void {
    this.stop();
    this.frame = 0;
    this.running = true;
    this.tick(label);
    this.timer = setInterval(() => this.tick(label), 80);
  }

  private tick(label: string): void {
    const f = Spinner.FRAMES[this.frame % Spinner.FRAMES.length] ?? "⠋";
    process.stdout.write(`\r  ${gray}${f}${rs}  ${dm}${label}${rs}`);
    this.frame++;
  }

  /** Clears the spinner line. Returns true if the spinner was active. */
  stop(): boolean {
    if (!this.running) return false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    process.stdout.write("\r\x1b[2K"); // CR + erase entire line
    this.running = false;
    return true;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

// ─── Banner ───────────────────────────────────────────────────────────────────

/** Prints the compact session banner shown at the start of a chat session. */
export function printBanner(opts: {
  model: string;
  branch?: string;
  testCommand?: string;
  sessionId: string;
}): void {
  const w = cols();
  const rule = `${dm}${"─".repeat(w)}${rs}`;
  const sep = `  ${gray}│${rs}  `;
  const title = `  ${bo}${bCyan}⚡ forge${rs}`;
  const parts = [
    `${dm}${opts.model}${rs}`,
    opts.branch ? `${gray}⎇ ${opts.branch}${rs}` : null,
    opts.testCommand ? `${dm}${opts.testCommand}${rs}` : null,
  ].filter(Boolean) as string[];

  console.log();
  console.log(rule);
  console.log(`${title}${sep}${parts.join(sep)}`);
  console.log(rule);
  console.log(
    `  ${dm}Session ${gray}${opts.sessionId.slice(0, 8)}…${rs}   ` +
      `${dm}Commands: ${gray}/help /status /new /reset /exit${rs}`,
  );
  console.log();
}

// ─── Planning section ─────────────────────────────────────────────────────────

/** Prints the planning section header before the plan begins streaming. */
export function printPlanningHeader(): void {
  const dashes = `${dm}${"╌".repeat(cols() - 4)}${rs}`;
  console.log(
    `\n  ${bo}${bCyan}◆${rs} ${bo}Planning${rs}  ${dm}generating step-by-step plan…${rs}`,
  );
  console.log(`  ${dashes}`);
}

/**
 * Clears the streamed planning tokens and prints the rendered plan.
 * Called after plan.finished to replace raw streaming text with styled markdown.
 */
export function printPlanningFooter(streamedText: string, renderedPlan: string): void {
  clearStreamedText(streamedText);
  const dashes = `${dm}${"╌".repeat(cols() - 4)}${rs}`;
  for (const line of renderMarkdown(renderedPlan).split("\n")) {
    process.stdout.write(`  ${line}\n`);
  }
  console.log(`  ${dashes}\n`);
}

// ─── Tool icons & argument preview ────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  read_file: "○",
  write_file: "●",
  replace_text: "◈",
  apply_patch: "◇",
  run_command: "▷",
  find_files: "⌕",
  search_code: "⌕",
  list_directory: "≡",
  list_symbols: "◉",
  remember_fact: "⊛",
  recall_facts: "⊛",
  forget_fact: "⊛",
  git_status: "⎇",
  git_diff: "⎇",
  git_log: "⎇",
  git_blame: "⎇",
  git_commit: "⎇",
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "◆";
}

/**
 * Returns a brief human-readable preview of the most relevant tool argument.
 * e.g. for read_file → file path; for run_command → the shell command.
 */
export function toolArgPreview(toolName: string, args: Record<string, unknown>): string {
  const s = (v: unknown): string => String(v ?? "");
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "replace_text":
    case "list_directory":
    case "list_symbols":
    case "git_blame":
      return trunc(s(args.path), 55);
    case "run_command":
      return trunc(s(args.command), 60);
    case "find_files":
      return trunc(s(args.pattern), 50);
    case "search_code":
      return `"${trunc(s(args.query), 40)}"`;
    case "apply_patch":
      return "(unified diff)";
    case "git_commit":
      return trunc(s(args.message), 50);
    case "remember_fact":
      return `${s(args.key)}: ${trunc(s(args.value), 25)}`;
    case "forget_fact":
      return s(args.key);
    default:
      return "";
  }
}

/**
 * Prints a compact tool completion line with icon, name, argument preview, and timing.
 * Emitted once when tool.finished fires (not tool.started) so parallel tool calls
 * each produce a clean, non-interleaved output line.
 *
 * Example:
 *   ✓ ○ read_file  packages/agent/src/index.ts  12ms
 *   ✓ ▷ run_command  bun run check  1.4s
 *   ✗ ▷ run_command  bun run test  2.1s
 */
export function printToolResult(
  toolName: string,
  preview: string,
  success: boolean,
  durationMs: number,
): void {
  const icon = toolIcon(toolName);
  const tick = success ? `${bGreen}✓${rs}` : `${bRed}✗${rs}`;
  const dStr = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
  const previewStr = preview ? `  ${dm}${preview}${rs}` : "";
  console.log(
    `    ${tick} ${gray}${icon}${rs} ${cyan}${toolName}${rs}${previewStr}  ${gray}${dStr}${rs}`,
  );
}

// ─── Section header ───────────────────────────────────────────────────────────

/** Prints a styled named section separator. */
export function printHeader(title: string): void {
  const w = cols();
  console.log(`\n  ${bo}${bCyan}${title}${rs}`);
  console.log(`  ${dm}${"─".repeat(w - 4)}${rs}`);
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

/**
 * Converts GitHub-Flavored Markdown to ANSI-colored terminal output.
 * Handles H1–H4 headers, ordered and unordered lists, fenced code blocks,
 * blockquotes, horizontal rules, bold, italic, inline code, and links.
 */
export function renderMarkdown(md: string): string {
  if (!md) return "";
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";

  for (const line of lines) {
    // ── Fenced code block ─────────────────────────────────────────────────
    if (line.startsWith("```")) {
      inCode = !inCode;
      if (inCode) {
        codeLang = line.slice(3).trim();
        const label = codeLang || "code";
        const fill = "─".repeat(Math.max(2, 36 - label.length));
        out.push(`${dm}  ╭─ ${label} ${fill}─${rs}`);
      } else {
        out.push(`${dm}  ╰${"─".repeat(42)}${rs}`);
        codeLang = "";
      }
      continue;
    }
    if (inCode) {
      out.push(`${dm}  │${rs}  ${bYellow}${line}${rs}`);
      continue;
    }

    // ── Headers ───────────────────────────────────────────────────────────
    if (line.startsWith("# ")) {
      const t = line.slice(2);
      out.push(`\n${bo}${bCyan}${t}${rs}`);
      out.push(`${dm}${"─".repeat(Math.min(t.length + 4, cols()))}${rs}`);
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(`\n${bo}${bWhite}${line.slice(3)}${rs}`);
      continue;
    }
    if (line.startsWith("### ")) {
      out.push(`\n${bo}${cyan}▸ ${line.slice(4)}${rs}`);
      continue;
    }
    if (line.startsWith("#### ")) {
      out.push(`${bo}${line.slice(5)}${rs}`);
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────
    if (/^(-{3,}|─{3,}|={3,})$/.test(line.trim())) {
      out.push(`${dm}${"─".repeat(cols())}${rs}`);
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────
    if (line.startsWith("> ")) {
      out.push(`  ${dm}│${rs} ${it}${gray}${line.slice(2)}${rs}`);
      continue;
    }

    // ── Ordered / unordered lists ─────────────────────────────────────────
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1] ?? "";
      const marker = listMatch[2] ?? "";
      const content = listMatch[3] ?? "";
      const isOrdered = /^\d+\.$/.test(marker);
      const bullet = isOrdered ? `${cyan}${marker}${rs}` : `${green}◆${rs}`;
      out.push(`${indent}  ${bullet} ${inline(content)}`);
      continue;
    }

    out.push(inline(line));
  }

  return out.join("\n");
}

/** Renders inline Markdown tokens: bold, italic, inline code, links. */
function inline(text: string): string {
  let f = text;
  // Bold: **text** or __text__
  f = f.replace(/(\*\*|__)(.*?)\1/g, `${bo}${bWhite}$2${rs}`);
  // Italic: *text* (avoid matching ** by using negative lookahead)
  f = f.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, `${it}$1${rs}`);
  f = f.replace(/(?<!_)_(?!_)(.*?)(?<!_)_(?!_)/g, `${it}$1${rs}`);
  // Inline code: `code`
  f = f.replace(/`([^`]+)`/g, `${bgGray}${bWhite} $1 ${rs}`);
  // Links: [label](url)
  f = f.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${un}${bCyan}$1${rs} ${dm}($2)${rs}`);
  return f;
}

// ─── Streaming text clear ─────────────────────────────────────────────────────

/**
 * Erases previously streamed text so it can be replaced with rendered markdown.
 * Moves the cursor up by the number of lines the streamed text occupies,
 * then clears from the cursor position to the end of the screen.
 */
export function clearStreamedText(text: string): void {
  if (!text) return;
  const width = process.stdout.columns || 80;
  const lineCount = text
    .split("\n")
    .reduce((acc, line) => acc + Math.max(1, Math.ceil((line.length || 1) / width)), 0);
  if (lineCount > 1) {
    process.stdout.write(`\x1b[${lineCount - 1}A`);
  }
  process.stdout.write("\r\x1b[J");
}

// ─── Legacy compatibility shims ───────────────────────────────────────────────
// Kept so callers compile but all display logic now lives in the onEvent
// handlers in apps/cli/src/index.ts.

/** @deprecated Spinner is now managed directly in index.ts. */
export function printThinking(_step: number, _text?: string): void {
  // no-op
}

/** @deprecated Tool display now handled by printToolResult in index.ts. */
export function printToolStart(_step: number, _toolName: string): void {
  // no-op
}

/** @deprecated Tool display now handled by printToolResult in index.ts. */
export function printToolEnd(_success: boolean): void {
  // no-op
}
