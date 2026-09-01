/**
 * Exact Markdown a trusted host declares to one execution (spec §5.3).
 *
 * A **declared Markdown component** is first-party Markdown the host ships and
 * names, rather than a file a repository supplies or a function a package
 * registers. The host states the bytes, where they came from, and their digest;
 * canonical core parses those exact bytes and refuses the declaration if what
 * the host said about them is not what they say about themselves.
 *
 * It is a composition mechanism, not a policy loader. Nothing a document, a
 * component, or middleware can write reaches this: the declaration crosses on
 * an `ExecutionInstallation`, by value, before any installation, middleware or
 * document code exists — the same terms a workflow component bundle crosses on.
 *
 * ## Why it is its own tier
 *
 * A repository file, a workflow bundle member and an ordinary registration can
 * all answer for a name. A declared component answers ahead of every one of
 * them, beside a reserved registration, because the host is claiming the name
 * rather than offering a default for it. Two claims on one name are a
 * configuration failure rather than a precedence question, so a declaration
 * colliding with a reserved registration or with another declaration is refused
 * before the root document is imported.
 *
 * ## The private closure
 *
 * A declaration may carry components only its own bytes may write. They are
 * *lexical availability*, not authority: each is an ordinary
 * {@link IdentityComponent}, built from a claimant this execution minted, and
 * it names nothing once the invocation it was given settles. What makes them
 * private is that nothing registers them — they are resolvable only while
 * canonical core is expanding the body of the exact declaration that carries
 * them, and the register below is offered and taken inside one import.
 *
 * Caller-projected content is not that body. Projection restores the caller's
 * frame and the caller's authority, so content written by whoever invoked the
 * declared component reaches no private name, and neither does an imported
 * component, a sibling invocation, or an implementation kept past teardown.
 */

import { createHash } from "node:crypto";
import type { Operation } from "effection";

import { canonicalFingerprint } from "../canonical.ts";
import { parseMarkdownDefinition } from "../definition.ts";
import { formsRefusal } from "../invocation-identity.ts";
import type { IdentityComponent } from "../invocation-identity.ts";
import { RESERVED_STRUCTURAL } from "../structural.ts";
import { CanonicalImports, retain } from "./import-authority.ts";
import type { ImportedDefinition, ImportRefusal, ImportTier } from "./import-authority.ts";
import { admitDeclaration, isComponentName } from "./registration.ts";
import { documentationOf } from "./documentation.ts";
import type {
  ComponentDefinition,
  ComponentRegistry,
  FunctionComponentDefinition,
  InvocationForm,
  PropsSchema,
  ReturnsSchema,
} from "../types.ts";

/** The forms a Markdown definition accepts when its host states none: both. */
const BOTH_FORMS: readonly InvocationForm[] = ["self-closing", "paired"];

/**
 * A declaration that cannot be installed, or an import a declaring execution
 * refuses.
 *
 * Thrown before the root document is imported when the declaration itself is
 * unusable, and out of one import when it is the answer that is.
 */
export class DeclaredMarkdownError extends Error {
  override name = "DeclaredMarkdownError";
}

/**
 * One exact Markdown component, as the host declares it.
 *
 * `source` is the authority on the contract. `props`, `returns` and `forms` are
 * optional statements *about* it — a host that states one is held to it, so a
 * packaged asset and the host that ships it cannot drift apart silently.
 *
 * There is no prose here for the same reason. What the component is for, what
 * its `as` binds and what its content means are frontmatter in those bytes,
 * exactly as they are for any other Markdown component, so the asset and the
 * catalog entry describing it are one text.
 */
export interface DeclaredMarkdownComponent {
  /** The name a document writes. */
  readonly name: string;
  /** Stable, human-readable source identity — reported by inspection. */
  readonly origin: string;
  /** The exact Markdown this component is. */
  readonly source: string;
  /** SHA-256 of `source` as UTF-8, lowercase hex. Checked, never trusted. */
  readonly digest: string;
  /** The forms this component accepts. Omitted means both. */
  readonly forms?: readonly InvocationForm[];
  /** What the host says the source declares. Refused when it disagrees. */
  readonly props?: PropsSchema;
  /** What the host says the source returns. Refused when it disagrees. */
  readonly returns?: ReturnsSchema;
  /** Components only elements authored by these exact bytes may resolve. */
  readonly privates?: readonly IdentityComponent[];
}

/** One declaration, admitted: what the host stated, checked against its bytes. */
export interface AdmittedDeclaredMarkdown {
  readonly name: string;
  readonly origin: string;
  readonly source: string;
  readonly digest: string;
  readonly forms: readonly InvocationForm[];
  /** The parse of `source`, produced once and shared by every reader. */
  readonly definition: ComponentDefinition;
  readonly privates: readonly IdentityComponent[];
}

/** The SHA-256 of exact UTF-8 bytes, lowercase hex. */
export function sourceDigest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function refuse(message: string): DeclaredMarkdownError {
  return new DeclaredMarkdownError(message);
}

/**
 * Admit what a host declared, on the terms an execution installs it on.
 *
 * Everything is checked before anything is built, so a refused set installs
 * nothing. The checks are on the declaration and its own bytes alone: no
 * factory is called, so this is usable where there is no execution — `xmd
 * syntax` and document validation describe the same environment a run would
 * have, and a set a run would refuse is refused for them too.
 */
export function* admitDeclaredMarkdown(
  declarations: readonly DeclaredMarkdownComponent[],
  registry: ComponentRegistry,
): Operation<readonly AdmittedDeclaredMarkdown[]> {
  const admitted: AdmittedDeclaredMarkdown[] = [];
  const claimed = new Set<string>();
  const privateNames = new Set<string>();

  for (const declaration of declarations) {
    const { name, origin, source, digest } = declaration;

    // The name is printed only once it has passed the grammar a document
    // writes: until then it is text of unknown provenance, and a refusal is not
    // a reason to publish it.
    if (!isComponentName(name)) {
      throw refuse("a declared Markdown component was given a name that is not a component name.");
    }
    if (RESERVED_STRUCTURAL.has(name)) {
      throw refuse(
        `a declared Markdown component was named "${name}", which is structural syntax the ` +
          "engine owns rather than a component.",
      );
    }
    if (origin.length === 0) {
      throw refuse(
        `the declared Markdown component "${name}" needs an origin naming where it came from.`,
      );
    }
    if (claimed.has(name)) {
      throw refuse(`"${name}" was declared as Markdown twice. One execution declares a name once.`);
    }
    if (registry.get(name)?.reserved !== undefined) {
      throw refuse(
        `"${name}" is both a declared Markdown component and a reserved registration. Both claim ` +
          "the name rather than offering a default for it, so which one wins is not a question of " +
          "order.",
      );
    }

    const actual = sourceDigest(source);
    if (actual !== digest) {
      throw refuse(
        `the declared Markdown component "${name}" states a digest its source does not have. The ` +
          "bytes this build shipped are not the bytes it was declared with.",
      );
    }

    const definition = yield* parseMarkdownDefinition(name, origin, source);

    const forms = declaration.forms ?? BOTH_FORMS;
    const badForms = formsRefusal(forms);
    if (badForms !== undefined) {
      throw refuse(`the declared Markdown component "${name}" ${badForms}`);
    }

    if (
      declaration.props !== undefined &&
      !describesSameSchema(declaration.props, definition.props)
    ) {
      throw refuse(
        `the declared Markdown component "${name}" states a props schema its source does not ` +
          "declare. A host describes what its Markdown says; it does not say something else.",
      );
    }
    if (!describesSameReturn(declaration.returns, definition.returns)) {
      throw refuse(
        `the declared Markdown component "${name}" states a return its source does not declare. A ` +
          "host describes what its Markdown says; it does not say something else.",
      );
    }

    // The same admission a registration is held to, so a declared contract is
    // admissible on exactly the terms every other declared contract is: the
    // schemas compile here, before a document can write the name.
    yield* admitDeclaration({
      name,
      origin,
      props: definition.props,
      ...(definition.returns === undefined ? {} : { returns: definition.returns }),
      forms,
      ...documentationOf(definition.meta),
    });

    const privates = declaration.privates ?? [];
    for (const component of privates) {
      yield* admitDeclaration(component);
      if (claimed.has(component.name) || privateNames.has(component.name)) {
        throw refuse(
          `"${component.name}" is declared twice. A private name answers for one declaration, so ` +
            "two declarations of it describe an execution with no single answer.",
        );
      }
      if (registry.get(component.name) !== undefined) {
        throw refuse(
          `"${component.name}" is both a private declaration and a registration. A private name ` +
            "resolves only for the Markdown that declares it, so it may not also be a name a " +
            "document can write.",
        );
      }
      privateNames.add(component.name);
    }
    claimed.add(name);
    admitted.push({
      name,
      origin,
      source,
      digest,
      forms,
      definition,
      privates,
    });
  }

  for (const declaration of admitted) {
    if (privateNames.has(declaration.name)) {
      throw refuse(
        `"${declaration.name}" is both a declared Markdown component and a private declaration.`,
      );
    }
  }

  return admitted;
}

/** Whether two schemas describe the same thing, whatever order they wrote it in. */
function describesSameSchema(stated: PropsSchema, parsed: PropsSchema): boolean {
  return canonicalFingerprint(stated) === canonicalFingerprint(parsed);
}

function describesSameReturn(
  stated: ReturnsSchema | undefined,
  parsed: ReturnsSchema | undefined,
): boolean {
  if (stated === undefined) {
    return true;
  }
  if (parsed === undefined) {
    return false;
  }
  return describesSameSchema(stated, parsed);
}

/**
 * What one environment's declarations mean, for the paths that decide a name.
 *
 * Selection, inspection and validation all read this, so they cannot disagree
 * about which names a host declared or about what each one's contract is.
 */
export class DeclaredMarkdownCatalog {
  readonly #byName: ReadonlyMap<string, AdmittedDeclaredMarkdown>;
  readonly #privateNames: ReadonlySet<string>;

  constructor(declarations: readonly AdmittedDeclaredMarkdown[]) {
    this.#byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
    this.#privateNames = new Set(
      declarations.flatMap((declaration) =>
        declaration.privates.map((component) => component.name),
      ),
    );
  }

  /** The declaration this name resolves to, if one was declared. */
  component(name: string): AdmittedDeclaredMarkdown | undefined {
    return this.#byName.get(name);
  }

  /** Every declared name, so a catalog can ask about each of them. */
  names(): readonly string[] {
    return [...this.#byName.keys()];
  }

  /**
   * Whether this name belongs to some declaration's private closure.
   *
   * Asked by selection, which is what makes it one decision: a private name
   * written where its own declaration is not being expanded resolves to nothing,
   * and it resolves to nothing for a document being run, a name being described
   * and a document being validated alike.
   */
  isPrivate(name: string): boolean {
    return this.#privateNames.has(name);
  }
}

/** The declarations of one environment, or nothing when it declares none. */
export function declaredCatalog(
  declarations: readonly AdmittedDeclaredMarkdown[],
): DeclaredMarkdownCatalog | undefined {
  return declarations.length === 0 ? undefined : new DeclaredMarkdownCatalog(declarations);
}

/**
 * The private names one declaration's own bytes may write.
 *
 * Held by canonical core and handed to core's own expansion by value. A
 * document, a component and middleware can all name it and reach none of it.
 */
export interface PrivateClosure {
  /** Whether these bytes declare `name`. */
  has(name: string): boolean;
  /** The origin the private declaration reports, for the durable record. */
  origin(name: string): string | undefined;
}

/**
 * One private import, open for exactly one ask.
 *
 * The offer is the authority, and it is spent where it was made. What may be
 * invoked is the object canonical core's own resolver produced *inside this
 * ask* — so an answer retained from another import authorizes nothing, however
 * exactly it describes the same private component, and a name written where no
 * offer was made is not a private import at all.
 */
export interface PrivateImport {
  /**
   * Core's own copy of the definition this ask may invoke, or the refusal
   * saying why it may invoke none.
   *
   * Verified after the public chain has returned and before anything is
   * expanded or called, on the same terms a closed import is: the answer has to
   * be the object this ask produced, still describing what core produced.
   */
  authorize(answer: ImportedDefinition): ImportedDefinition;
  /** The ask is over. */
  close(): void;
}

/**
 * What a declaring execution imports through.
 *
 * Two questions, one owner. *Which* declaration a name resolves to is public —
 * inspection and validation ask it too. *Whether* a private name resolves at
 * all is not: it is offered by canonical core immediately before one import and
 * taken by canonical core's own resolver inside it, so nothing that composes in
 * between can obtain a private declaration for an element that did not author
 * it.
 *
 * The offer is taken once. A handler that delegates twice, or that imports
 * something of its own while an import is in flight, finds it already spent and
 * falls through to ordinary selection — which is the safe direction, because
 * ordinary selection does not resolve a private name at all.
 */
/** What a private import says when the answer is not this ask's own. */
const PRIVATE_REFUSED: Record<ImportRefusal, string> = {
  unissued:
    "Component.importComponent middleware answered a private import with a definition this " +
    "import did not produce. A private component runs for the element the declaration that " +
    "carries it authored, and for no other — an answer kept from another import authorizes " +
    "nothing here.",
  "another-name":
    "Component.importComponent middleware answered a private import with the definition " +
    "canonical execution produced for another component.",
  changed:
    "Component.importComponent middleware changed the private definition canonical execution " +
    "produced before it was invoked.",
};

/** The fixed diagnostic each verification failure produces. */
const REFUSED: Record<ImportRefusal, string> = {
  unissued:
    "Component.importComponent middleware answered an import with a definition canonical " +
    "execution did not produce. A handler may observe, delegate or refuse an import in an " +
    "execution that declares exact Markdown; only canonical execution answers one.",
  "another-name":
    "Component.importComponent middleware answered an import with the definition canonical " +
    "execution produced for another component.",
  changed:
    "Component.importComponent middleware changed the definition canonical execution " +
    "produced before it was invoked.",
};

export class DeclaredImports implements ImportTier {
  readonly #catalog: DeclaredMarkdownCatalog;
  readonly #privates: ReadonlyMap<string, FunctionComponentDefinition>;
  readonly #closures: ReadonlyMap<string, PrivateClosure>;
  readonly #implementations: ReadonlySet<FunctionComponentDefinition["fn"]>;
  #offered: OpenOffer | undefined;

  constructor(
    catalog: DeclaredMarkdownCatalog,
    privates: ReadonlyMap<string, FunctionComponentDefinition>,
    closures: ReadonlyMap<string, PrivateClosure>,
  ) {
    this.#catalog = catalog;
    this.#privates = privates;
    this.#closures = closures;
    // Held by identity: these are the exact functions this execution built from
    // the claimants it minted, and identity is what a copy of a definition
    // cannot change about the implementation it carries.
    this.#implementations = new Set([...privates.values()].map((definition) => definition.fn));
  }

  /** The declarations selection, inspection and validation all read. */
  get catalog(): DeclaredMarkdownCatalog {
    return this.#catalog;
  }

  /** The declaration this name resolves to, if one was declared. */
  component(name: string): AdmittedDeclaredMarkdown | undefined {
    return this.#catalog.component(name);
  }

  claims(name: string): boolean {
    return this.#catalog.component(name) !== undefined || this.#privates.has(name);
  }

  /**
   * A declaration claims the names it declares and says nothing about any
   * other, so an unrelated import composes exactly as it does in an execution
   * with no declarations at all. Closing those too would take a supported way
   * to decide what a name means away from every host that declares one asset.
   */
  readonly closesExecution = false;

  refuse(refusal: ImportRefusal): Error {
    return new DeclaredMarkdownError(REFUSED[refusal]);
  }

  /**
   * The closure the body of `imported` may write, if it is a declaration's own
   * body.
   *
   * Decided from what canonical resolution retained — the definition core
   * invokes, reporting the origin core declared — rather than from the name
   * alone. A repository file, a bundled component and a registration all report
   * a different origin, and the answer core hands expansion is core's own copy
   * rather than anything that travelled through middleware.
   */
  closureFor(name: string, imported: { kind: string; path?: string }): PrivateClosure | undefined {
    const declaration = this.#catalog.component(name);
    if (declaration === undefined || imported.kind !== "markdown") {
      return undefined;
    }
    return imported.path === declaration.origin ? this.#closures.get(name) : undefined;
  }

  /** Whether some declaration keeps this name to itself. */
  declaresPrivate(name: string): boolean {
    return this.#privates.has(name);
  }

  /**
   * Refuse an answer that carries a private implementation to an import the
   * closure did not authorize.
   *
   * The name is the wrong thing to check on its own. A handler that keeps a
   * legitimately delegated private answer can return it for any *other* name —
   * one nothing declares, which is an ordinary open import a handler is
   * supposed to be able to answer. Restricting the name alone lets the private
   * implementation run under an alias, in a copy of the definition, or after
   * the invocation that produced it is over.
   *
   * So what is restricted is the implementation. An import under a private name
   * has already been authorized by its own offer above; every other import is
   * refused when what came back is a function this execution's private closure
   * built. A definition a handler wrote itself carries a different function and
   * stays open, which is what keeps an unrelated middleware-provided component
   * exactly as answerable as it is with nothing declared.
   */
  refuseEscaped(name: string, imported: ImportedDefinition): void {
    if (this.declaresPrivate(name) || imported.kind !== "function") {
      return;
    }
    if (!this.#implementations.has(imported.fn)) {
      return;
    }
    throw new DeclaredMarkdownError(
      `${name} was answered with a component only exact declared Markdown may write. A private ` +
        "implementation runs for the element the declaration that carries it authored, and for " +
        "no other name, copy or later site.",
    );
  }

  /**
   * Offer one private import, for the duration of one ask.
   *
   * Returns the offer, or `undefined` when the segments being expanded declare
   * no such name — in which case this is not a private import, and the name
   * resolves the ordinary way, which for a private name is to nothing.
   */
  offer(closure: PrivateClosure | undefined, name: string): PrivateImport | undefined {
    if (closure === undefined || !closure.has(name)) {
      return undefined;
    }
    // One retention per ask. An answer is authorized because it is the object
    // *this* ask produced, so an answer kept from another import is not in this
    // table at all and is refused as unissued.
    const imports = new CanonicalImports();
    const open: OpenOffer = { closure, name, imports, produced: undefined };
    this.#offered = open;
    return {
      authorize: (answer) => {
        if (open.produced === undefined) {
          throw new DeclaredMarkdownError(PRIVATE_REFUSED.unissued);
        }
        return imports.authorize(
          name,
          answer,
          (refusal) => new DeclaredMarkdownError(PRIVATE_REFUSED[refusal]),
        );
      },
      close: () => {
        if (this.#offered === open) {
          this.#offered = undefined;
        }
      },
    };
  }

  /**
   * Take the offer, if this ask is the one it was made for.
   *
   * Read once: whatever asks first spends it, so a second ask inside the same
   * window resolves ordinarily and fails to find the name. What comes back is a
   * copy this ask owns rather than the shared implementation, because the offer
   * authorizes by the object it produced and two asks must not produce one.
   */
  claim(name: string): { definition: FunctionComponentDefinition; origin: string } | undefined {
    const offered = this.#offered;
    this.#offered = undefined;
    if (offered === undefined || offered.name !== name) {
      return undefined;
    }
    const minted = this.#privates.get(name);
    const origin = offered.closure.origin(name);
    if (minted === undefined || origin === undefined) {
      return undefined;
    }
    const copy = retain(minted);
    if (copy === undefined || copy.kind !== "function") {
      return undefined;
    }
    offered.produced = copy;
    offered.imports.issue(name, copy);
    return { definition: copy, origin };
  }
}

/** One offer, while the ask it was made for is still open. */
interface OpenOffer {
  readonly closure: PrivateClosure;
  readonly name: string;
  readonly imports: CanonicalImports;
  produced: FunctionComponentDefinition | undefined;
}

/**
 * The closure one declaration carries, as the names it declares and what each
 * one reports.
 */
export function privateClosure(privates: readonly IdentityComponent[]): PrivateClosure {
  const origins = new Map(privates.map((component) => [component.name, component.origin]));
  return {
    has: (name) => origins.has(name),
    origin: (name) => origins.get(name),
  };
}
