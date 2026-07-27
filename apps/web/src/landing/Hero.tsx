import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";

const INSTALL = "npm i -g forge-code-ai";

export function Hero() {
  return (
    <section className="mx-auto max-w-3xl px-4 pt-20 pb-12 text-center">
      <p className="mb-4 inline-block rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-500 dark:border-zinc-800">
        v0.1.1 · MIT licensed
      </p>
      <h1 className="text-balance text-5xl font-bold tracking-tight sm:text-6xl">
        The <span className="text-accent">terminal-first</span> AI coding agent
      </h1>
      <p className="mx-auto mt-6 max-w-xl text-lg text-zinc-500">
        Forge understands your repo, edits files, runs commands, and manages Git — iterating
        autonomously with any LLM, right from your terminal.
      </p>
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2.5 font-mono text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <span className="text-accent">$</span> {INSTALL}
          <CopyButton text={INSTALL} />
        </div>
        <a
          href="https://github.com/ayushwasnothere/forge"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-zinc-950 hover:bg-accent-strong"
        >
          <Icon name="github" className="w-4 h-4" /> Star on GitHub
        </a>
      </div>
    </section>
  );
}
