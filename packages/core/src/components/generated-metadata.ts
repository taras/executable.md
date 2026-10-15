/**
 * What a declaration says about the generated use of its own forms (spec §5.3).
 *
 * A generated fragment names a component, and what that name is admitted as —
 * which URL a continuation is compared against, and whether the form observes
 * or mutates — belongs to the declaration that owns the implementation. It used
 * to be stated beside the definition, by whichever host assembled the table, so
 * one component's two spellings were two host-stated grants and a host could
 * describe an effect the implementation does not have.
 *
 * So the metadata travels on the declaration, per authored form, and every
 * table that admits a name reads it off the definition it already holds. A
 * component that offers no generated use carries none, which is the ordinary
 * case: metadata is what makes a form offerable, and offering none takes
 * nothing away from authored use.
 *
 * ## Read once, validated and retained as one value
 *
 * A declaration crosses a package boundary, so the metadata is read the way
 * durable input is read: exactly the two members, an identity in the accepted
 * HTTPS namespace, one of the two effects, and a spelling the declaration
 * itself accepts. The identity is stored and compared as the supplied string —
 * nothing fetches it, normalizes it into an alias, or infers it from the
 * implementation.
 *
 * One pass does all of it, and what it answers with is the copy. Validating the
 * declarer's object and then copying it again would be two readings of a value
 * the declarer controls: an accessor answering a valid URL for the check and
 * another for the copy would have installed what the check never saw. So
 * `admitGeneratedForms()` reads each member exactly once, into data of its own,
 * and the caller retains that same data.
 *
 * It imports no registry and no protected table. Validating plain metadata
 * through the component graph would reopen the initialization cycle that graph
 * already exposes, and nothing here needs to know which components exist.
 */

import { Err, Ok } from "effection";
import type { Result } from "effection";

import { acceptedForms, formsRefusal } from "../invocation-forms.ts";
import type { InvocationForm } from "../invocation-identity.ts";

/** Whether a generated form observes or mutates. */
export type GeneratedEffect = "read" | "write";

/** What one authored form is offered for generated use as. */
export interface GeneratedForm {
  /** The absolute URL a continuation is compared against. */
  readonly identity: string;
  readonly effect: GeneratedEffect;
}

/** The generated use a declaration offers, by authored form. */
export type GeneratedForms = Readonly<Partial<Record<InvocationForm, GeneratedForm>>>;

/** The namespace every generated identity is written in. */
export const GENERATED_IDENTITY_ORIGIN = "https://executable.md";

const EFFECTS: readonly GeneratedEffect[] = ["read", "write"];
const FORMS: readonly InvocationForm[] = ["self-closing", "paired"];

/** The authored form this value names, or nothing when it names none. */
function authoredForm(value: unknown): InvocationForm | undefined {
  return FORMS.find((form) => form === value);
}

/** The effect this value names, or nothing when it names none. */
function generatedEffect(value: unknown): GeneratedEffect | undefined {
  return EFFECTS.find((effect) => effect === value);
}

/**
 * This declaration's generated metadata, read once into owned frozen data — or
 * the reason it is unusable.
 *
 * `accepted` is the forms the declaration itself accepts, `undefined` keeping
 * its ordinary meaning of both, because offering generated use of a form the
 * component refuses to be written in is offering nothing that can run.
 *
 * Frozen through, because a shared definition is read by every execution in the
 * process: a nested record left mutable would be what the next execution took
 * its own first copy of, with the change already in it.
 */
export function admitGeneratedForms(
  generated: unknown,
  accepted: readonly InvocationForm[] | undefined,
): Result<GeneratedForms> {
  if (typeof generated !== "object" || generated === null || Array.isArray(generated)) {
    return Err(new Error("states generated forms that are not a map of authored forms"));
  }
  const offerable = accepted === undefined ? FORMS : accepted;
  const captured: Partial<Record<InvocationForm, GeneratedForm>> = {};
  for (const key of Reflect.ownKeys(generated)) {
    const form = authoredForm(key);
    if (form === undefined) {
      return Err(
        new Error(`states generated metadata for "${String(key)}", which is not an authored form`),
      );
    }
    if (!offerable.includes(form)) {
      return Err(new Error(`offers generated use of its ${form} form, which it does not accept`));
    }
    // One read of each member, into data this module owns. Everything below —
    // the checks and the retained copy alike — reads that data and never the
    // declarer's object again.
    const offered = read(Reflect.get(generated, form), form);
    if (!offered.ok) {
      return offered;
    }
    captured[form] = offered.value;
  }
  return Ok(Object.freeze(captured));
}

/** One offered form, read once and checked. */
function read(value: unknown, form: InvocationForm): Result<GeneratedForm> {
  const malformed = Err<GeneratedForm>(
    new Error(`states a ${form} generated form that is not an identity and an effect`),
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformed;
  }
  const members = Reflect.ownKeys(value);
  if (members.length !== 2 || !members.includes("identity") || !members.includes("effect")) {
    return malformed;
  }
  const identity = Reflect.get(value, "identity");
  const effect = generatedEffect(Reflect.get(value, "effect"));
  if (effect === undefined) {
    return Err(new Error(`offers its ${form} form under an effect this engine does not have`));
  }
  if (typeof identity !== "string" || !isGeneratedIdentity(identity)) {
    return Err(
      new Error(
        `offers its ${form} form under "${String(identity)}", which is not an absolute URL in ` +
          GENERATED_IDENTITY_ORIGIN,
      ),
    );
  }
  return Ok(Object.freeze({ identity, effect }));
}

/**
 * Why this metadata is unusable, or nothing when it is usable.
 *
 * The sentence alone, for a caller that refuses rather than retains: a
 * registration, a factory declaration and a resolved provider definition each
 * raise their own kind of failure with their own diagnostic context, and a
 * shared throw here would take that context away from all three.
 */
export function generatedRefusal(
  generated: unknown,
  accepted: readonly InvocationForm[] | undefined,
): string | undefined {
  if (generated === undefined) {
    return undefined;
  }
  const admitted = admitGeneratedForms(generated, accepted);
  return admitted.ok ? undefined : admitted.error.message;
}

/**
 * Whether this string is an identity a generated form may be offered under.
 *
 * Parsed as a URL and compared by origin, never by prefix: a host reading the
 * text instead of the origin would admit `https://executable.md.example.com/`
 * and `https://executable.md@elsewhere.example/`, which start with the accepted
 * string and name somebody else.
 */
export function isGeneratedIdentity(identity: string): boolean {
  try {
    return new URL(identity).origin === GENERATED_IDENTITY_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * The identity and effect one authored form is offered under, when it is.
 *
 * The one read every admitting table performs, so a selected form that carries
 * no metadata is one answer rather than each caller's own lookup.
 */
export function offeredForm(
  generated: GeneratedForms | undefined,
  form: InvocationForm,
): GeneratedForm | undefined {
  return generated?.[form];
}

/**
 * Why a definition's own generated metadata is unusable, or nothing.
 *
 * The check every *live* admission makes, wherever a definition reaches a
 * generated table: a provider's published answer, a host's directly pinned
 * entry, and a captured profile entry are all definitions nothing validated on
 * the way in, so each is read here before anything is admitted or retained.
 *
 * A definition offering generated use is held to its own stated forms, through
 * the same accepted-form contract a registration is. That value is read rather
 * than trusted too: only genuine omission means both forms, so a malformed
 * `forms` is refused instead of being filtered into a declaration that looks
 * canonical. A definition offering no generated use is left alone, because it
 * is asking for nothing that identity or effect decides.
 */
export function definitionGeneratedRefusal(definition: object): string | undefined {
  const generated = Reflect.get(definition, "generated");
  if (generated === undefined) {
    return undefined;
  }
  const stated = Reflect.get(definition, "forms");
  const badForms = formsRefusal(stated);
  if (badForms !== undefined) {
    return badForms;
  }
  return generatedRefusal(generated, acceptedForms(stated));
}
