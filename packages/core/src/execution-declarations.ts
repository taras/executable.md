/**
 * What a trusted host declares to one execution, as one catalog (spec §5.3).
 *
 * A host declares two kinds of thing under one name space. **Exact Markdown**
 * is first-party bytes the host ships and names (`components/declared-markdown.ts`).
 * **Structural syntax** is a coordinated construct and the regions written
 * directly inside it — syntax the engine has no branch for, expanded by the
 * handler the same installation supplies.
 *
 * They are one list because they answer one question. Selection, inspection and
 * non-executing validation all read the catalog built here, so none of them can
 * decide that a name is declared when another decides it is not, or describe a
 * contract a run would expand differently.
 *
 * ## The discriminant is read, never assumed
 *
 * Every declaration states its `kind`, and a value that states neither arm is
 * refused rather than read as Markdown — by capture, before any other member of
 * the value is read and before any `install()` runs, and again here for the
 * callers that have no execution. The refusal keeps the error and the sentence
 * exact Markdown already had, because a value that never said what it is has
 * not said it is structural syntax either.
 *
 * ## One error for the catalog, one for the bytes
 *
 * Everything this module decides about a *set* — a malformed structural member,
 * a schema that will not compile, a name claimed twice, a pair that cannot
 * expand — is an `ExecutionDeclarationError`. What exact Markdown's own bytes
 * say about themselves stays `DeclaredMarkdownError`, and so does an unknown
 * discriminant, which is a value that never reached either arm. A host reading
 * one of those two knows which question it failed.
 *
 * ## The pair is derived from the regions
 *
 * A structural declaration states its own `parent` and nothing about its
 * regions: `null` declares a construct, and a name declares a direct region of
 * that construct in the same installation. What a construct accepts is derived
 * from the regions that named it, so the accepted regions and the declarations
 * describing them are one fact rather than two lists that can drift.
 *
 * ## What crosses to the handler
 *
 * Nothing here calls a handler. The declarations are admitted, the handler an
 * installation supplied is retained beside them, and the entry that holds it is
 * reachable only by holding this catalog. There is no registry, registrar,
 * plugin object, contextual slot, token or claim.
 */

import type { Operation, Stream } from "effection";

import {
  admitDeclaredMarkdown,
  declaredCatalog,
  DeclaredMarkdownError,
} from "./components/declared-markdown.ts";
import type {
  AdmittedDeclaredMarkdown,
  DeclaredMarkdownCatalog,
  MarkdownComponent,
} from "./components/declared-markdown.ts";
import { admitDeclaration, isComponentName } from "./components/registration.ts";
import { PROTECTED_COMPONENT_NAMES, protectedNameRefusal } from "./components/protected.ts";
import { RESERVED_STRUCTURAL } from "./structural.ts";
import { formsRefusal } from "./invocation-identity.ts";
import { isBlankText } from "./structural-rules.ts";
import type { StructuralViolation } from "./structural-rules.ts";
import type {
  ComponentElement,
  ComponentRegistry,
  InvocationForm,
  Json,
  PropsSchema,
  Segment,
  SourcePosition,
} from "./types.ts";

/**
 * A declaration set that cannot be installed.
 *
 * Thrown where the declarations are admitted — before the root document is read
 * and before any authored content runs — because a set that describes no single
 * environment is the host's error rather than the document's.
 *
 * Exact Markdown keeps its own error: what a declaration's own bytes say about
 * themselves was already this repository's answer, and this is about the
 * catalog those declarations form together.
 */
export class ExecutionDeclarationError extends Error {
  override name = "ExecutionDeclarationError";
}

/**
 * One structural construct a host declares, and its place in the pair.
 *
 * `forms` and `props` are the executable contract: the authored forms this name
 * accepts, and the schema its props are validated against. `syntax`,
 * `description` and `context` are documentation — inspection prints them and no
 * run reads them.
 *
 * `context` is decided rather than omitted, exactly as the engine's own table
 * decides it: `null` states that the construct reads no content, so a missing
 * sentence is a fact about the construct instead of an unfinished entry.
 */
export interface StructuralDeclaration {
  readonly kind: "structural";
  /** The name a document writes. */
  readonly name: string;
  /** Stable, human-readable source identity — reported by inspection. */
  readonly origin: string;
  /** The forms this construct accepts. */
  readonly forms: readonly InvocationForm[];
  readonly props: PropsSchema;
  /** The canonical authored forms, as documentation a reader copies. */
  readonly syntax: readonly string[];
  readonly description: string;
  /** What the construct's content means, or `null` when it reads none. */
  readonly context: string | null;
  /** `null` for a construct; the construct's name for a direct region of one. */
  readonly parent: string | null;
}

/** Everything one installation declares, under one discriminant. */
export type ExecutionDeclaration = MarkdownComponent | StructuralDeclaration;

/** One piece of a region's rendered output. */
export interface ExpansionChunk {
  readonly text: string;
  /**
   * Whether this text is a program's source rather than presentation, as the
   * enclosing execution already decides it for its own output.
   */
  readonly exact: boolean;
}

/**
 * One accepted direct region of a structural occurrence, as its handler sees it.
 *
 * `expand()` is the only operational member. Everything else is an authored
 * fact about where the region was written.
 */
export interface ExpansionRegion {
  readonly name: string;
  readonly origin: string;
  readonly form: InvocationForm;
  readonly position?: Readonly<SourcePosition>;
  readonly props: Readonly<Record<string, Json>>;
  expand(): Operation<Stream<ExpansionChunk, void>>;
}

/** One structural occurrence, as the installation that declared it sees it. */
export interface ExpansionRequest {
  readonly name: string;
  readonly origin: string;
  readonly form: InvocationForm;
  readonly position?: Readonly<SourcePosition>;
  readonly props: Readonly<Record<string, Json>>;
  /** The accepted direct regions, in the order they were authored. */
  readonly regions: readonly ExpansionRegion[];
}

/**
 * How an installation expands the structural syntax it declared.
 *
 * Captured by value with the declarations it belongs to, before any `install()`
 * runs, and held on the admitted entry. It is published nowhere, so a handler
 * is reachable only by the execution that captured it.
 */
export type ExpansionHandler = (request: ExpansionRequest) => Operation<void>;

/** What one installation contributed, read once at capture. */
export interface RetainedInstallation {
  readonly declarations: readonly ExecutionDeclaration[];
  readonly expand?: ExpansionHandler;
}

/**
 * One structural declaration, admitted: what the host stated, plus what the set
 * it was declared in decided about it.
 *
 * `children` is derived from the regions that named this construct rather than
 * restated by it, so the accepted regions and the declarations describing them
 * are one fact. A region's own `children` is empty: a region is never a parent.
 */
export interface AdmittedStructural {
  readonly name: string;
  readonly origin: string;
  readonly forms: readonly InvocationForm[];
  readonly props: PropsSchema;
  readonly syntax: readonly string[];
  readonly description: string;
  readonly context: string | null;
  readonly parent: string | null;
  /** The direct regions this construct accepts, in declaration order. */
  readonly children: readonly string[];
  /**
   * The handler the declaring installation supplied.
   *
   * Absent wherever no execution exists: inspection and validation describe the
   * same declarations without one, and neither has anything to call.
   */
  readonly expand?: ExpansionHandler;
}

/**
 * What one environment's declarations mean, for the paths that decide a name.
 *
 * It wraps the declared-Markdown catalog rather than replacing it — exact
 * Markdown answers exactly as it always has — and adds the structural names
 * beside it. Selection, inspection and validation read this one object, which
 * is what stops them disagreeing about which names a host declared.
 */
export class ExecutionDeclarationCatalog {
  readonly #markdown: DeclaredMarkdownCatalog | undefined;
  readonly #admitted: readonly AdmittedDeclaredMarkdown[];
  readonly #structural: ReadonlyMap<string, AdmittedStructural>;

  constructor(
    markdown: readonly AdmittedDeclaredMarkdown[],
    structural: readonly AdmittedStructural[],
  ) {
    this.#admitted = markdown;
    this.#markdown = declaredCatalog(markdown);
    this.#structural = new Map(structural.map((declaration) => [declaration.name, declaration]));
  }

  /** The declared Markdown this name resolves to, if one was declared. */
  component(name: string): AdmittedDeclaredMarkdown | undefined {
    return this.#markdown?.component(name);
  }

  /** The declared structural syntax this name resolves to, if any. */
  structural(name: string): AdmittedStructural | undefined {
    return this.#structural.get(name);
  }

  /** Every declared name, so a catalog can ask about each of them. */
  names(): readonly string[] {
    return [...(this.#markdown?.names() ?? []), ...this.#structural.keys()];
  }

  /** Whether this name belongs to some declaration's private closure. */
  isPrivate(name: string): boolean {
    return this.#markdown?.isPrivate(name) === true;
  }

  /**
   * The admitted Markdown, for the execution that builds its private closures
   * from the same admissions rather than from a second parse of the same bytes.
   */
  markdown(): readonly AdmittedDeclaredMarkdown[] {
    return this.#admitted;
  }

  /**
   * The declared-Markdown catalog this one wraps, for the import tier that
   * closes those names. Absent when the host declared no Markdown at all, which
   * is a host with nothing for that tier to close.
   */
  markdownCatalog(): DeclaredMarkdownCatalog | undefined {
    return this.#markdown;
  }
}

function refuse(message: string): ExecutionDeclarationError {
  return new ExecutionDeclarationError(message);
}

/**
 * What a value that states neither arm is refused with.
 *
 * PR A settled this sentence for exact Markdown, and it is still the right one:
 * a value that never said what it is has not said it is structural syntax
 * either. It is spelled here as well as in the Markdown admission because
 * *capture* refuses before that admission is reached, and capture may read the
 * discriminant only once — delegating would read it a second time. `ED1` holds
 * the two spellings against each other, so they cannot drift apart silently.
 */
const UNKNOWN_KIND =
  "a declaration was handed to one execution without saying it is exact Markdown. A host " +
  "declares exact Markdown with `Markdown({…})`, and a declaration that states something " +
  "else, or nothing, is never read as Markdown.";

/**
 * Refuse a discriminant this version does not know.
 *
 * Takes the value already read rather than the declaration, because the one
 * caller that matters reads `kind` exactly once and must not read it again to
 * decide what to say about it.
 */
export function refuseUnknownKind(): DeclaredMarkdownError {
  return new DeclaredMarkdownError(UNKNOWN_KIND);
}

/** Whether this discriminant names an arm of the catalog. */
export function isKnownKind(kind: unknown): kind is ExecutionDeclaration["kind"] {
  return kind === "markdown" || kind === "structural";
}

/**
 * Run one declaration's shared admission, and answer for it as this catalog.
 *
 * The rule stays where it is — a name, a schema and a forms array are admitted
 * on exactly the terms every registration is — and only the *kind* of failure
 * is restated: a host assembling a declaration set gets one error class for
 * "this set is not installable", with the underlying sentence intact and the
 * original failure kept as its cause.
 */
function* admitting(name: string, admission: () => Operation<void>): Operation<void> {
  try {
    yield* admission();
  } catch (error) {
    if (error instanceof ExecutionDeclarationError) {
      throw error;
    }
    const stated = error instanceof Error ? error.message : String(error);
    throw new ExecutionDeclarationError(
      `the declared structural construct "${name}" states a contract this execution cannot ` +
        `install: ${stated}`,
      { cause: error },
    );
  }
}

/**
 * Admit what a host would declare, for a caller that runs none of it.
 *
 * Inspection and validation describe the environment a run would have, so they
 * admit the same declarations on the same terms — every intrinsic, conflict and
 * relationship rule. What they cannot ask about is the handler: there is no
 * installation here to have supplied one, and nothing to call it with.
 */
export function* admitExecutionDeclarations(
  declarations: readonly ExecutionDeclaration[],
  registry: ComponentRegistry,
): Operation<ExecutionDeclarationCatalog | undefined> {
  return yield* admit([{ declarations }], registry, false);
}

/**
 * Admit what this execution's installations declared, with the handlers they
 * supplied.
 *
 * An installation that declares structural syntax supplies exactly one handler
 * for it, and an installation that supplies one declares structural syntax.
 * Either half alone describes an execution that could admit syntax it can never
 * expand, so it is refused here — before the root document is read.
 */
export function* admitInstalledDeclarations(
  installations: readonly RetainedInstallation[],
  registry: ComponentRegistry,
): Operation<ExecutionDeclarationCatalog | undefined> {
  return yield* admit(installations, registry, true);
}

/**
 * Everything both callers do, in the order a refusal is most useful in.
 *
 * Each arm is checked on its own terms first — the Markdown arm by the checks
 * it has always been held to, in their order and with their wording — and the
 * questions only a whole set can answer come afterwards.
 */
function* admit(
  installations: readonly RetainedInstallation[],
  registry: ComponentRegistry,
  /** Whether the caller is an execution, and so has handlers to be held to. */
  installed: boolean,
): Operation<ExecutionDeclarationCatalog | undefined> {
  const structural: OwnedStructural[] = [];
  const markdown: MarkdownComponent[] = [];

  for (const [installation, contributed] of installations.entries()) {
    for (const declaration of contributed.declarations) {
      if (declaration.kind === "structural") {
        structural.push({ declaration, installation });
        continue;
      }
      // Everything else, including a value that states no kind this version
      // knows. The Markdown admission below reads the discriminant before any
      // other member, so a value this catalog cannot place is refused there —
      // in capture order, and in the words that refusal already had.
      markdown.push(declaration);
    }
  }

  if (markdown.length === 0 && structural.length === 0) {
    return undefined;
  }

  const admittedMarkdown = yield* admitDeclaredMarkdown(markdown, registry);
  const admittedStructural = yield* admitStructural(structural, registry, admittedMarkdown);

  if (installed) {
    for (const [ordinal, installation] of installations.entries()) {
      const declares = structural.some((owned) => owned.installation === ordinal);
      if (declares && installation.expand === undefined) {
        throw refuse(
          "an installation declared structural syntax and supplied no expansion handler. The " +
            "installation that names a construct is the one that expands it, so a declaration " +
            "without a handler is syntax this execution could admit and never expand.",
        );
      }
      if (!declares && installation.expand !== undefined) {
        throw refuse(
          "an installation supplied a structural expansion handler and declared no structural " +
            "syntax. A handler expands the constructs its own installation declared, so one " +
            "with no declarations answers for nothing a document can write.",
        );
      }
    }
  }

  return new ExecutionDeclarationCatalog(
    admittedMarkdown,
    admittedStructural.map(({ entry, installation }) => {
      const expand = installations[installation]?.expand;
      return expand === undefined ? entry : { ...entry, expand };
    }),
  );
}

/** One structural declaration and the installation that contributed it. */
interface OwnedStructural {
  readonly declaration: StructuralDeclaration;
  readonly installation: number;
}

/** An admitted structural declaration, still carrying its owner. */
interface OwnedAdmission {
  readonly installation: number;
  readonly entry: AdmittedStructural;
}

function* admitStructural(
  declarations: readonly OwnedStructural[],
  registry: ComponentRegistry,
  markdown: readonly AdmittedDeclaredMarkdown[],
): Operation<readonly OwnedAdmission[]> {
  const claimed = new Set<string>();
  const declaredMarkdownNames = new Set(markdown.map((declaration) => declaration.name));
  const privateNames = new Set(
    markdown.flatMap((declaration) => declaration.privates.map((component) => component.name)),
  );

  for (const { declaration } of declarations) {
    const { name, origin, forms, props, syntax, description, context, parent } = declaration;

    // The name is printed only once it has passed the grammar a document
    // writes: until then it is text of unknown provenance, and a refusal is not
    // a reason to publish it.
    if (typeof name !== "string" || !isComponentName(name)) {
      throw refuse(
        "a declared structural construct was given a name that is not a component name.",
      );
    }
    if (RESERVED_STRUCTURAL.has(name)) {
      throw refuse(
        `a declared structural construct was named "${name}", which is structural syntax the ` +
          "engine owns rather than syntax an installation declares.",
      );
    }
    if (PROTECTED_COMPONENT_NAMES.has(name)) {
      throw refuse(`a host ${protectedNameRefusal(name, "declare as structural syntax")}.`);
    }
    if (typeof origin !== "string" || origin.length === 0) {
      throw refuse(
        `the declared structural construct "${name}" needs an origin naming where it came from.`,
      );
    }
    if (claimed.has(name)) {
      throw refuse(
        `"${name}" was declared as structural syntax twice. One execution declares a name once.`,
      );
    }
    if (declaredMarkdownNames.has(name)) {
      throw refuse(
        `"${name}" is declared as both structural syntax and Markdown. One execution declares a ` +
          "name once, so which one a document writes is never a question of order.",
      );
    }
    if (privateNames.has(name)) {
      throw refuse(
        `"${name}" is both declared structural syntax and a private declaration. A private name ` +
          "resolves only for the Markdown that declares it, so it may not also be a name a " +
          "document can write.",
      );
    }
    if (registry.get(name)?.reserved !== undefined) {
      throw refuse(
        `"${name}" is both declared structural syntax and a reserved registration. Both claim ` +
          "the name rather than offering a default for it, so which one wins is not a question " +
          "of order.",
      );
    }
    // Present, unlike a Markdown declaration's: omission means "both" there,
    // and a construct that arranges what is written inside it states which
    // spellings it accepts rather than inheriting a default.
    if (!Array.isArray(forms)) {
      throw refuse(
        `the declared structural construct "${name}" states no forms. A construct states the ` +
          "authored spellings it accepts.",
      );
    }
    const badForms = formsRefusal(forms);
    if (badForms !== undefined) {
      throw refuse(`the declared structural construct "${name}" ${badForms}.`);
    }
    if (
      !Array.isArray(syntax) ||
      syntax.length === 0 ||
      syntax.some((example) => typeof example !== "string" || example.length === 0)
    ) {
      throw refuse(
        `the declared structural construct "${name}" needs the authored forms a reader copies.`,
      );
    }
    if (typeof description !== "string" || description.length === 0) {
      throw refuse(
        `the declared structural construct "${name}" needs a description saying what it is for.`,
      );
    }
    if (context !== null && (typeof context !== "string" || context.length === 0)) {
      throw refuse(
        `the declared structural construct "${name}" states a context that is neither prose nor ` +
          "null. A construct decides whether its content means something rather than leaving it " +
          "unsaid.",
      );
    }
    if (parent !== null && !isComponentName(parent)) {
      throw refuse(
        `the declared structural construct "${name}" names a parent that is not a component name.`,
      );
    }

    // The same admission a registration is held to, so a declared contract is
    // admissible on exactly the terms every other declared contract is: the
    // schema compiles here, before a document can write the name.
    //
    // What comes back out is this catalog's error, not registration's. The rule
    // is registration's and stays there — a schema this build cannot compile is
    // refused for exactly the reason it always was — but a host assembling a
    // declaration set is owed one answer to "is this set installable", and a
    // registration error escaping from here would be a second one.
    yield* admitting(name, function* () {
      yield* admitDeclaration({
        name,
        origin,
        props,
        forms,
        description,
        ...(context === null ? {} : { context }),
      });
    });

    claimed.add(name);
  }

  return relate(declarations);
}

/**
 * The pair each declaration belongs to, derived from the declarations
 * themselves.
 *
 * A region names its construct; a construct's accepted regions are whichever
 * declarations named it. Both halves belong to one installation: an
 * installation expands what it declared, and a pair split across two of them
 * would be a construct whose regions belong to somebody else's handler.
 */
function relate(declarations: readonly OwnedStructural[]): readonly OwnedAdmission[] {
  const declared = new Map(declarations.map((owned) => [owned.declaration.name, owned]));
  const children = new Map<string, string[]>();

  for (const { declaration, installation } of declarations) {
    const parent = declaration.parent;
    if (parent === null) {
      continue;
    }
    const named = declared.get(parent);
    if (named === undefined) {
      throw refuse(
        `the declared structural construct "${declaration.name}" is a region of "${parent}", ` +
          "which this execution does not declare. A region belongs to a construct, and a " +
          "construct that is not declared cannot hold one.",
      );
    }
    if (named.installation !== installation) {
      throw refuse(
        `the declared structural construct "${declaration.name}" is a region of "${parent}", ` +
          "which another installation declared. The installation that declares a construct is " +
          "the one that expands its regions.",
      );
    }
    if (named.declaration.parent !== null) {
      throw refuse(
        `the declared structural construct "${declaration.name}" is a region of "${parent}", ` +
          "which is itself a region. A region is written directly inside the construct that " +
          "declares it, so the constructs hold one level of regions rather than a tree.",
      );
    }
    children.set(parent, [...(children.get(parent) ?? []), declaration.name]);
  }

  for (const { declaration } of declarations) {
    if (declaration.parent === null && (children.get(declaration.name) ?? []).length === 0) {
      throw refuse(
        `the declared structural construct "${declaration.name}" declares no region. A ` +
          "structural construct arranges the regions written inside it, so one with none is an " +
          "ordinary component rather than structural syntax.",
      );
    }
  }

  return declarations.map(({ declaration, installation }) => ({
    installation,
    entry: {
      name: declaration.name,
      origin: declaration.origin,
      forms: [...declaration.forms],
      props: declaration.props,
      syntax: [...declaration.syntax],
      description: declaration.description,
      context: declaration.context,
      parent: declaration.parent,
      children: [...(children.get(declaration.name) ?? [])],
    },
  }));
}

/** A declared construct's place in its pair, as both readers state it. */
export interface StructuralRelationship {
  /** `null` for a construct; the construct's name for one of its regions. */
  readonly parent: string | null;
  /** The direct regions a construct accepts, in declaration order. */
  readonly children: readonly string[];
}

/** What one occurrence's placement decided: its violations and its regions. */
export interface StructuralPlacement {
  readonly violations: readonly StructuralViolation[];
  /** The accepted direct regions, in the order they were authored. */
  readonly regions: readonly ComponentElement[];
}

/**
 * Where a declared structural construct may be written, decided from source
 * alone.
 *
 * Both non-executing validation and canonical expansion read this, so a
 * placement one of them accepts is a placement the other accepts. It evaluates
 * nothing: which regions an occurrence holds, and where a region was written,
 * are facts about the authored text.
 *
 * The construct's own name is the element's, because selection already decided
 * that this element is this declaration.
 */
export function structuralPlacement(
  segment: ComponentElement,
  declaration: StructuralRelationship,
  /** The construct this element is written directly inside, if any. */
  enclosing: string | undefined,
): StructuralPlacement {
  return declaration.parent === null
    ? constructPlacement(segment, declaration.children)
    : regionPlacement(segment.name, declaration.parent, enclosing);
}

function constructPlacement(
  segment: ComponentElement,
  children: readonly string[],
): StructuralPlacement {
  const violations: StructuralViolation[] = [];
  const regions: ComponentElement[] = [];
  const accepted = new Set(children);

  for (const child of segment.children) {
    if (isBlankText(child)) {
      continue;
    }
    if (child.type === "component" && accepted.has(child.name)) {
      regions.push(child);
      continue;
    }
    violations.push({
      code: "structural-usage-invalid",
      source: segment.name,
      message:
        `<${segment.name}> holds only the regions it declares: ` +
        `${children.map((name) => `<${name}>`).join(", ")}. Found ${describe(child)} directly ` +
        "inside it.",
      ...(child.type === "component" ? { element: child } : {}),
    });
  }

  return { violations, regions };
}

function regionPlacement(
  name: string,
  parent: string,
  enclosing: string | undefined,
): StructuralPlacement {
  if (enclosing === parent) {
    return { violations: [], regions: [] };
  }
  return {
    violations: [
      {
        code: "structural-usage-invalid",
        source: name,
        message:
          `<${name}> is a region of <${parent}>, so it is written directly inside one. It is an ` +
          "error anywhere else.",
      },
    ],
    regions: [],
  };
}

/** What a segment is, for a sentence about where it was written. */
function describe(segment: Segment): string {
  if (segment.type === "component") {
    return `<${segment.name}>`;
  }
  if (segment.type === "codeBlock") {
    return `a \`${segment.language}\` code block`;
  }
  if (segment.type === "execOutput") {
    return "command output";
  }
  if (segment.type === "error") {
    return "an error";
  }
  const text = segment.content.trim().replace(/\s+/g, " ");
  return `text "${text.length > 30 ? `${text.slice(0, 30)}…` : text}"`;
}
