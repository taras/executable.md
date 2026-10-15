/**
 * How an authored forms declaration may be written (spec §5.3).
 *
 * One contract, in a module of its own, because two kinds of declaration are
 * held to it and neither may drift: what a registration or a factory says it
 * accepts, and which of those spellings it offers for generated use
 * (`components/generated-metadata.ts`). The second has to read the first, and
 * reading it through the module that builds dispatchers would make the metadata
 * validator depend on the component graph it is validating against.
 */

import type { InvocationForm } from "./invocation-identity.ts";

/**
 * The only ways a forms declaration may be written.
 *
 * A closed list rather than a set membership test, because the *order* is part
 * of the declaration: one canonical spelling per meaning means two entries can be
 * compared without normalizing, and a reader never has to wonder whether
 * `["paired", "self-closing"]` said something different.
 */
const CANONICAL_FORMS: readonly (readonly InvocationForm[])[] = [
  ["self-closing"],
  ["paired"],
  ["self-closing", "paired"],
];

/**
 * Why `forms` is not a canonical declaration, or `undefined` when it is.
 *
 * Omission is canonical and means both forms, which is what every declaration
 * meant before forms could be written. Anything present is held to the list
 * above, so an empty array, a reversed pair, a repeated member and a form no
 * invocation has are each refused where the declaration is made rather than
 * reaching a document as documentation nothing can act on.
 *
 * A reason rather than a thrown error, because the callers raise different
 * kinds of failure and each owns its own sentence. `unknown` rather than the
 * declared type, because a host crosses this boundary from JavaScript.
 */
export function formsRefusal(forms: unknown): string | undefined {
  if (forms === undefined) {
    return undefined;
  }
  const canonical =
    Array.isArray(forms) &&
    CANONICAL_FORMS.some(
      (accepted) =>
        accepted.length === forms.length && accepted.every((form, index) => form === forms[index]),
    );
  if (canonical) {
    return undefined;
  }
  return (
    `declares forms ${JSON.stringify(forms)}: the accepted declarations are ` +
    `["self-closing"], ["paired"] and ["self-closing", "paired"], or none at all for both. ` +
    "A form is written once, and a pair is written self-closing first"
  );
}

/**
 * The forms a declaration accepts, having passed `formsRefusal()`.
 *
 * `undefined` for genuine omission, which means both — the one reading that
 * widens anything, and the reason a malformed value is refused above rather
 * than treated as absent here.
 */
export function acceptedForms(forms: unknown): readonly InvocationForm[] | undefined {
  if (!Array.isArray(forms)) {
    return undefined;
  }
  const accepted = CANONICAL_FORMS.find(
    (candidate) =>
      candidate.length === forms.length && candidate.every((form, index) => form === forms[index]),
  );
  return accepted === undefined ? undefined : [...accepted];
}
