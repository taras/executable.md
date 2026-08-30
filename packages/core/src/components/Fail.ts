/**
 * `<Fail>` — stop authored work with a message the reader can act on
 * (specs/executable-mdx-spec.md §6.8.2).
 *
 * ```md
 * <Fail message="Review aborted; nothing was saved or run." />
 * ```
 *
 * A document that has decided it cannot continue has something to say about
 * why, and until now the only way to end a value body was to reach its end
 * without a `<Return>` — which reports that the body selected no value, not
 * what the author concluded. This raises the author's own sentence instead, at
 * the position the author wrote it.
 *
 * ## An ordinary failure, deliberately
 *
 * There is no new error mode here and no root special case. This is the
 * ordinary failure of a function component (§6.8.1): the engine dismantles the
 * invocation, names it, positions it at the opening tag, and propagates it. The
 * message is the author's exact string — nothing is prefixed, classified or
 * interpolated into it, because the author already wrote the sentence they
 * wanted the reader to see.
 *
 * It carries no `printErrors()` declaration, and that omission is the whole of
 * its recovery policy. A text root therefore stops here by default, and an
 * author who wants the document to continue says so with `<PrintErrors>` around
 * the region — the same way they would for any other component that fails. A
 * value body installs `throw`, which a printing boundary does not replace, so
 * an enclosing `<PrintErrors>` cannot turn a deliberate abort into a successful
 * result; the authored failure settles the body before missing-`<Return>`
 * settlement can report anything about it.
 *
 * ## What it refuses, and why it refuses it first
 *
 * The one form is self-closing, declared here and dispatched by canonical core,
 * so a paired spelling never expands its children: an author who wrote a body
 * meant something this component does not do. The closed schema takes one
 * required non-empty `message`, so a missing, empty, non-string or unknown prop
 * is refused by the ordinary props boundary before anything runs.
 *
 * `as` is the one refusal this body makes for itself, because `as` is valid for
 * a text component by default. There is no value to capture: this renders
 * nothing and returns nothing, it raises. Asking {@link hasBinding} before
 * raising is what makes a mistaken capture a report about the capture rather
 * than the authored message arriving under a name that would never be bound.
 *
 * ## What it owns
 *
 * Nothing. No authority, no context, no provider, no resource, and no durable
 * operation of its own — the only journal activity around it is what ordinary
 * execution already owns, importing the selected component and recording the
 * root's outcome. Replay of a completed root restores that outcome without
 * re-expanding the root.
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
