import type { ReactNode } from "react";
import { CodeBlock } from "./CodeBlock";

// MDX renders fenced code as <pre><code>. Extract the raw string and render our CodeBlock.
function Pre({ children }: { children?: ReactNode }) {
  const el = children as { props?: { children?: string; className?: string } } | undefined;
  const raw = typeof el?.props?.children === "string" ? el.props.children.replace(/\n$/, "") : "";
  const lang = el?.props?.className?.replace("language-", "");
  return <CodeBlock code={raw} lang={lang} />;
}

export const mdxComponents = {
  h1: (p: object) => <h1 className="mb-6 text-4xl font-bold tracking-tight" {...p} />,
  h2: (p: object) => <h2 className="mt-10 mb-3 scroll-mt-20 text-2xl font-semibold" {...p} />,
  h3: (p: object) => <h3 className="mt-6 mb-2 scroll-mt-20 text-xl font-semibold" {...p} />,
  p: (p: object) => <p className="my-4 leading-relaxed text-zinc-600 dark:text-zinc-300" {...p} />,
  ul: (p: object) => (
    <ul className="my-4 list-disc space-y-1 pl-6 text-zinc-600 dark:text-zinc-300" {...p} />
  ),
  ol: (p: object) => (
    <ol className="my-4 list-decimal space-y-1 pl-6 text-zinc-600 dark:text-zinc-300" {...p} />
  ),
  li: (p: object) => <li className="leading-relaxed" {...p} />,
  a: (p: object) => (
    <a className="text-accent underline underline-offset-2 hover:text-accent-strong" {...p} />
  ),
  code: (p: object) => (
    <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-sm dark:bg-zinc-800" {...p} />
  ),
  pre: Pre,
  table: (p: object) => (
    <div className="my-6 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...p} />
    </div>
  ),
  th: (p: object) => (
    <th
      className="border-b border-zinc-300 px-3 py-2 text-left font-semibold dark:border-zinc-700"
      {...p}
    />
  ),
  td: (p: object) => (
    <td className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-800" {...p} />
  ),
  blockquote: (p: object) => (
    <blockquote className="my-4 border-l-2 border-accent pl-4 text-zinc-500 italic" {...p} />
  ),
};
