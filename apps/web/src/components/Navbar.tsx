import { Link } from "react-router-dom";
import { useTheme } from "../ThemeProvider";
import { Icon } from "./Icon";

export function Navbar() {
  const { theme, toggle } = useTheme();
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200/60 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <span className="text-accent">⚡</span> Forge
        </Link>
        <div className="flex items-center gap-1">
          <Link to="/docs" className="rounded-md px-3 py-2 text-sm hover:text-accent">
            Docs
          </Link>
          <a
            href="https://github.com/ayushwasnothere/forge"
            aria-label="GitHub"
            className="rounded-md p-2 hover:text-accent"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="github" />
          </a>
          <a
            href="https://www.npmjs.com/package/forge-code-ai"
            aria-label="npm"
            className="rounded-md p-2 hover:text-accent"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="npm" />
          </a>
          <button
            type="button"
            onClick={toggle}
            aria-label="Toggle theme"
            className="rounded-md p-2 hover:text-accent"
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
      </nav>
    </header>
  );
}
