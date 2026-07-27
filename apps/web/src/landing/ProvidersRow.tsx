import { providers } from "../data";

export function ProvidersRow() {
  return (
    <section className="mx-auto max-w-4xl px-4 pb-8 text-center">
      <p className="mb-6 text-sm uppercase tracking-widest text-zinc-500">Bring your own model</p>
      <div className="flex flex-wrap justify-center gap-3">
        {providers.map((p) => (
          <span
            key={p}
            className="rounded-full border border-zinc-200 px-4 py-1.5 text-sm dark:border-zinc-800"
          >
            {p}
          </span>
        ))}
      </div>
    </section>
  );
}
