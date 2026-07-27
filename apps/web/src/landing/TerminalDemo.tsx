import { useEffect, useRef, useState } from "react";
import { terminalLines } from "../data";

const color: Record<string, string> = {
  prompt: "text-zinc-100",
  step: "text-zinc-400",
  out: "text-emerald-400",
  blank: "text-transparent",
};

export function TerminalDemo() {
  const [visibleCount, setVisibleCount] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          observer.disconnect();
          let i = 0;
          const interval = setInterval(() => {
            i++;
            setVisibleCount(i);
            if (i >= terminalLines.length) clearInterval(interval);
          }, 180);
        }
      },
      { threshold: 0.3 },
    );
    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className="mx-auto max-w-3xl px-4 py-8">
      <p className="mb-6 text-center text-sm uppercase tracking-widest text-zinc-500">
        See it in action
      </p>
      <div className="terminal-glow overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
        {/* Title bar */}
        <div className="flex items-center gap-1.5 border-b border-zinc-800 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-red-500/80" />
          <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
          <span className="h-3 w-3 rounded-full bg-green-500/80" />
          <span className="ml-3 text-xs text-zinc-500 font-mono">forge — zsh</span>
        </div>
        {/* Terminal content */}
        <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed min-h-[240px]">
          {terminalLines.slice(0, visibleCount).map((line, i) => (
            <div
              key={i}
              className={`${color[line.kind]} transition-opacity duration-300`}
              style={{ opacity: i < visibleCount ? 1 : 0 }}
            >
              {line.kind === "prompt" ? (
                <>
                  <span className="text-accent font-bold">❯ </span>
                  {line.text}
                  {visibleCount === 1 && <span className="cursor-blink ml-0.5">▋</span>}
                </>
              ) : line.kind === "blank" ? (
                "\u00A0"
              ) : (
                line.text
              )}
            </div>
          ))}
          {visibleCount >= terminalLines.length && (
            <div className="mt-1 text-zinc-600">
              <span className="text-accent font-bold">❯ </span>
              <span className="cursor-blink">▋</span>
            </div>
          )}
        </pre>
      </div>
    </section>
  );
}
