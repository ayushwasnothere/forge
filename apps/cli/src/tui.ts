// ANSI terminal styling codes
const reset = "\x1b[0m";
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const italic = "\x1b[3m";
const underline = "\x1b[4m";

const black = "\x1b[30m";
const red = "\x1b[31m";
const green = "\x1b[32m";
const yellow = "\x1b[33m";
const blue = "\x1b[34m";
const magenta = "\x1b[35m";
const cyan = "\x1b[36m";
const white = "\x1b[37m";

const bgBlack = "\x1b[40m";
const bgRed = "\x1b[41m";
const bgGreen = "\x1b[42m";
const bgYellow = "\x1b[43m";
const bgBlue = "\x1b[44m";
const bgMagenta = "\x1b[45m";
const bgCyan = "\x1b[46m";
const bgWhite = "\x1b[47m";

/**
 * A clean, dependency-free ANSI Markdown renderer for the terminal.
 * Renders headers, lists, code blocks, blockquotes, bold/italic, and links.
 */
export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const renderedLines: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";

  for (let i = 0; i < lines.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: lines length is bounds-checked
    const line = lines[i]!;

    // Code blocks
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) {
        codeBlockLang = line.slice(3).trim();
        renderedLines.push(
          `${dim}┌─── ${codeBlockLang || "code"} ──────────────────────────────────${reset}`,
        );
      } else {
        renderedLines.push(`${dim}└────────────────────────────────────────────────${reset}`);
      }
      continue;
    }

    if (inCodeBlock) {
      renderedLines.push(`${dim}│${reset}  ${yellow}${line}${reset}`);
      continue;
    }

    // Headers
    if (line.startsWith("# ")) {
      renderedLines.push(`\n${bold}${cyan}══ ${line.slice(2).toUpperCase()} ══${reset}\n`);
      continue;
    }
    if (line.startsWith("## ")) {
      renderedLines.push(`\n${bold}${blue}┌── ${line.slice(3)} ──┐${reset}`);
      continue;
    }
    if (line.startsWith("### ")) {
      renderedLines.push(`\n${bold}${magenta}■ ${line.slice(4)}${reset}`);
      continue;
    }
    if (line.startsWith("#### ")) {
      renderedLines.push(`\n${bold}${underline}${white}${line.slice(5)}${reset}`);
      continue;
    }

    // Blockquotes
    if (line.startsWith("> ")) {
      renderedLines.push(`  ${bgBlue}${black} ℹ ${reset} ${italic}${line.slice(2)}${reset}`);
      continue;
    }

    // Horizontal Rule
    if (line.trim() === "---") {
      renderedLines.push(
        `${dim}────────────────────────────────────────────────────────────────${reset}`,
      );
      continue;
    }

    // Lists
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
    if (listMatch) {
      const indent = listMatch[1] ?? "";
      const bullet = listMatch[2] ?? "";
      const content = listMatch[3] ?? "";
      const formattedContent = parseInline(content);
      const coloredBullet = bullet.includes(".") ? `${cyan}${bullet}${reset}` : `${green}•${reset}`;
      renderedLines.push(`${indent}${coloredBullet} ${formattedContent}`);
      continue;
    }

    // Default line rendering
    renderedLines.push(parseInline(line));
  }

  return renderedLines.join("\n");
}

/**
 * Format inline elements (bold, italic, code, links).
 */
function parseInline(text: string): string {
  let formatted = text;

  // Bold (**text** or __text__)
  formatted = formatted.replace(/(\*\*|__)(.*?)\1/g, `${bold}${yellow}$2${reset}`);

  // Italic (*text* or _text_)
  formatted = formatted.replace(/(\*|_)(.*?)\1/g, `${italic}$2${reset}`);

  // Inline code (`code`)
  formatted = formatted.replace(/`(.*?)`/g, `${bgWhite}${black} $1 ${reset}`);

  // Markdown links ([label](url))
  formatted = formatted.replace(
    /\[(.*?)\]\((.*?)\)/g,
    `${underline}${cyan}$1${reset} ${dim}($2)${reset}`,
  );

  return formatted;
}

/**
 * Print a stylish section header panel.
 */
export function printHeader(title: string): void {
  console.log(`\n${bgCyan}${black}${bold}  ${title.toUpperCase()}  ${reset}\n`);
}

/**
 * Print agent thinking step with standard formatting.
 */
export function printThinking(step: number, text?: string): void {
  console.log(`🧠 ${bold}${magenta}Step ${step}${reset} ${dim}Thinking…${reset}`);
  if (text) {
    console.log(`   ${italic}${dim}${text.trim()}${reset}`);
  }
}

/**
 * Print tool execution progress.
 */
export function printToolStart(step: number, toolName: string): void {
  process.stdout.write(
    `⚙️  ${bold}${yellow}Step ${step}${reset} ${dim}Running ${bold}${toolName}${reset}… `,
  );
}

export function printToolEnd(success: boolean): void {
  if (success) {
    console.log(`${green}${bold}✔ done${reset}`);
  } else {
    console.log(`${red}${bold}✖ failed${reset}`);
  }
}
