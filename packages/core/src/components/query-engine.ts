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
 * usable. Loading it twice is the module cache's job, not this file's, so there
 * is no instance to own, revoke or tear down here, and nothing retains the
 * invocation that triggered the load.
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

import { until } from "effection";
import type { Operation } from "effection";

/** What this file uses of the package, stated where it is consumed. */
interface Evaluator {
  evaluateWithStatus(
    expression: string,
    input: string,
    options: EvaluationOptions,
  ): { readonly output: string };
}

interface EvaluationOptions {
  readonly inputFormat: "json";
  readonly outputFormat: "json" | "yaml";
  readonly indent: number;
  readonly unwrapScalar: false;
  readonly printDocSeparators: false;
  readonly env: Record<string, string>;
  readonly files: Record<string, string>;
}

/** Everything both components fix about an evaluation, as the package takes it. */
function options(outputFormat: "json" | "yaml"): EvaluationOptions {
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

function* evaluator(): Operation<Evaluator> {
  const loaded = yield* until(import("yq.rs"));
  return (loaded as { yq: Evaluator }).yq;
}

/** How a selection can fail to be one JSON value. */
export type SelectionRefusal = "none" | "several";

/** What one evaluation produced: a JSON text, or why it is not one value. */
export type Selection =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly refusal: SelectionRefusal };

/**
 * Evaluate `expression` over `input` and answer with one JSON text.
 *
 * `input` is JSON the caller already serialized. A thrown evaluation failure is
 * the package's and travels out of here unchanged, so the component can present
 * it as its own refusal with that cause.
 */
export function* select(expression: string, input: string): Operation<Selection> {
  const yq = yield* evaluator();
  const { output } = yq.evaluateWithStatus(expression, input, options("json"));
  if (output.trim() === "") {
    return { ok: false, refusal: "none" };
  }
  try {
    JSON.parse(output);
  } catch {
    return { ok: false, refusal: "several" };
  }
  return { ok: true, json: output };
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
