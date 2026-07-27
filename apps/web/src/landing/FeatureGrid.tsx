import { features } from "../data";

export function FeatureGrid() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20">
      <div className="mb-12 text-center">
        <h2 className="text-3xl font-extrabold sm:text-4xl">
          Everything you need in a <span className="gradient-text">coding agent</span>
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-zinc-500">
          Forge ships with a complete toolkit for autonomous coding — from file editing and shell
          execution to Git management and session persistence.
        </p>
      </div>
      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f) => (
          <div key={f.title} className="glass-card rounded-2xl p-6">
            <span className="mb-3 block text-2xl">{f.icon}</span>
            <h3 className="mb-2 font-semibold text-accent">{f.title}</h3>
            <p className="text-sm leading-relaxed text-zinc-500">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
