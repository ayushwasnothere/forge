import { Link } from "react-router-dom";
import { Icon } from "./Icon";

export function Footer() {
  return (
    <footer className="mt-24 border-t border-zinc-200/40 dark:border-zinc-800/60">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="flex flex-col items-center gap-8 sm:flex-row sm:justify-between">
          {/* Brand */}
          <div className="text-center sm:text-left">
            <Link to="/" className="inline-flex items-center gap-2 text-lg font-bold">
              <span className="text-accent text-xl">⚡</span> Forge
            </Link>
            <p className="mt-2 max-w-xs text-sm text-zinc-500">
              A modular, terminal-first AI coding agent built with TypeScript and Bun.
            </p>
          </div>

          {/* Links */}
          <div className="flex gap-8 text-sm">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Product
              </p>
              <a href="/docs" className="block text-zinc-500 transition-colors hover:text-accent">
                Documentation
              </a>
              <a
                href="https://github.com/ayushwasnothere/forge"
                className="block text-zinc-500 transition-colors hover:text-accent"
                target="_blank"
                rel="noreferrer"
              >
                GitHub
              </a>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Resources
              </p>
              <a
                href="https://www.npmjs.com/package/forge-code-ai"
                className="block text-zinc-500 transition-colors hover:text-accent"
                target="_blank"
                rel="noreferrer"
              >
                npm Package
              </a>
              <a
                href="https://github.com/ayushwasnothere/forge/blob/main/LICENSE"
                className="block text-zinc-500 transition-colors hover:text-accent"
                target="_blank"
                rel="noreferrer"
              >
                MIT License
              </a>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="section-divider mt-8 mb-6" />
        <div className="flex flex-col items-center justify-between gap-2 text-xs text-zinc-500 sm:flex-row">
          <span>© {new Date().getFullYear()} Forge. Open source under MIT.</span>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/ayushwasnothere/forge"
              className="transition-colors hover:text-accent"
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="github" className="w-4 h-4" />
            </a>
            <a
              href="https://www.npmjs.com/package/forge-code-ai"
              className="transition-colors hover:text-accent"
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="npm" className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
