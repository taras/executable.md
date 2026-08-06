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
      <div class="command-bar">
        <button
          type="button"
          onClick={copy}
          aria-label="Copy to clipboard"
          class="copy-btn"
        >
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
    </div>
  );
}
