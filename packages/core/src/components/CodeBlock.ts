/**
 * `<CodeBlock>` — place any text inside one fenced Markdown code block
 * (specs/executable-mdx-spec.md §6.19).
 *
 * A document that shows generated source, a diagnostic, or anything else it did
 * not write needs the text to arrive as text. The hazard is the fence itself: a
 * value that happens to contain three backticks closes a three-backtick block
 * early, and the rest of it lands in the document as Markdown — as headings, as
 * component invocations, as another fence. Writing that arithmetic in an eval
 * block puts the safety of the surrounding document in the hands of every
 * author who needs to quote something.
 *
 * So the fence is chosen here, from the value, and it is the only thing this
 * component decides. It scans for the longest run of backticks and opens with
 * one more than that, never fewer than three, which is a fence the value cannot
 * close no matter what it holds.
 *
 * ## The value is not read for anything else
 *
 * Nothing is trimmed, normalized, escaped, re-encoded or removed. Text that
 * looks like a fence, an element, an interpolation, HTML or an executable code
 * block stays exactly as it arrived, because a function component's return is
 * rendered rather than rescanned as document source (§6.8). The two line feeds
 * that frame the value belong to the envelope, not to the value, and there is
 * no line feed after the closing fence: a document that wants one writes it.
 *
 * ## `value` is an ordinary prop
 *
 * Unlike `<Json>` (§6.12), whose operand must arrive by reference or lose the
 * very failures it exists to report, a string crosses the component JSON
 * boundary as itself. Keeping `value` on the ordinary boundary is what lets a
 * repository `CodeBlock.md` receive it the way it receives every other prop,
 * instead of inheriting a capture from core's registration that it never
 * declared.
 *
 * `language` is closed to one token — the info string a Markdown reader expects
 * — so that a value cannot reach the opening fence line, where it would be read
 * as syntax rather than shown as text.
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
