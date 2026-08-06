import type { ComponentChildren } from "preact";

/**
 * A ruled code panel. Children render verbatim inside <pre><code>.
 *
 * `filename` titles the panel. `command` renders it as an inverted terminal
 * slab — reserved for things you type at a shell and what they print back,
 * so document source never reads as a transcript.
 */
export function CodeBlock(
  { filename, command, children }: {
    filename?: string;
    command?: boolean;
    children: ComponentChildren;
  },
) {
  return (
    <div class={command ? "code-panel code-panel-terminal" : "code-panel"}>
      {filename ? <div class="filename">{filename}</div> : null}
      <pre><code>{children}</code></pre>
    </div>
  );
}
