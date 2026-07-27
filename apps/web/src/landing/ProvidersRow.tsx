import { providers } from "../data";

export function ProvidersRow() {
  return (
    <section className="mx-auto max-w-4xl px-4 py-16 text-center">
      <p className="mb-2 text-sm uppercase tracking-widest text-zinc-500">Bring your own model</p>
      <p className="mx-auto mb-8 max-w-lg text-zinc-400 text-sm">
        Forge works with any OpenAI-compatible API. Switch between providers instantly with model
        aliases.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        {providers.map((p) => (
          <span
            key={p}
            className="provider-chip rounded-full border border-zinc-200/60 bg-white/50 px-5 py-2 text-sm font-medium backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/50"
          >
            {p}
          </span>
        ))}
      </div>
    </section>
  );
}
