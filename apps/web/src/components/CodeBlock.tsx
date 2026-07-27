import { CopyButton } from "./CopyButton";

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div className="group relative my-4 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
      {lang && (
        <span className="absolute left-3 top-2 select-none text-xs text-zinc-400">{lang}</span>
      )}
      <CopyButton
        text={code}
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus:opacity-100"
      />
      <pre className="overflow-x-auto p-4 pt-8 text-sm leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
