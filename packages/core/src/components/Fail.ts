/**
 * `<Fail>` — stop authored work with the author's exact message
 * (specs/executable-mdx-spec.md §6.8.2).
 *
 * This is an ordinary function-component failure: core dismantles, names and
 * positions the invocation. No prefix or classification changes the message.
 * With no `printErrors()` declaration, a text root stops unless its author wrote
 * an enclosing `<PrintErrors>`. A value body's `throw` mode remains final, so a
 * printing boundary cannot turn the abort into success or a missing-Return error.
 *
 * Canonical dispatch refuses a paired form before expanding its children. The
 * closed schema requires one non-empty string `message`; malformed props fail
 * before the body. The body checks `hasBinding` before raising so an invalid `as`
 * capture reports the capture mistake instead of the authored message.
 *
 * It renders and returns nothing, owns no resource, permission, context, provider
 * or durable operation, and adds only ordinary import/root-outcome journal work.
 * Completed-root replay restores that outcome without expanding the root.
 */

import type { Operation } from "effection";
import { hasBinding } from "../component-api.ts";
import type { FormDeclaration, InvocationForm } from "../invocation-identity.ts";
import type { Json } from "../types.ts";

export const props = {
  type: "object",
  properties: {
    message: { type: "string", minLength: 1 },
  },
  required: ["message"],
  additionalProperties: false,
};

/** An invocation `<Fail>` will not raise from. */
export class FailInvocationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FailInvocationError";
  }
}

const BINDING = "<Fail> raises its message and binds nothing, so `as` is not accepted.";

const PAIRED = '<Fail> is self-closing and has no content: write <Fail message="…" /> instead.';

function* Fail(props: Record<string, Json>): Operation<string> {
  if (yield* hasBinding()) {
    throw new FailInvocationError(BINDING);
  }
  throw new Error(String(props.message));
}

/**
 * The one form this component runs, and what it says about the other.
 *
 * A refusal is a `FailInvocationError` about the invocation, never the authored
 * message: an invocation this component would not run raised nothing, and
 * reporting the author's sentence for it would say the document had decided
 * something it never reached.
 */
export const form: FormDeclaration = {
  forms: "self-closing",
  fn: Fail,
  refuse: (_props: Record<string, Json>, written: InvocationForm | undefined) =>
    new FailInvocationError(
      written === "paired"
        ? PAIRED
        : "<Fail> was called without the invocation the engine issued, so which form it was " +
            "written as cannot be established.",
    ),
};
