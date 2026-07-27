import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { stats } from "../data";

const INSTALL = "npm i -g forge-code-ai";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Animated conic gradient glow */}
      <div className="hero-glow" />

      <div className="relative z-10 mx-auto max-w-4xl px-4 pt-24 pb-16 text-center sm:pt-32 sm:pb-20">
        {/* Badge */}
        <div className="animate-fade-in-up mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-200/60 bg-white/60 px-4 py-1.5 text-xs font-medium text-zinc-600 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          v0.1.1 · Open Source · MIT Licensed
        </div>

        {/* Headline */}
        <h1
          className="animate-fade-in-up text-balance text-5xl font-extrabold tracking-tight sm:text-7xl"
          style={{ animationDelay: "100ms" }}
        >
          The <span className="gradient-text">terminal-first</span>
          <br />
          AI coding agent
        </h1>

        {/* Subheadline */}
        <p
          className="animate-fade-in-up mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-zinc-500 sm:text-xl"
          style={{ animationDelay: "200ms" }}
        >
          Forge understands your repo, edits files, runs commands, and manages Git — iterating
          autonomously with any LLM provider, right from your terminal.
        </p>

        {/* CTA row */}
        <div
          className="animate-fade-in-up mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row"
          style={{ animationDelay: "300ms" }}
        >
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200/80 bg-zinc-50/80 px-5 py-3 font-mono text-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
            <span className="text-accent font-bold">$</span>
            <span>{INSTALL}</span>
            <CopyButton text={INSTALL} />
          </div>
          <a
            href="https://github.com/ayushwasnothere/forge"
            target="_blank"
            rel="noreferrer"
            className="group flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-zinc-950 shadow-lg shadow-amber-500/20 transition-all hover:shadow-amber-500/40 hover:scale-105"
          >
            <Icon name="github" className="w-4 h-4" />
            Star on GitHub
          </a>
        </div>

        {/* Stats row */}
        <div
          className="animate-fade-in-up mt-14 grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-8"
          style={{ animationDelay: "400ms" }}
        >
          {stats.map((s) => (
            <div key={s.label}>
              <p className="text-3xl font-extrabold text-accent">{s.value}</p>
              <p className="mt-1 text-xs uppercase tracking-widest text-zinc-500">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
