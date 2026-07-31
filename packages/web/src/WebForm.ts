/**
 * `<WebForm>` — ask a person a structured question and bind their answer.
 *
 * ```md
 * <WebForm schema={reviewSchema} uiSchema={reviewUi} as="response">
 * # Review required
 *
 * Read the plan and decide.
 * </WebForm>
 * ```
 *
 * Everything that can be judged without opening a port is judged first: the
 * content is projected, the schema is parsed and compiled, and the body is
 * sanitized. Only then does anything observable happen. A document whose content
 * failed, or whose schema cannot be used, never binds a port, prints a URL, opens
 * a browser, or writes to the journal — and that ordering is the whole reason this
 * function reads the way it does.
 *
 * It returns the validated response and nothing else. `as`, expression props,
 * props and return validation, binding, invocation lifetime, and settlement are
 * all core's, and this component deliberately does none of them: it is registered
 * as an ordinary function component, so it gets them the same way every other
 * component does.
 *
 * Unmarked, so a failure fails the document under #251's default. There is no
 * sensible way to carry on from "the person was never asked".
 */

import { content, invocation } from "@executablemd/core";
import type { ComponentInvocationMetadata, PropsSchema, ReturnsSchema } from "@executablemd/core";
import type { Operation } from "effection";

import { parseDeclaration } from "./declaration.ts";
import type { Json } from "./json.ts";
import { fingerprint, persistResponse } from "./journal.ts";
import { liveForm } from "./live-form.ts";
import { renderBody } from "./markdown.ts";

export const WEB_FORM_PROPS: PropsSchema = {
  type: "object",
  properties: {
    // Either captured JSON text or an already structured value; both normalize
    // through the same declaration boundary.
    schema: {},
    uiSchema: {},
  },
  required: ["schema"],
  additionalProperties: false,
};

/**
 * Any JSON value, because the author's `schema` is the real contract and it is
 * enforced by the server that accepted the submission.
 */
export const WEB_FORM_RETURNS: ReturnsSchema = {};

export function* WebForm(props: Record<string, Json>): Operation<Json> {
  // First, so a failing body fails here — before a port exists to leak.
  const body = yield* content();

  const declaration = parseDeclaration(props.schema, props.uiSchema);
  const sanitized = renderBody(body);

  const question = {
    schema: declaration.schema,
    uiSchema: declaration.uiSchema,
    content: sanitized,
  };

  return yield* persistResponse(
    { location: formatLocation(yield* invocation()), fingerprint: fingerprint(question) },
    () => liveForm(question),
  );
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
