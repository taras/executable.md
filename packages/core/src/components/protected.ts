/**
 * The names canonical core answers for, ahead of every other tier.
 *
 * Resolution already had a protected tier — a reserved registration, or exact
 * Markdown a host declared — but both of those are *a host's* reservation,
 * made by whoever assembled the run. This tier is the engine's own, and it
 * sits above them: a protected name means the same thing in every execution,
 * whichever host built it, whichever package registered what, and whatever a
 * repository holds.
 *
 * There are five components in it, for two reasons. `<Syntax />` describes the
 * vocabulary of the site it is written at, and a description of a run's
 * vocabulary that anything in the run could answer for is a description of
 * nothing — the value of the answer is exactly that nobody but core produced
 * it. `<Evaluate>` runs program text the document did not author, under a
 * ceiling a trusted host stated before any document existed; a component in the
 * run answering for that name would decide what an unaudited fragment is
 * allowed to do. `<File>`, `<File.Delete>` and `<Dir>` name effects on the
 * author's own filesystem (`fixed-filesystem.ts`), and a repository `File.md`
 * answering for `<File>` would choose what a document writes under the name
 * every author already reads as core's.
 *
 * ## Two shapes, one tier
 *
 * What a protected name denotes is settled here; how its implementation comes
 * about is not the same for all five. `<Syntax />` and `<Evaluate>` are handed
 * a site canonical execution built for them, so each execution builds their
 * bodies from an identity authenticator it minted. The three filesystem
 * components are ordinary components whose bodies reach the filesystem through
 * contextual operations, so each is one definition built once per loaded copy
 * of core and answered with as it stands.
 *
 * Both shapes carry the same descriptive members, because selection,
 * inspection, documentation and validation ask every protected component the
 * same questions. Only the execution that resolves one has to tell them apart.
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
 * Protection is not permission to do anything, and it is not a second
 * filesystem. A protected implementation is handed what canonical execution
 * built for it and nothing else, and the three filesystem bodies perform every
 * operation through the installed `API.Files` provider — which middleware still
 * answers, transforms, delegates and refuses. Fixing the *name* says nothing
 * about which filesystem it reaches.
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

import { EVALUATE_PROTECTED } from "./Evaluate.ts";
import { SYNTAX_PROTECTED } from "./Syntax.ts";
import { FIXED_FILESYSTEM_DEFINITIONS, FIXED_FILESYSTEM_ORIGIN } from "./fixed-filesystem.ts";
import { documentationOf } from "./documentation.ts";
import type { ImportRefusal, ImportTier } from "./component-resolution.ts";
import type { ComponentDocumentation } from "./documentation.ts";
import type { ProtectedDeclaration } from "../invocation-identity.ts";
import type { ComponentOrigin, FunctionComponentDefinition } from "../types.ts";

/**
 * One component canonical core reserves the name of, whose body each execution
 * builds.
 *
 * The same contract an identity component declares, minus the choice of
 * origin: a protected component is core's, so it reports core's origin. Its
 * body is built once per execution, with the identity authenticator that
 * execution minted, and the implementation the execution wraps it in is the
 * only thing that name resolves to there.
 */
export interface ExecutionBuiltComponent extends ProtectedDeclaration, ComponentDocumentation {}

/**
 * One component canonical core reserves the name of and supplies as it stands.
 *
 * The definition is the whole of it. There is no identity authenticator to
 * mint and no site to build, so the execution's protected table answers with
 * this exact object — which is also what the generated-XMD write table pins,
 * so an authored element and an admitted generated one invoke one
 * implementation.
 */
export interface FixedComponent extends ComponentDocumentation {
  readonly name: string;
  readonly props: FunctionComponentDefinition["props"];
  readonly returns?: FunctionComponentDefinition["returns"];
  readonly captures?: FunctionComponentDefinition["captures"];
  readonly forms?: FunctionComponentDefinition["forms"];
  readonly origin: string;
  readonly definition: FunctionComponentDefinition;
}

/** One component canonical core reserves the name of, however it is supplied. */
export type ProtectedComponent = ExecutionBuiltComponent | FixedComponent;

/**
 * The tier entry one fixed definition supplies.
 *
 * Read off that definition rather than restated beside it: the definition
 * already carries the schema, the accepted forms and the prose, and a second
 * copy of any of them would be the one that drifted.
 */
function fixedComponent(definition: FunctionComponentDefinition): FixedComponent {
  return {
    name: definition.name,
    props: definition.props,
    ...(definition.returns === undefined ? {} : { returns: definition.returns }),
    ...(definition.captures === undefined ? {} : { captures: definition.captures }),
    ...(definition.forms === undefined ? {} : { forms: definition.forms }),
    origin: FIXED_FILESYSTEM_ORIGIN,
    ...documentationOf(definition),
    definition,
  };
}

/** The components whose bodies each execution builds for itself. */
export const EXECUTION_BUILT_COMPONENTS: readonly ExecutionBuiltComponent[] = Object.freeze([
  EVALUATE_PROTECTED,
  SYNTAX_PROTECTED,
]);

/** The definitions canonical core answers with as they stand. */
export const FIXED_COMPONENTS: readonly FixedComponent[] = Object.freeze(
  FIXED_FILESYSTEM_DEFINITIONS.map(fixedComponent),
);

/** Every name the engine itself reserves. */
export const PROTECTED_COMPONENTS: readonly ProtectedComponent[] = Object.freeze([
  ...EXECUTION_BUILT_COMPONENTS,
  ...FIXED_COMPONENTS,
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
 * replaced by a different host, or refused when two hosts reserve it. A
 * protected component is core's own declaration: present in every execution,
 * supplied by no registry, and unable to be registered at all. Reporting one
 * as the other told a reader the name was a host's to take.
 */
export function protectedOrigin(
  component: ProtectedComponent,
): Extract<ComponentOrigin, { kind: "protected" }> {
  return { kind: "protected", origin: component.origin };
}

/** A protected name a host, a bundle or a registration tried to reserve. */
export class ProtectedComponentError extends Error {
  override name = "ProtectedComponentError";
}

/** What a name that canonical core owns refuses a second reservation with. */
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
 * It closes the names it reserves and nothing else, exactly as a declaration
 * does: reserving `Syntax` says nothing about what any other name in the
 * execution may resolve to, and every other import stays the open one it has
 * always been.
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
