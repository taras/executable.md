import { useState } from "preact/hooks";

export default function CopyCommand({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    try {
      navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  }

  return (
    <div class="command">
      <code>
        {lines.map((l, i) => (
          <div key={i}>
            <span class="prompt">$</span>
            {l}
          </div>
        ))}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy to clipboard"
        style="background:none;border:1px solid var(--border);border-radius:0.4rem;padding:0.25rem 0.55rem;cursor:pointer;color:var(--fg-muted);font-size:0.75rem;white-space:nowrap;"
      >
        {copied ? "copied ✓" : "copy"}
      </button>
    </div>
  );
}
