import { useState } from "react";
import { Icon } from "./Icon";

export function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (insecure context) — ignore, non-blocking
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className={`rounded-md p-1.5 text-zinc-400 hover:text-accent ${className}`}
    >
      <Icon name={copied ? "check" : "copy"} className="w-4 h-4" />
    </button>
  );
}
