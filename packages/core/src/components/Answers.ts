/**
 * `<Answers>` — supply elicitation answers from the document
 * (specs/executable-mdx-spec.md §6.16.2).
 *
 * ```md
 * <Answers values={[{ decision: "approve" }]}>
 * <ReviewGate plan={plan} as="verdict" />
 * </Answers>
 * ```
 *
 * A component that elicits internally asks whoever the host's provider reaches.
 * Sometimes the surrounding document already knows the answer — a workflow
 * exercising a third-party component non-interactively, a demo, a documented
 * example, a region of a larger run that should not stop for a person.
 * `<Answers>` is how a document says so without writing TypeScript.
 *
 * It is elicitation middleware wearing a component's clothes: it installs a
 * provider for the duration of its body and answers from an ordered list. That
 * is the whole of it — there is no second mechanism here, and everything the
 * Elicitation Api already does still happens. Each answer is judged by core
 * against the *asking* component's schema before it binds, so a provided value
 * that does not fit fails exactly as a live provider's would. This component
 * validates nothing beyond reading its own list.
 *
 * Installed at `{ at: "min" }`, so the nearest `<Answers>` answers first and
 * nesting means what middleware nesting means.
 *
 * ## Running out
 *
 * By default an elicitation past the last value fails: a document that supplies
 * answers is saying what will be asked, and being wrong about that is a mistake
 * rather than a cue to find someone. `delegate` says the opposite explicitly —
 * an unanswered elicitation passes outward to the next provider, which is an
 * enclosing `<Answers>` if there is one and the host's provider otherwise. That
 * is the "script the first two, let a person answer the rest" mode, and it is
 * opt-in because the alternative reading of a short list is a bug.
 *
 * ## What it deliberately does not check
 *
 * Values left over when the body finishes are fine. `scriptElicitations()` fails
 * on them because a test that has quietly stopped eliciting should stop passing;
 * this is a production construct, and a document that supplies one more answer
 * than a branch happened to need has not done anything wrong.
 *
 * Replay consumes nothing. A restored answer never reaches a provider, so
 * `values` needs only what this run will actually ask.
 *
 * Unmarked, so a failure fails the document under #251's default.
 */

import type { Operation } from "effection";

import { content } from "../component-api.ts";
import { Elicitation } from "../elicitation-api.ts";
import { JsonParseError, parseJson } from "../json.ts";
import type { Json } from "../types.ts";

/** A `values` list that could not be read. Raised before the body expands. */
export class AnswersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswersError";
  }
}

export const props = {
  type: "object",
  properties: {
    // Either an array or captured JSON text describing one; both normalize
    // through the same reader.
    values: {},
    delegate: { type: "boolean", default: false },
  },
  required: ["values"],
  additionalProperties: false,
};

export default function* Answers(props: Record<string, Json>): Operation<string> {
  // Read the list before anything expands, so a malformed one is reported here
  // rather than surfacing inside a child disguised as a provider failure.
  const values = readValues(props.values);
  const delegate = props.delegate === true;
  let consumed = 0;

  yield* Elicitation.around(
    {
      *elicit([request], next) {
        if (consumed < values.length) {
          return values[consumed++];
        }
        if (delegate) {
          return yield* next(request);
        }
        throw new AnswersError(
          `<Answers /> has no value for elicitation ${consumed + 1}: ` +
            `${values.length} provided, ${consumed} consumed. Supply another value, or ` +
            "write delegate={true} to pass unanswered elicitations outward.",
        );
      },
    },
    { at: "min" },
  );

  return yield* content();
}

/**
 * Read `values` in either accepted spelling.
 *
 * Text is parsed and then read as JSON, because `JSON.parse` answers `unknown`:
 * the second pass is what produces typed values rather than asserted ones.
 */
function readValues(values: Json): Json[] {
  if (typeof values === "string") {
    let decoded: unknown;
    try {
      decoded = JSON.parse(values);
    } catch (error) {
      throw new AnswersError(
        `<Answers /> values text is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return asValueList(decoded);
  }
  return asValueList(values);
}

function asValueList(value: unknown): Json[] {
  if (!Array.isArray(value)) {
    throw new AnswersError(
      "<Answers /> values must be a JSON array of answers, or JSON text describing one.",
    );
  }
  try {
    return value.map((entry) => parseJson(entry));
  } catch (error) {
    if (error instanceof JsonParseError) {
      throw new AnswersError(`<Answers /> values must all be JSON: ${error.message}`);
    }
    throw error;
  }
}
