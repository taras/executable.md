import { Fragment } from "preact";

/**
 * One run of source text. A bare string is unstyled; a tuple carries the
 * token class the design system paints it with, and `bold` is the Markdown
 * structure (headings) that reads at full weight rather than as a token.
 */
export type Tok = string | ["key" | "str" | "mod" | "dim" | "bold", string];

export const key = (text: string): Tok => ["key", text];
export const str = (text: string): Tok => ["str", text];
export const mod = (text: string): Tok => ["mod", text];
export const dim = (text: string): Tok => ["dim", text];
export const bold = (text: string): Tok => ["bold", text];

const TOK_CLASS = {
  key: "tok-key",
  str: "tok-str",
  mod: "tok-mod",
  dim: "tok-dim",
} as const;

/** Source lines, joined with newlines so `<pre>` lays them out. */
export function Source({ lines }: { lines: Tok[][] }) {
  return (
    <>
      {lines.map((parts, line) => (
        <Fragment key={line}>
          {line > 0 ? "\n" : null}
          {parts.map((part, i) =>
            typeof part === "string"
              ? part
              : part[0] === "bold"
              ? <span key={i} style="font-weight:700;">{part[1]}</span>
              : <span key={i} class={TOK_CLASS[part[0]]}>{part[1]}</span>
          )}
        </Fragment>
      ))}
    </>
  );
}
