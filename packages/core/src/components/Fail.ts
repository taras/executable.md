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

/**
 * The mark itself.
 *
 * Stable and namespaced, because it is read across loaded copies. Changing this
 * string is changing a cross-copy contract.
 */
const AUTHORED_STOP = "executablemd.core.fail.authoredStop";

/**
 * State that this failure is the document deciding to stop, and answer with it.
 *
 * ## Why a mark rather than a class, a name or a message
 *
 * What reads this is the settling boundary, deciding whether an undescribed
 * failure is the document's own outcome or something escaping through it. Only
 * one undescribed failure is a decision the document made; a Git protocol
 * refusal, a retained-history rejection, an assertion abort and a missing
 * launcher all reach the same place and all have to keep escaping.
 *
 * `<Fail>` raises an ordinary `Error` carrying exactly the author's sentence,
 * and that is the public contract — so there is no class to test and no name or
 * message to read. `instanceof` would also answer no across a separately
 * loaded copy of this module, and `name` is writable, so any error at all could
 * wear it. A namespaced own property survives the boundary and is only there
 * because this throw site put it there.
 *
 * Non-enumerable, so an error that is copied, wrapped or serialized does not
 * take the mark along by accident: a failure that merely *carries* this one as a
 * cause is not the document's decision, and the boundary reads the object it
 * was handed rather than searching for a mark underneath it.
 */
function markAuthoredStop<E extends Error>(error: E): E {
  if (Object.getOwnPropertyDescriptor(error, AUTHORED_STOP) === undefined) {
    Object.defineProperty(error, AUTHORED_STOP, { value: true, enumerable: false });
  }
  return error;
}

/**
 * Whether this exact failure is a valid `<Fail>` deciding to stop the document.
 *
 * Answers `false` for everything else: an unmarked error, one merely named or
 * worded like an authored stop, a mark inherited from a prototype rather than
 * put on this object, and a wrapper that holds a marked error as its cause. An
 * invocation `<Fail>` refused is not the author's decision either, so the
 * refusal below is never marked.
 */
export function authoredStop(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return Object.getOwnPropertyDescriptor(error, AUTHORED_STOP)?.value === true;
}

const BINDING = "<Fail> raises its message and binds nothing, so `as` is not accepted.";

const PAIRED = '<Fail> is self-closing and has no content: write <Fail message="…" /> instead.';

function* Fail(props: Record<string, Json>): Operation<string> {
  if (yield* hasBinding()) {
    throw new FailInvocationError(BINDING);
  }
  throw markAuthoredStop(new Error(String(props.message)));
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
