/**
 * The query engine `<Query>` and `<Yaml>` select and render with.
 *
 * One published package, loaded the first time an interpretation actually needs
 * it. The literal specifier is what keeps it in the module graph a compiled
 * binary and a published package are built from, and `until` is what makes the
 * import an ordinary operation of the invocation that asked — so a cancelled
 * element stops waiting for it the same way it stops waiting for anything else.
 *
 * The package's root export is a ready evaluator: its own top-level await
 * compiles the embedded WebAssembly once and hands back something already
 * usable. Loading it twice is the module cache's job, so there is no instance
 * to own, revoke or tear down here, and nothing retains the invocation that
 * triggered the load.
 *
 * ## Capabilities arrive as options, so none is given
 *
 * The evaluator reaches the environment, the filesystem and the clock only
 * through `env`, `files` and `now`. Both call sites below pass empty maps and
 * omit `now`, which is what makes `strenv(HOME)` an empty string rather than a
 * host reading, `load("/etc/passwd")` a refusal rather than a file, and `now` a
 * refusal rather than a timestamp. A document that wants data gives it to the
 * component as a value.
 *
 * ## One answer, or none
 *
 * `evaluateWithStatus` reports `matched`, which describes truthiness: a
 * selection of `false` or `null` is a successful selection that did not match.
 * Success is the absence of a thrown error, so that flag is read by nobody here.
 *
 * What comes back is text, and how many results it holds is decided by parsing
 * it whole. One JSON value parses. No results is an empty string, and several
 * results are several JSON values the parser rejects — so neither can be
 * mistaken for the other, and neither becomes a value by cutting the text into
 * lines.
 */

import { Err, Ok, until } from "effection";
import type { Operation, Result } from "effection";
import type { EvalOptions, Format, Yq } from "yq.rs";

/** Everything both components fix about an evaluation, as the package takes it. */
function options(outputFormat: Format): EvalOptions {
  return {
    inputFormat: "json",
    outputFormat,
    indent: 2,
    // A selected string arrives as JSON rather than bare, which is what lets
    // the whole answer be parsed as one value.
    unwrapScalar: false,
    printDocSeparators: false,
    env: {},
    files: {},
  };
}

function* evaluator(): Operation<Yq> {
  const { yq } = yield* until(import("yq.rs"));
  return yq;
}

/** A selection that is not one JSON value. */
export class QuerySelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuerySelectionError";
  }
}

const NONE =
  "<Query> expression selected nothing, and one JSON value is the answer: collect results with " +
  "`[ … ]` to select an array, which may be empty.";
const SEVERAL =
  "<Query> expression selected more than one value, and one JSON value is the answer: collect " +
  "results with `[ … ]` to select them as an array.";

/**
 * Evaluate `expression` over `input` and answer with one JSON text.
 *
 * `input` is JSON the caller already serialized. A thrown evaluation failure is
 * the package's and travels out of here unchanged, so the component can present
 * it as its own refusal with that cause.
 */
export function* select(expression: string, input: string): Operation<Result<string>> {
  const yq = yield* evaluator();
  const { output } = yq.evaluateWithStatus(expression, input, options("json"));
  if (output.trim() === "") {
    return Err(new QuerySelectionError(NONE));
  }
  try {
    JSON.parse(output);
  } catch {
    return Err(new QuerySelectionError(SEVERAL));
  }
  return Ok(output);
}

/**
 * Render `input` as the YAML text of the same value.
 *
 * The expression is identity, so what comes back is the package's own complete
 * rendering of what it was given — its indentation, its scalar quoting and its
 * terminating newline — returned without a second pass over the text.
 */
export function* yaml(input: string): Operation<string> {
  const yq = yield* evaluator();
  return yq.evaluateWithStatus(".", input, options("yaml")).output;
}
