import { features } from "../data";

export function FeatureGrid() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20">
      <h2 className="mb-10 text-center text-3xl font-bold">
        Everything you need in a coding agent
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h3 className="mb-2 font-semibold text-accent">{f.title}</h3>
            <p className="text-sm text-zinc-500">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
