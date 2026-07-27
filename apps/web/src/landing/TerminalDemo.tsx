import { terminalLines } from "../data";

const color: Record<string, string> = {
  prompt: "text-zinc-100",
  step: "text-zinc-400",
  out: "text-emerald-400",
};

export function TerminalDemo() {
  return (
    <section className="mx-auto max-w-3xl px-4">
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center gap-1.5 border-b border-zinc-800 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-red-500" />
          <span className="h-3 w-3 rounded-full bg-yellow-500" />
          <span className="h-3 w-3 rounded-full bg-green-500" />
          <span className="ml-3 text-xs text-zinc-500">forge — zsh</span>
        </div>
        <pre className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">
          {terminalLines.map((line, i) => (
            <div key={i} className={color[line.kind]}>
              {line.kind === "prompt" ? (
                <>
                  <span className="text-accent">$ </span>
                  {line.text}
                </>
              ) : (
                line.text
              )}
            </div>
          ))}
        </pre>
      </div>
    </section>
  );
}
