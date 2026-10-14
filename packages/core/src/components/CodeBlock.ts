/**
 * `<CodeBlock>` — quote text in a fenced Markdown block
 * (specs/executable-mdx-spec.md §6.19).
 *
 * The fence has one more backtick than the value's longest run, with a minimum
 * of three, so the value cannot close it. The value is otherwise unchanged:
 * nothing is trimmed, normalized, escaped, re-encoded or removed, and returned
 * text is rendered without being rescanned as source (§6.8).
 *
 * The envelope adds one line feed before and after the value and none after the
 * closing fence. A document that wants a final line feed writes it.
 *
 * `value` is an ordinary string prop: it crosses the JSON boundary unchanged,
 * and a repository replacement receives it without inheriting a capture.
 * `language` is limited to one token so it cannot inject opening-fence syntax.
 */

import type { Operation } from "effection";
import { printErrors } from "../component-failures.ts";
import type { FormDeclaration, InvocationForm } from "../invocation-identity.ts";
import type { Json } from "../types.ts";

export const props = {
  type: "object",
  properties: {
    value: { type: "string" },
    language: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._+#-]*$",
    },
  },
  required: ["value"],
  additionalProperties: false,
};

/** An invocation `<CodeBlock>` cannot render. */
export class CodeBlockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodeBlockError";
  }
}

const PAIRED =
  "<CodeBlock> shows the text it is given, not content: write <CodeBlock value={…} /> instead.";

const UNESTABLISHED =
  "<CodeBlock value={…} /> was called without the invocation the engine issued, so which " +
  "form it was written as cannot be established.";

/**
 * The fence this value cannot close.
 *
 * Scanned rather than matched: a regular expression over an arbitrary value is
 * one more thing between the text and the count, and the count is the whole
 * contract. Every character other than U+0060 ends a run and is otherwise not
 * looked at.
 */
function fenceFor(value: string): string {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "`") {
      run += 1;
      if (run > longest) {
        longest = run;
      }
    } else {
      run = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

const show = printErrors(
  // deno-lint-ignore require-yield
  function* CodeBlock(props: Record<string, Json>): Operation<string> {
    const value = String(props.value);
    const language = props.language === undefined ? "" : String(props.language);
    const fence = fenceFor(value);
    return `${fence}${language}\n${value}\n${fence}`;
  },
);

/**
 * The one form this component runs, and what it says about the other.
 *
 * Declared rather than decided in the body: canonical dispatch reads the shape
 * the author wrote (§5.6), so what runs, what the catalog advertises and what a
 * refusal says all come from this one value.
 */
export const form: FormDeclaration = {
  forms: "self-closing",
  fn: show,
  refuse: (_props: Record<string, Json>, written: InvocationForm | undefined) =>
    new CodeBlockError(written === "paired" ? PAIRED : UNESTABLISHED),
};
