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
 * ## Validated, not trusted
 *
 * A declaration crosses a package boundary, so this reads it the way durable
 * input is read: exactly the two members, an identity in the accepted HTTPS
 * namespace, one of the two effects, and a form the declaration itself accepts.
 * The identity is stored and compared as the supplied string — nothing fetches
 * it, normalizes it into an alias, or infers it from the implementation.
 *
 * It imports no registry and no protected table. Validating plain metadata
 * through the component graph would reopen the initialization cycle that graph
 * already exposes, and nothing here needs to know which components exist.
 */

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
 * Why this metadata is unusable, or nothing when it is usable.
 *
 * A sentence rather than a thrown error, like `formsRefusal()`: a registration,
 * a factory declaration and a resolved provider definition each refuse in their
 * own error family and with their own diagnostic context, and a shared throw
 * here would take that context away from all three.
 *
 * `accepted` is the forms the declaration itself accepts — `undefined` keeping
 * its ordinary meaning of both — because offering generated use of a form the
 * component refuses to be written in is offering nothing that can run.
 */
export function generatedRefusal(
  generated: unknown,
  accepted: readonly InvocationForm[] | undefined,
): string | undefined {
  if (generated === undefined) {
    return undefined;
  }
  if (typeof generated !== "object" || generated === null || Array.isArray(generated)) {
    return "states generated forms that are not a map of authored forms";
  }
  const offerable = accepted === undefined ? FORMS : accepted;
  for (const key of Reflect.ownKeys(generated)) {
    const form = authoredForm(key);
    if (form === undefined) {
      return `states generated metadata for "${String(key)}", which is not an authored form`;
    }
    if (!offerable.includes(form)) {
      return `offers generated use of its ${form} form, which it does not accept`;
    }
    const refusal = formRefusal(Reflect.get(generated, form), form);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  return undefined;
}

function formRefusal(value: unknown, form: InvocationForm): string | undefined {
  const malformed = `states a ${form} generated form that is not an identity and an effect`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformed;
  }
  const members = Reflect.ownKeys(value);
  if (members.length !== 2 || !members.includes("identity") || !members.includes("effect")) {
    return malformed;
  }
  if (generatedEffect(Reflect.get(value, "effect")) === undefined) {
    return `offers its ${form} form under an effect this engine does not have`;
  }
  const identity = Reflect.get(value, "identity");
  if (typeof identity !== "string" || !isGeneratedIdentity(identity)) {
    return (
      `offers its ${form} form under "${String(identity)}", which is not an absolute URL in ` +
      `${GENERATED_IDENTITY_ORIGIN}`
    );
  }
  return undefined;
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
 * This metadata as the engine keeps it: a frozen copy, down to each form.
 *
 * Copied because the declaration's object is the declarer's, and frozen through
 * because a shared definition is read by every execution in the process — a
 * nested record left mutable would be what the next execution took its own
 * first copy of, with the change already in it.
 */
export function captureGenerated(generated: GeneratedForms): GeneratedForms {
  const captured: Partial<Record<InvocationForm, GeneratedForm>> = {};
  for (const form of FORMS) {
    const offered = generated[form];
    if (offered !== undefined) {
      captured[form] = Object.freeze({ identity: offered.identity, effect: offered.effect });
    }
  }
  return Object.freeze(captured);
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
 * For a definition that never passed registration — a provider's published
 * answer — where both members have to be read off the object defensively
 * rather than destructured from a declared shape. The accepted forms are read
 * the same way, because a definition stating forms this engine does not have
 * accepts none of them.
 */
export function definitionGeneratedRefusal(definition: object): string | undefined {
  const generated = Reflect.get(definition, "generated");
  if (generated === undefined) {
    return undefined;
  }
  return generatedRefusal(generated, acceptedForms(Reflect.get(definition, "forms")));
}

/**
 * The authored forms this value states, or `undefined` for a value that states
 * none — which is every form, exactly as an omitted declaration means both.
 */
function acceptedForms(value: unknown): readonly InvocationForm[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const accepted: InvocationForm[] = [];
  for (const member of value) {
    const form = authoredForm(member);
    if (form !== undefined) {
      accepted.push(form);
    }
  }
  return accepted;
}
