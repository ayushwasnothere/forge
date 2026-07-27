import { CodeBlock } from "../components/CodeBlock";

const steps = [
  {
    label: "Install globally",
    description: "One command to install Forge from npm.",
    code: "npm i -g forge-code-ai",
    lang: "bash",
  },
  {
    label: "Configure your provider",
    description: "Run the interactive wizard to set up API keys and model aliases.",
    code: "forge setup",
    lang: "bash",
  },
  {
    label: "Start coding",
    description: "Launch an interactive session with full permissions.",
    code: "forge chat --allow-write --allow-execute",
    lang: "bash",
  },
];

export function Quickstart() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-20">
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-extrabold sm:text-4xl">
          Up and running in <span className="text-accent">30 seconds</span>
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-zinc-500">
          Three commands. That's all it takes to go from zero to an AI coding agent in your
          terminal.
        </p>
      </div>
      <div className="space-y-6">
        {steps.map((s, i) => (
          <div key={s.label} className="glass-card rounded-2xl p-6">
            <div className="mb-3 flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent">
                {i + 1}
              </span>
              <div>
                <p className="font-semibold">{s.label}</p>
                <p className="text-xs text-zinc-500">{s.description}</p>
              </div>
            </div>
            <CodeBlock code={s.code} lang={s.lang} />
          </div>
        ))}
      </div>
    </section>
  );
}
