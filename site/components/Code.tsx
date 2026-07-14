import type { ComponentChildren } from "preact";

/** A titled code panel. Children render verbatim inside <pre><code>. */
export function CodeBlock(
  { filename, children }: { filename?: string; children: ComponentChildren },
) {
  return (
    <div class="code-panel">
      {filename ? <div class="filename">{filename}</div> : null}
      <pre><code>{children}</code></pre>
    </div>
  );
}
