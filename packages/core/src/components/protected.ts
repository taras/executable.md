/**
 * The names canonical core answers for, ahead of every other tier.
 *
 * Resolution already had a protected tier — a reserved registration, or exact
 * Markdown a host declared — but both of those are *a host's* claim, made by
 * whoever assembled the run. This tier is the engine's own, and it sits above
 * them: a protected name means the same thing in every execution, whichever host
 * built it, whichever package registered what, and whatever a repository holds.
 *
 * There is one component in it. `<Syntax />` describes the vocabulary of the
 * site it is written at, and a description of a run's vocabulary that anything
 * in the run could answer for is a description of nothing — the value of the
 * answer is exactly that nobody but core produced it.
 *
 * ## What protection is, and is not
 *
 * Protection settles *which definition runs*. A repository `Syntax.md`, a
 * bundled `Syntax`, an ordinary or reserved registration, a declared Markdown
 * component and a definition from a second loaded copy of core can none of them
 * win selection here. `Component.importComponent` middleware composes around the
 * import exactly as it composes around any other: it may observe it, delegate it
 * and refuse it by throwing, and what it cannot do is answer one — the answer is
 * verified at the call site against core's own retained copy, and core's copy is
 * what is invoked.
 *
 * Protection is not authority to do anything. A protected implementation is
 * handed the lexical syntax reference for its site and nothing else: no component
 * definitions, no import witness, no invocation capability, no policy table, no
 * provider and no registration handle.
 *
 * ## Why it is not a registration
 *
 * A registration is an answer a registry gives for a name, and a registry is
 * something a nested scope layers over, a host installs into, and a handler can
 * keep a record from and hand back somewhere else. A name that must mean one
 * thing cannot be decided by any of that, so the tier is the resolver's own
 * table and the implementation reaches the call site through the execution that
 * built it.
 */

import { SYNTAX_PROTECTED } from "./Syntax.ts";
import type { ImportRefusal, ImportTier } from "./import-authority.ts";
import type { ComponentDocumentation } from "./documentation.ts";
import type { ProtectedDeclaration } from "../invocation-identity.ts";
import type { ComponentOrigin } from "../types.ts";

/**
 * One component canonical core claims the name of.
 *
 * The same contract an identity component declares, minus the choice of origin:
 * a protected component is core's, so it reports core's origin. Its body is
 * built once per execution, with the claimant that execution minted, and the
 * implementation the execution wraps it in is the only thing that name resolves
 * to there.
 */
export interface ProtectedComponent extends ProtectedDeclaration, ComponentDocumentation {}

/** Every name the engine itself claims. */
export const PROTECTED_COMPONENTS: readonly ProtectedComponent[] = Object.freeze([
  SYNTAX_PROTECTED,
]);

const BY_NAME: ReadonlyMap<string, ProtectedComponent> = new Map(
  PROTECTED_COMPONENTS.map((component) => [component.name, component]),
);

/** The names above, as a set, for the admissions that must refuse them. */
export const PROTECTED_COMPONENT_NAMES: ReadonlySet<string> = new Set(BY_NAME.keys());

/** What canonical core answers for this name, or nothing when it answers none. */
export function protectedComponent(name: string): ProtectedComponent | undefined {
  return BY_NAME.get(name);
}

/**
 * The origin a protected component reports.
 *
 * Its own kind, because reusing `registered` with `reserved: true` said
 * something untrue. A reserved registration is a *host* installing a component
 * under a name it wants kept, so it can be absent from another execution,
 * replaced by a different host, or refused when two hosts claim it. A protected
 * component is core's own declaration: present in every execution, supplied by
 * no registry, and unable to be registered at all. Reporting one as the other
 * told a reader the name was a host's to take.
 */
export function protectedOrigin(
  component: ProtectedComponent,
): Extract<ComponentOrigin, { kind: "protected" }> {
  return { kind: "protected", origin: component.origin };
}

/** A protected name a host, a bundle or a registration tried to claim. */
export class ProtectedComponentError extends Error {
  override name = "ProtectedComponentError";
}

/** What a name that canonical core owns refuses a second claim with. */
export function protectedNameRefusal(name: string, claim: string): string {
  return (
    `cannot ${claim} "${name}": canonical core owns that name, so what it means is the same in ` +
    "every execution and nothing else answers for it"
  );
}

/** The fixed diagnostic each verification failure produces. */
const REFUSED: Record<ImportRefusal, string> = {
  unissued:
    "Component.importComponent middleware answered an import of a component canonical core " +
    "owns with a definition canonical execution did not produce. A handler may observe, " +
    "delegate or refuse the import; only canonical execution answers one.",
  "another-name":
    "Component.importComponent middleware answered an import of a component canonical core " +
    "owns with the definition canonical execution produced for another component.",
  changed:
    "Component.importComponent middleware changed the definition canonical execution produced " +
    "for a component canonical core owns before it was invoked.",
};

/**
 * The tier a protected import is verified through.
 *
 * It closes the names it claims and nothing else, exactly as a declaration does:
 * claiming `Syntax` says nothing about what any other name in the execution may
 * resolve to, and every other import stays the open one it has always been.
 */
export class ProtectedImports implements ImportTier {
  claims(name: string): boolean {
    return PROTECTED_COMPONENT_NAMES.has(name);
  }

  readonly closesExecution = false;

  refuse(refusal: ImportRefusal): Error {
    return new ProtectedComponentError(REFUSED[refusal]);
  }
}
