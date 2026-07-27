import { CodeBlock } from "../components/CodeBlock";

const steps = [
  { label: "Install", code: "npm i -g forge-code-ai", lang: "bash" },
  { label: "Configure a provider", code: "forge setup", lang: "bash" },
  { label: "Start coding", code: "forge chat --allow-write --allow-execute", lang: "bash" },
];

export function Quickstart() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16">
      <h2 className="mb-8 text-center text-3xl font-bold">Up and running in 30 seconds</h2>
      {steps.map((s, i) => (
        <div key={s.label} className="mb-4">
          <p className="mb-1 text-sm font-medium text-zinc-500">
            {i + 1}. {s.label}
          </p>
          <CodeBlock code={s.code} lang={s.lang} />
        </div>
      ))}
    </section>
  );
}
