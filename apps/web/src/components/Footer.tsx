export function Footer() {
  return (
    <footer className="border-t border-zinc-200/60 dark:border-zinc-800 py-8 text-sm text-zinc-500">
      <div className="mx-auto max-w-6xl px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
        <span>© {new Date().getFullYear()} Forge. MIT License.</span>
        <div className="flex gap-4">
          <a
            href="https://github.com/ayushwasnothere/forge"
            className="hover:text-accent"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a
            href="https://www.npmjs.com/package/forge-code-ai"
            className="hover:text-accent"
            target="_blank"
            rel="noreferrer"
          >
            npm
          </a>
          <a href="/docs" className="hover:text-accent">
            Docs
          </a>
        </div>
      </div>
    </footer>
  );
}
