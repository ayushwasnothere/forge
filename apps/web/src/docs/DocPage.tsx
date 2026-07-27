import { Link, useParams } from "react-router-dom";
import { NotFound } from "../NotFound";
import { docs, getDoc } from "./docs";
import { Toc } from "./Toc";

export function DocPage() {
  const { slug = "" } = useParams();
  const doc = getDoc(slug);
  if (!doc) return <NotFound />;

  const idx = docs.findIndex((d) => d.slug === slug);
  const prev = docs[idx - 1];
  const next = docs[idx + 1];
  const { Component } = doc;

  return (
    <div className="flex gap-10">
      <article className="doc-content min-w-0 flex-1">
        <Component />
        <div className="mt-12 flex justify-between border-t border-zinc-200 pt-6 text-sm dark:border-zinc-800">
          {prev ? (
            <Link to={`/docs/${prev.slug}`} className="hover:text-accent">
              ← {prev.title}
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link to={`/docs/${next.slug}`} className="hover:text-accent">
              {next.title} →
            </Link>
          ) : (
            <span />
          )}
        </div>
      </article>
      <Toc slug={slug} />
    </div>
  );
}
