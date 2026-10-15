/**
 * The component forms a host offers to generated XMD, read once and validated
 * whole (spec §5.3.2).
 *
 * `Component.generated` is a plain contextual value property, so what reaches
 * core is one complete selection a host composed rather than a collection
 * anybody contributed to. It names components and spellings and nothing else:
 * which URL each spelling runs under, what its props are validated against,
 * whether it observes or mutates, and what documentation describes it all belong
 * to the declaration that owns the implementation
 * (`components/generated-metadata.ts`).
 *
 * ## Read once into owned data
 *
 * A selection is a caller-owned object, and every member of it is read exactly
 * once — into the map this module answers with — before anything is derived
 * from it. Checking the host's object and then reading it again to retain it
 * would be two readings of a value the host controls, where an accessor could
 * answer one thing for the check and another for the copy. So the reading that
 * was validated is the reading that is retained.
 *
 * ## Whole, or not at all
 *
 * `undefined` preserves absence: the host offers no generated evaluation, a
 * document that never writes `<Evaluate>` runs, and an `<Evaluate>` refuses
 * before its producer. Anything else is held to all of it — at least one name,
 * every name a component name, every value a canonical non-empty form
 * declaration — and a selection that fails any of it refuses setup. Nothing is
 * repaired, filtered, merged, or replaced with a default, because a partially
 * read selection would install an allowance no host stated.
 */

import type { GeneratedSelection } from "./component-api.ts";
import { isComponentName } from "./components/registration.ts";
import { formsRefusal } from "./invocation-forms.ts";
import type { InvocationForm } from "./invocation-identity.ts";

/** A selection a host stated in a shape canonical execution cannot capture. */
export class GeneratedSelectionError extends Error {
  override name = "GeneratedSelectionError";
}

/**
 * One validated selection, in canonical order.
 *
 * Sorted by component name rather than kept in the order a host's object
 * happened to enumerate in. Two middleware handlers compose one selection
 * normally, so enumeration order is a property of the assembly rather than of
 * what the host chose — and the retained admission compares the selected rows
 * position by position. Deriving the order from the names makes that comparison
 * a fact about the selection instead of about how it was built.
 */
export type AdmittedSelection = ReadonlyMap<string, readonly InvocationForm[]>;

/**
 * The selection this host offers, or nothing when it offers none.
 *
 * The one place the contextual answer is interpreted. Every refusal happens
 * here — before a name is resolved, before public execution policy, before the
 * root import and before a producer renders — so a host that stated a selection
 * core cannot capture has no partial allowance anywhere in the execution.
 */
export function admitGeneratedSelection(
  selection: GeneratedSelection | undefined,
): AdmittedSelection | undefined {
  if (selection === undefined) {
    return undefined;
  }
  if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
    throw new GeneratedSelectionError(
      "a host offered generated components as something other than a map of component names to " +
        "authored forms. The selection is one object naming what a fragment may write, and " +
        "offering none is stating no selection at all.",
    );
  }
  const admitted = new Map<string, readonly InvocationForm[]>();
  for (const key of Reflect.ownKeys(selection)) {
    if (typeof key !== "string") {
      throw new GeneratedSelectionError(
        `a host offered generated use of "${String(key)}", which is not a component name.`,
      );
    }
    if (!isComponentName(key)) {
      throw new GeneratedSelectionError(
        `a host offered generated use of "${key}", which is not a component name.`,
      );
    }
    // One read of this member, into data this module owns. The copy below is
    // what every check and the retained map read; the host's object is never
    // consulted again.
    admitted.set(key, readForms(key, Reflect.get(selection, key)));
  }
  if (admitted.size === 0) {
    throw new GeneratedSelectionError(
      "a host offered generated evaluation and selected no component. A host that offers " +
        "evaluation states what a fragment may write; one that offers none states no selection.",
    );
  }
  return Object.freeze(new Map([...admitted].sort(([one], [other]) => compare(one, other))));
}

/**
 * One name's spellings, copied once and held to the canonical declaration.
 *
 * The same contract a registration's `forms` is held to, through the same
 * validator: one canonical spelling per meaning, so an empty array, a reversed
 * pair, a repeated member and a form no invocation has are each refused where
 * the selection is stated. Omission is not accepted here, because a selection
 * states which spellings it offers — a name with no spelling offers nothing a
 * fragment could write.
 */
function readForms(name: string, value: unknown): readonly InvocationForm[] {
  if (!Array.isArray(value)) {
    throw new GeneratedSelectionError(
      `a host offered generated use of "${name}" as something other than a list of authored ` +
        "forms.",
    );
  }
  // Each member read once, and parsed into one of the two forms rather than
  // cast: what the canonical check below reads is this array, and what the
  // selection retains is this array, so an accessor-backed index cannot answer
  // one form for the check and another for the grant.
  const forms: InvocationForm[] = [];
  for (const member of value) {
    const form = FORMS.find((known) => known === member);
    if (form === undefined) {
      throw new GeneratedSelectionError(
        `a host offered generated use of "${name}" in a "${String(member)}" form, which is not ` +
          "an authored form.",
      );
    }
    forms.push(form);
  }
  const refusal = formsRefusal(forms);
  if (refusal !== undefined) {
    throw new GeneratedSelectionError(`a host offered generated use of "${name}" and ${refusal}.`);
  }
  return Object.freeze(forms);
}

/** The two authored forms, in the one order a canonical declaration states them. */
const FORMS: readonly InvocationForm[] = ["self-closing", "paired"];

function compare(one: string, other: string): number {
  return one < other ? -1 : one > other ? 1 : 0;
}
