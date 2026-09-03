import type { ComponentChildren } from "preact";

const COPY_BTN =
  "position:absolute;top:0.375rem;right:0.375rem;z-index:1;width:1.75rem;height:1.75rem;font-size:0.75rem;line-height:1;border:0;background:transparent;color:var(--dim);";

/**
 * A ruled code panel. Children render verbatim inside <pre><code>.
 *
 * `filename` titles the panel. `command` renders it as an inverted terminal
 * slab — reserved for things you type at a shell and what they print back,
 * so document source never reads as a transcript. `noWrap` keeps a narrow
 * terminal slab's manual line breaks exact instead of letting a long token
 * wrap mid-word.
 *
 * `copy` adds the corner copy affordance. The button carries no handler of
 * its own: a page that opts in delegates one listener off `[data-copy]`, so
 * a page of panels costs one listener rather than one island each.
 */
export function CodeBlock(
  { filename, command, noWrap, copy, children }: {
    filename?: string;
    command?: boolean;
    noWrap?: boolean;
    copy?: boolean;
    children: ComponentChildren;
  },
) {
  return (
    <div
      class={command ? "code-panel code-panel-terminal" : "code-panel"}
      style={copy ? "position:relative;" : undefined}
    >
      {copy
        ? (
          <button
            type="button"
            data-copy=""
            aria-label="Copy code"
            title="Copy code"
            class="icon-btn"
            style={COPY_BTN}
          >
            ⧉
          </button>
        )
        : null}
      {filename ? <div class="filename">{filename}</div> : null}
      <pre
        style={noWrap ? "white-space:pre;" : undefined}
      ><code>{children}</code></pre>
    </div>
  );
}
