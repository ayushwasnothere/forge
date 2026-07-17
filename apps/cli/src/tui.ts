/**
 * apps/cli/src/tui.ts
 *
 * Modern terminal UI for Forge.
 * Uses @clack/prompts for interactive components and picocolors for styling.
 */

import pc from "picocolors";

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Effective terminal width, capped at 120 columns for readability. */
export const cols = (): number => Math.min(process.stdout.columns || 80, 120);

/** Truncates a string with an ellipsis when it exceeds max characters. */
export function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
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

export function toolIcon(name: string): string {
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
        const borderWidth = Math.max(2, Math.min(cols() - 8, 44) - label.length - 4);
        const fill = "─".repeat(borderWidth);
        out.push(`${pc.dim(`  ╭─ ${label} ${fill}─`)}`);
      } else {
        const borderWidth = Math.max(2, Math.min(cols() - 8, 44) + 2);
        out.push(`${pc.dim(`  ╰${"─".repeat(borderWidth)}`)}`);
        codeLang = "";
      }
      continue;
    }
    if (inCode) {
      out.push(`${pc.dim("  │")}  ${pc.yellowBright(line)}`);
      continue;
    }

    // ── Headers ───────────────────────────────────────────────────────────
    if (line.startsWith("# ")) {
      const t = line.slice(2);
      out.push(`\n${pc.bold(pc.cyanBright(t))}`);
      out.push(`${pc.dim("─".repeat(Math.min(t.length + 4, cols())))}`);
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(`\n${pc.bold(pc.whiteBright(line.slice(3)))}`);
      continue;
    }
    if (line.startsWith("### ")) {
      out.push(`\n${pc.bold(pc.cyan(`▸ ${line.slice(4)}`))}`);
      continue;
    }
    if (line.startsWith("#### ")) {
      out.push(`${pc.bold(line.slice(5))}`);
      continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────────────
    if (/^(-{3,}|─{3,}|={3,})$/.test(line.trim())) {
      out.push(`${pc.dim("─".repeat(cols()))}`);
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────
    if (line.startsWith("> ")) {
      out.push(`  ${pc.dim("│")} ${pc.italic(pc.gray(line.slice(2)))}`);
      continue;
    }

    // ── Ordered / unordered lists ─────────────────────────────────────────
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1] ?? "";
      const marker = listMatch[2] ?? "";
      const content = listMatch[3] ?? "";
      const isOrdered = /^\d+\.$/.test(marker);
      const bullet = isOrdered ? pc.cyan(marker) : pc.green("◆");
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
  // Bold: **text** or __text__ — use callback so capture groups are applied after ANSI wrapping
  f = f.replace(/(?:\*\*|__)(.*?)(?:\*\*|__)/g, (_m, t: string) => pc.bold(pc.whiteBright(t)));
  // Italic: *text* (avoid matching **)
  f = f.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, (_m, t: string) => pc.italic(t));
  f = f.replace(/(?<!_)_(?!_)(.*?)(?<!_)_(?!_)/g, (_m, t: string) => pc.italic(t));
  // Inline code: `code`
  f = f.replace(/`([^`]+)`/g, (_m, t: string) => pc.bgBlack(pc.whiteBright(` ${t} `)));
  // Links: [label](url)
  f = f.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, url: string) =>
      `${pc.underline(pc.cyanBright(label))} ${pc.dim(`(${url})`)}`,
  );
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

/**
 * Returns an ANSI-colored string of the visual diff, which can be printed
 * or passed to @clack/prompts note().
 */
export function generateVisualDiff(newContent: string, oldContent?: string): string {
  const lines: string[] = [];

  if (oldContent === undefined) {
    lines.push(pc.green(`+ (New File: ${Buffer.byteLength(newContent)} bytes)`));
    return lines.join("\n");
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let i = 0;
  let j = 0;
  let printedLines = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (printedLines > 25) {
      lines.push(pc.dim("... (remaining changes omitted for brevity)"));
      break;
    }

    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else {
      let matchIdx = -1;
      for (let k = j; k < newLines.length; k++) {
        if (newLines[k] === oldLines[i]) {
          matchIdx = k;
          break;
        }
      }

      if (matchIdx !== -1) {
        for (let k = j; k < matchIdx; k++) {
          if (printedLines <= 25) {
            lines.push(pc.green(`+ ${String(newLines[k])}`));
            printedLines++;
          }
        }
        j = matchIdx;
      } else {
        if (oldLines[i] !== undefined) {
          if (printedLines <= 25) {
            lines.push(pc.red(`- ${oldLines[i]}`));
            printedLines++;
          }
        }
        if (newLines[j] !== undefined) {
          if (printedLines <= 25) {
            lines.push(pc.green(`+ ${newLines[j]}`));
            printedLines++;
          }
        }
        i++;
        j++;
      }
    }
  }

  return lines.join("\n");
}
