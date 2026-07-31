/**
 * `<Elicit>` — ask a person a structured question, without choosing how
 * (specs/executable-mdx-spec.md §6.16).
 *
 * ```md
 * <Elicit schema={responseSchema} as="response">
 * Review the implementation plan and provide your decision.
 * </Elicit>
 * ```
 *
 * The document says what it is asking and what shape the answer must have. Where
 * the asking happens is the host's decision, installed through the Elicitation
 * Api: a browser form under the CLI, scripted responses under a test, a terminal
 * or the Inspector later. None of that is expressible in Markdown, on purpose —
 * a `mode` prop would make every document that used it a document about its own
 * transport.
 *
 * This function is three steps and the order is the whole of it. The schema
 * compiles first, so a schema that cannot be used fails before the body expands
 * and before anyone is asked. The body expands next, on every execution
 * including a replay, because the rendered message is half of what identifies
 * the question. The journal wraps only the asking, so a replay restores the
 * answer without contacting a provider.
 *
 * It returns the validated response and nothing else. `as`, expression props,
 * props and return validation, binding, invocation lifetime, and settlement are
 * all core's, and this component deliberately does none of them.
 *
 * Unmarked, so a failure fails the document under #251's default. There is no
 * sensible way to carry on from "the person was never asked".
 */

import type { Operation } from "effection";

import { content, invocation } from "../component-api.ts";
import {
  guardRecordedQuestion,
  persistElicitation,
  questionFingerprint,
} from "../elicit-journal.ts";
import { prepareElicitation, runPreparedElicitation } from "../elicit.ts";
import type { ComponentInvocationMetadata, Json } from "../types.ts";

export const props = {
  type: "object",
  properties: {
    // Either captured JSON text or an already structured value; both normalize
    // through the same compiler.
    schema: {},
  },
  required: ["schema"],
  additionalProperties: false,
};

/**
 * Any JSON value, because the author's `schema` is the real contract and core
 * enforces it against the provider's answer.
 *
 * The `$schema` marker is what says "a schema, taken as written". A `returns`
 * object carrying neither `type` nor `$schema` is the concise shorthand for an
 * object's properties (§5.1.1), so a bare `{}` would declare an object with no
 * properties — the opposite of any value.
 */
export const returns = { $schema: "http://json-schema.org/draft-07/schema#" };

export default function* Elicit(props: Record<string, Json>): Operation<Json> {
  const prepared = prepareElicitation(props.schema);

  const message = yield* content();

  const identity = {
    location: formatLocation(yield* invocation()),
    fingerprint: questionFingerprint({ schema: prepared.schema, message }),
  };

  // Before the record is read, so a resumed document cannot bind an answer that
  // was given to a different question.
  yield* guardRecordedQuestion(identity);

  return yield* persistElicitation(identity, () => runPreparedElicitation(prepared, message));
}

/** `path:line:column`, `line:column`, or `unknown` — the durable identity. */
function formatLocation(metadata: ComponentInvocationMetadata): string {
  const position = metadata.position;
  if (!position) {
    return "unknown";
  }
  const at = `${position.line}:${position.column}`;
  return position.path ? `${position.path}:${at}` : at;
}
