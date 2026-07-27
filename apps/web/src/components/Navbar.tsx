import { Link } from "react-router-dom";
import { useTheme } from "../ThemeProvider";
import { Icon } from "./Icon";

export function Navbar() {
  const { theme, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200/40 dark:border-zinc-800/60 bg-white/70 dark:bg-zinc-950/70 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5 font-bold text-lg group">
          <span className="text-accent text-xl transition-transform group-hover:scale-110">⚡</span>
          <span>Forge</span>
        </Link>
        <div className="flex items-center gap-1">
          <Link
            to="/docs"
            className="rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 hover:text-accent dark:hover:bg-zinc-800"
          >
            Docs
          </Link>
          <a
            href="https://github.com/ayushwasnothere/forge"
            aria-label="GitHub"
            className="rounded-lg p-2 transition-colors hover:bg-zinc-100 hover:text-accent dark:hover:bg-zinc-800"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="github" />
          </a>
          <a
            href="https://www.npmjs.com/package/forge-code-ai"
            aria-label="npm"
            className="rounded-lg p-2 transition-colors hover:bg-zinc-100 hover:text-accent dark:hover:bg-zinc-800"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="npm" />
          </a>
          <button
            type="button"
            onClick={toggle}
            aria-label="Toggle theme"
            className="rounded-lg p-2 transition-all hover:bg-zinc-100 hover:text-accent hover:rotate-12 dark:hover:bg-zinc-800"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
      </nav>
    </header>
  );
}
