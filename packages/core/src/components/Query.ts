/**
 * `<Query>` — select one JSON value out of a value the document already has
 * (specs/executable-mdx-spec.md §6.22).
 *
 * `<File>` reads text, `<Glob>` lists paths, an eval block computes data; this
 * takes one of those values and answers with the part of it the author asked
 * for. The expression language is `yq`'s, and the whole of the request is the
 * value and the expression:
 *
 * ```xmd
 * <Query value={packageText} yq="from_json | .scripts" as="scripts" />
 * <Query value={scripts} yq=".test" />
 * ```
 *
 * With `as` the selected value is bound as data and nothing is written. Without
 * it the selected value is written as JSON — every type, including strings,
 * which are quoted and escaped the way `<Json>` writes them. One spelling, one
 * reading: an author never has to work out whether what they are looking at was
 * a string before it was printed.
 *
 * ## It queries a value, and runs nothing to get one
 *
 * The value arrives as an ordinary prop, so whatever produced it has already
 * finished and been bound. Querying it twice asks the same question of the same
 * data twice: no file is read again, no request is repeated, and a paged
 * producer's next page is not fetched because this never learns there is one.
 *
 * Text stays text. A JSON-looking string selected out of a value is a string,
 * and `from_json` or `from_yaml` in the expression is how an author says to
 * decode it — which is also what keeps a document that meant to match a quoted
 * body from silently matching its contents instead.
 *
 * ## One value is the answer
 *
 * `null`, `false` and `[]` are answers. No answer at all and several answers
 * are not: both refuse, and both say to collect with `[ … ]`, because an
 * expression that yielded three results would otherwise have to pick one and an
 * expression that yielded none would have to invent one.
 *
 * A refused selection binds nothing and prints nothing selected. The previous
 * value of a binding this element would have written stays what it was — a
 * failed query leaves the document with the data it already had rather than
 * with the input it was handed.
 */

import type { Operation } from "effection";
import { hasBinding, hasContent } from "../component-api.ts";
import { printErrors } from "../component-failures.ts";
import { parseJson } from "../json.ts";
import { select } from "./query-engine.ts";
import type { Json } from "../types.ts";

export const props = {
  type: "object",
  properties: {
    // Any JSON value: what can be queried is what a document can hold.
    value: {},
    yq: { type: "string", minLength: 1 },
  },
  required: ["value", "yq"],
  additionalProperties: false,
};

/** An invocation `<Query>` cannot run, or a selection it cannot accept. */
export class QueryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QueryError";
  }
}

const CONTENT =
  '<Query> selects from the value it is given, not from content: write <Query value={…} yq="…" />.';
const FAILED = "<Query> could not evaluate this expression.";
const NONE =
  "<Query> expression selected nothing, and one JSON value is the answer: collect results with " +
  "`[ … ]` to select an array, which may be empty.";
const SEVERAL =
  "<Query> expression selected more than one value, and one JSON value is the answer: collect " +
  "results with `[ … ]` to select them as an array.";

export default printErrors(function* Query(props: Record<string, Json>): Operation<Json> {
  if (yield* hasContent()) {
    throw new QueryError(CONTENT);
  }
  // Asked before the selection, because the answer belongs to how the element
  // was written rather than to what the expression found.
  const bound = yield* hasBinding();
  const expression = String(props.yq);

  let selection;
  try {
    selection = yield* select(expression, JSON.stringify(props.value ?? null));
  } catch (error) {
    // The package's own evaluation failure, kept as the cause: what was wrong
    // with the expression is the thing the author needs, and restating it here
    // in other words would be a second, poorer reading of it.
    throw new QueryError(FAILED, { cause: error });
  }
  if (!selection.ok) {
    throw new QueryError(selection.refusal === "none" ? NONE : SEVERAL);
  }

  // Through the engine's own strict acceptance, so what a binding receives is
  // the same domain every other value in a document belongs to.
  const selected = parseJson(JSON.parse(selection.json));
  return bound ? selected : JSON.stringify(selected, null, 2);
});
