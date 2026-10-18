/**
 * One execution's own `yq` engine, and the two questions it answers.
 *
 * A shared `yq` attribute selects data out of what a component returned, and
 * `<Yaml>` renders a value as a YAML document. Both are the same engine asking
 * the same vendor the same way, so both live here rather than in the two places
 * that call them.
 *
 * ## The engine belongs to the execution, and starts when it is wanted
 *
 * `yq.rs` publishes a root entry that compiles embedded WebAssembly and
 * instantiates a singleton while that module is evaluated. Importing it would
 * start a compilation in every process that loads core, for every document,
 * including the ones that query nothing. So core imports `yq.rs/loader`, which
 * instantiates nothing by itself, and supplies the bytes from its own generated
 * module (`yq-wasm.ts`).
 *
 * The owner below is built once per document execution and compiles on the
 * first question asked of it. A document that writes neither `yq` nor `<Yaml>`
 * decodes nothing and compiles nothing; one that writes three of them compiles
 * once; and a second execution gets a second owner, because an engine shared
 * across executions would outlive the one that paid for it. Nothing here is
 * module-global: no engine, no pending initialization, no registry and no
 * result cache.
 *
 * ## A halted first consumer does not publish
 *
 * `until()` adapts a promise and does not cancel it, so halting the coroutine
 * that started the initialization leaves the vendor's own compilation running to
 * completion. What halting does stop is the continuation: the suspended consumer
 * never resumes, so it binds nothing, publishes nothing and appends nothing. The
 * resolved engine stays on the owner for whoever asks next, and the owner is
 * revoked with its execution — an owner kept past teardown refuses rather than
 * answering from a finished run.
 *
 * ## The vendor is asked with no ambient inputs
 *
 * Every evaluation supplies an empty environment, an empty file map and a fixed
 * instant. `env(NAME)` therefore reports that the variable was not provided,
 * `load(path)` that the file was not provided, and `now` answers
 * `1970-01-01T00:00:00Z` — so an expression a document or an agent wrote cannot
 * read this host's environment, its filesystem or its clock through the engine.
 *
 * ## One answer, read whole
 *
 * `evaluateWithStatus` is what selection uses, because `evaluate` throws for the
 * vendor status that `null` and `false` produce — and those are values a
 * document may legitimately select. `matched` takes no part in acceptance for
 * the same reason.
 *
 * The answer is parsed whole. A `yq` expression may produce no results or
 * several, and the vendor prints several as several JSON documents in one
 * answer: reading the first, or splitting the text into lines, would turn
 * "these two things matched" into "this one thing matched" and would cut a
 * multiline string in half. So the whole answer is one JSON value or the
 * invocation refuses, and the refusal names the way to ask for several.
 */

import { createContext, until } from "effection";
import type { Operation } from "effection";
import { createYq } from "yq.rs/loader";
import type { EvalOptions, Yq } from "yq.rs/loader";

import { parseJson } from "./json.ts";
import type { Json } from "./types.ts";
import { YQ_WASM_BASE64 } from "./yq-wasm.ts";

/** The instant the engine reports for `now`, in place of this host's clock. */
const FIXED_NOW = "1970-01-01T00:00:00Z";

/** What every evaluation supplies, whatever it is being asked. */
const SHARED: EvalOptions = {
  unwrapScalar: false,
  printDocSeparators: false,
  indent: 2,
  env: {},
  files: {},
  now: FIXED_NOW,
};

/** Selection reads JSON and answers in JSON. */
const SELECT: EvalOptions = { ...SHARED, inputFormat: "json", outputFormat: "json" };

/** Rendering reads JSON and answers in YAML. */
const RENDER: EvalOptions = { ...SHARED, inputFormat: "json", outputFormat: "yaml" };

/** The identity expression, which is what rendering asks for. */
const IDENTITY = ".";

/** What an invocation is told when its expression did not produce one value. */
export const ONE_VALUE =
  "This yq expression must return one JSON value. Collect matches into an array with [ ... ].";

/** A `yq` expression that could not be evaluated, or an answer with no one value. */
export class ValueQueryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ValueQueryError";
  }
}

/** The questions one execution's engine answers. */
export interface ValueQuery {
  /**
   * The one JSON value `expression` selects out of `value`.
   *
   * `value` is the result a component actually returned, validated as JSON and
   * serialized for the engine — so a component that returned text is queried as
   * a JSON string, and an expression that wants the data inside it decodes it
   * explicitly with `from_json` or `from_yaml`.
   */
  select(expression: string, value: unknown): Operation<Json>;
  /**
   * The complete YAML document for one piece of JSON text.
   *
   * The text is the operand's own single serialization, so `<Json>` and
   * `<Yaml>` describe the same value through the same one call into it.
   */
  yaml(json: string): Operation<string>;
}

/** How an owner reaches a vendor engine for the bytes it was given. */
export type EngineFactory = (bytes: Uint8Array) => Promise<Yq>;

/**
 * The generated bytes, decoded.
 *
 * Decoded inside initialization rather than at module evaluation: the encoded
 * string is source data, and a document that asks nothing of the engine pays
 * for neither the decode nor the compile.
 *
 * Decoding is in bounded slices because `String.fromCharCode(...bytes)` over
 * four hundred thousand arguments overflows the call stack on every runtime
 * this ships to.
 */
function decode(): Uint8Array {
  const binary = atob(YQ_WASM_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) {
    bytes[at] = binary.charCodeAt(at);
  }
  return bytes;
}

/** One execution's owner, revoked with the execution that built it. */
export interface ValueQueryOwner extends ValueQuery {
  /** Make this owner unusable, and release what it was holding. */
  close(): void;
}

/**
 * Build the owner for one document execution.
 *
 * The factory is an argument so a test can hold an initialization open and
 * observe what a halted consumer does with it. Production passes none and gets
 * the pinned loader.
 */
export function createValueQuery(factory: EngineFactory = createYq): ValueQueryOwner {
  // The one pending initialization this owner will ever start. Stored before
  // the first consumer suspends, so a second consumer arriving while the first
  // is waiting shares it instead of starting a second compilation.
  let pending: Promise<Yq> | undefined;
  let live = true;

  function* engine(): Operation<Yq> {
    if (!live) {
      throw new ValueQueryError(
        "This execution has ended, so its yq engine is no longer available.",
      );
    }
    pending ??= factory(decode());
    const ready = yield* until(pending);
    // Read again after the suspension: an owner revoked while the vendor was
    // compiling must not answer from the engine that arrived afterwards.
    if (!live) {
      throw new ValueQueryError(
        "This execution has ended, so its yq engine is no longer available.",
      );
    }
    return ready;
  }

  return {
    *select(expression: string, value: unknown): Operation<Json> {
      const input = JSON.stringify(parseJson(value));
      const yq = yield* engine();

      let answer: string;
      try {
        answer = yq.evaluateWithStatus(expression, input, SELECT).output;
      } catch (error) {
        throw new ValueQueryError(
          `This yq expression could not be evaluated: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }

      // The whole answer, or nothing. An empty answer is no results, and an
      // answer that is not one JSON value is the vendor printing several — both
      // are the same thing to an invocation that binds one value, and neither
      // contributes a partial reading of what did match.
      if (answer.trim() === "") {
        throw new ValueQueryError(ONE_VALUE);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(answer);
      } catch (error) {
        throw new ValueQueryError(ONE_VALUE, { cause: error });
      }
      return parseJson(parsed);
    },

    *yaml(json: string): Operation<string> {
      const yq = yield* engine();
      try {
        return yq.evaluateWithStatus(IDENTITY, json, RENDER).output;
      } catch (error) {
        throw new ValueQueryError(
          `This value could not be rendered as YAML: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    },

    close(): void {
      live = false;
      pending = undefined;
    },
  };
}

/**
 * Which engine answers here.
 *
 * A stable namespaced name, so a separately loaded copy of core reaches the
 * engine the execution installed rather than starting one of its own. It routes
 * and permits nothing: what an expression may read is decided by the empty
 * environment and file map every evaluation supplies, not by who answered.
 *
 * There is no default. An expansion driven with no execution behind it has no
 * engine, and `yq` and `<Yaml>` say so rather than reaching for host state.
 */
export const ValueQueryContext = createContext<ValueQuery>("executablemd.core.value-query");

/** The engine in scope, or the refusal for an execution that installed none. */
export function* useValueQuery(): Operation<ValueQuery> {
  const selected = yield* ValueQueryContext.get();
  if (selected === undefined) {
    throw new ValueQueryError(
      "This execution has no yq engine, so `yq` and <Yaml> are unavailable here.",
    );
  }
  return selected;
}
