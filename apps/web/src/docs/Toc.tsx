import { useEffect, useState } from "react";

interface Heading {
  id: string;
  text: string;
  level: number;
}

export function Toc({ slug }: { slug: string }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState("");

  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(".doc-content h2, .doc-content h3"),
    );
    setHeadings(
      nodes.map((n) => ({
        id: n.id,
        text: n.textContent ?? "",
        level: n.tagName === "H2" ? 2 : 3,
      })),
    );

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const n of nodes) observer.observe(n);
    return () => observer.disconnect();
  }, [slug]);

  if (headings.length === 0) return null;
  return (
    <aside className="hidden w-56 shrink-0 lg:block">
      <div className="sticky top-20 text-sm">
        <p className="mb-2 font-semibold text-zinc-400">On this page</p>
        <ul className="space-y-1.5">
          {headings.map((h) => (
            <li key={h.id} className={h.level === 3 ? "pl-3" : ""}>
              <a
                href={`#${h.id}`}
                className={active === h.id ? "text-accent" : "text-zinc-500 hover:text-accent"}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
