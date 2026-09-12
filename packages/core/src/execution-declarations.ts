/**
 * What a trusted host declares to one execution (spec §5.3).
 *
 * One discriminated catalog carries both kinds of declaration an installation
 * may contribute. `kind: "markdown"` is the exact Markdown tier
 * `components/declared-markdown.ts` admits and runs. `kind: "structural"` is
 * installed syntax: a parent form that decides how its own direct children are
 * partitioned, and the child forms that are meaningful only beneath it.
 *
 * A structural declaration is data. It carries no implementation, scope, raw
 * AST, capture, return, private component, durable identity or provider — the
 * one `ExecutionInstallation` that declares it also supplies the `expand` that
 * implements it, so a profile cannot describe a form differently from the form
 * execution selects.
 */

import type { Operation } from "effection";

import { formsRefusal } from "./invocation-identity.ts";
import type { IdentityComponent } from "./invocation-identity.ts";
import { isComponentName } from "./components/registration.ts";
import { PROTECTED_COMPONENT_NAMES, protectedNameRefusal } from "./components/protected.ts";
import { RESERVED_STRUCTURAL } from "./structural.ts";
import { compilePropsSchema, SchemaValidationError, validateProps } from "./validate.ts";
import type { NormalizedIssue } from "./validate.ts";
import type { StructuralExpander } from "./expansion-request.ts";
import type { InvocationForm, Json, PropsSchema, ReturnsSchema } from "./types.ts";

/**
 * One exact Markdown component, as the host declares it.
 *
 * `source` is the authority on the contract. `props`, `returns` and `forms` are
 * optional statements *about* it — a host that states one is held to it, so a
 * packaged asset and the host that ships it cannot drift apart silently.
 */
export interface MarkdownDeclaration {
  readonly kind: "markdown";
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
  /** Whether what this component renders is exact bytes rather than prose. */
  readonly exact?: boolean;
}

/**
 * Where one installed structural form may be written.
 *
 * A parent states how few children it accepts and whether another occurrence of
 * itself may appear anywhere below it. A child names the parent it belongs to,
 * and that parent is declared by the same installation.
 */
export type StructuralPlacement =
  | {
      readonly kind: "parent";
      /** The fewest accepted direct children. A non-negative safe integer. */
      readonly minimumChildren: number;
      readonly nested: "allowed" | "forbidden";
    }
  | {
      readonly kind: "child";
      readonly parent: string;
    };

/**
 * The wording one installed form gives its own refusals.
 *
 * Inert templates rather than callbacks: core decides *whether* a document is
 * wrong, positions the failure and raises it, and a package decides only how
 * that sentence reads. A template core has no substitution for is refused at
 * admission rather than reaching a reader with a brace in it.
 */
export interface StructuralDiagnostics {
  readonly selfClosingParent?: string;
  readonly minimumChildren?: string;
  /** Carries exactly one `{found}`: the prop name the declaration does not take. */
  readonly unknownProp?: string;
  /** Carries exactly one `{found}`: what was written where a child belongs. */
  readonly unexpectedChild?: string;
  readonly nestedParent?: string;
  readonly misplacedChild?: string;
  readonly props?: Readonly<
    Record<
      string,
      {
        readonly missing?: string;
        /** May carry `{kind}`: the JSON kind the value turned out to be. */
        readonly invalidType?: string;
        /** May carry `{value}`: the rejected value, as JSON. */
        readonly invalidValue?: string;
      }
    >
  >;
}

/** One installed structural form, as the host declares it. */
export interface StructuralDeclaration {
  readonly kind: "structural";
  readonly name: string;
  readonly origin: string;
  readonly forms: readonly InvocationForm[];
  readonly props: PropsSchema;
  /** The canonical authored forms, as documentation a reader copies. */
  readonly syntax: readonly string[];
  readonly description: string;
  /** What the form's content means, or `null` when it reads none. */
  readonly context: string | null;
  readonly placement: StructuralPlacement;
  readonly diagnostics?: StructuralDiagnostics;
}

/** Everything one installation declares, in the order it declared it. */
export type ExecutionDeclaration = MarkdownDeclaration | StructuralDeclaration;

/** A catalog that cannot be installed. Thrown before authored content runs. */
export class ExecutionDeclarationError extends Error {
  override name = "ExecutionDeclarationError";
}

function refuse(message: string): ExecutionDeclarationError {
  return new ExecutionDeclarationError(message);
}

/** One admitted structural form, and which installation owns it. */
export interface AdmittedStructural {
  readonly declaration: StructuralDeclaration;
  /** The captured installation that declared it and implements it. */
  readonly owner: number;
  /**
   * For a parent, the names of the accepted direct children, in the order that
   * same installation declared them. Empty for a child.
   */
  readonly children: readonly string[];
}

/**
 * What one environment's structural declarations mean, for the paths that
 * decide a name.
 *
 * Selection, inspection, validation and execution all read this, so they cannot
 * disagree about which forms a host installed or what each one accepts.
 */
export class StructuralCatalog {
  readonly #byName: ReadonlyMap<string, AdmittedStructural>;

  constructor(entries: readonly AdmittedStructural[]) {
    this.#byName = new Map(entries.map((entry) => [entry.declaration.name, entry]));
  }

  entry(name: string): AdmittedStructural | undefined {
    return this.#byName.get(name);
  }

  /** Every installed structural name, in captured declaration order. */
  names(): readonly string[] {
    return [...this.#byName.keys()];
  }

  entries(): readonly AdmittedStructural[] {
    return [...this.#byName.values()];
  }
}

/** The structural forms of one environment, or nothing when it installs none. */
export function structuralCatalog(
  entries: readonly AdmittedStructural[],
): StructuralCatalog | undefined {
  return entries.length === 0 ? undefined : new StructuralCatalog(entries);
}

export function isMarkdownDeclaration(
  declaration: ExecutionDeclaration,
): declaration is MarkdownDeclaration {
  return declaration.kind === "markdown";
}

export function isStructuralDeclaration(
  declaration: ExecutionDeclaration,
): declaration is StructuralDeclaration {
  return declaration.kind === "structural";
}

/** The declarations of one kind, in the order the catalog wrote them. */
export function markdownDeclarations(
  declarations: readonly ExecutionDeclaration[],
): readonly MarkdownDeclaration[] {
  return declarations.filter(isMarkdownDeclaration);
}

export function structuralDeclarations(
  declarations: readonly ExecutionDeclaration[],
): readonly StructuralDeclaration[] {
  return declarations.filter(isStructuralDeclaration);
}

/**
 * What core reads as a substitution.
 *
 * A brace group spelled like a name: `{found}` is a placeholder, and the
 * `{2}` in a template that quotes `<Panel columns={2}>` is the syntax the
 * sentence is about. So a declaration may show an author what to write, and
 * a placeholder core cannot fill is still refused rather than reaching a reader
 * with a brace in it.
 */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function placeholderRefusal(
  field: string,
  template: string,
  allowed: string | undefined,
  required: boolean,
): string | undefined {
  const found: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    found.push(match[1] ?? "");
  }
  for (const name of found) {
    if (name !== allowed) {
      return `${field} carries "{${name}}", which core has no substitution for`;
    }
  }
  if (required && found.length !== 1) {
    return `${field} carries ${found.length} "{${allowed}}" placeholders rather than exactly one`;
  }
  return undefined;
}

function assertTemplate(
  name: string,
  field: string,
  template: string | undefined,
  allowed: string | undefined,
  required: boolean,
): void {
  if (template === undefined) {
    return;
  }
  if (template.length === 0) {
    throw refuse(`the structural declaration "${name}" states an empty ${field} template.`);
  }
  const bad = placeholderRefusal(field, template, allowed, required);
  if (bad !== undefined) {
    throw refuse(`the structural declaration "${name}" ${bad}.`);
  }
}

function assertDiagnostics(name: string, diagnostics: StructuralDiagnostics | undefined): void {
  if (diagnostics === undefined) {
    return;
  }
  assertTemplate(name, "selfClosingParent", diagnostics.selfClosingParent, undefined, false);
  assertTemplate(name, "minimumChildren", diagnostics.minimumChildren, undefined, false);
  assertTemplate(name, "unknownProp", diagnostics.unknownProp, "found", true);
  assertTemplate(name, "unexpectedChild", diagnostics.unexpectedChild, "found", true);
  assertTemplate(name, "nestedParent", diagnostics.nestedParent, undefined, false);
  assertTemplate(name, "misplacedChild", diagnostics.misplacedChild, undefined, false);
  if (diagnostics.props === undefined) {
    return;
  }
  for (const [prop, templates] of Object.entries(diagnostics.props)) {
    assertTemplate(name, `props.${prop}.missing`, templates.missing, undefined, false);
    assertTemplate(name, `props.${prop}.invalidType`, templates.invalidType, "kind", false);
    assertTemplate(name, `props.${prop}.invalidValue`, templates.invalidValue, "value", false);
  }
}

function assertPlacement(name: string, placement: StructuralPlacement): void {
  if (placement.kind === "parent") {
    const minimum = placement.minimumChildren;
    if (!Number.isSafeInteger(minimum) || minimum < 0) {
      throw refuse(
        `the structural parent "${name}" states a minimumChildren that is not a non-negative ` +
          "safe integer.",
      );
    }
    if (placement.nested !== "allowed" && placement.nested !== "forbidden") {
      throw refuse(
        `the structural parent "${name}" states a nested rule that is neither "allowed" nor ` +
          '"forbidden".',
      );
    }
    return;
  }
  if (!isComponentName(placement.parent)) {
    throw refuse(`the structural child "${name}" names a parent that is not a component name.`);
  }
}

/**
 * A structural declaration this execution owns, copied out of the object the
 * host handed over.
 *
 * The schema is a whole object graph rather than a value, so copying the
 * reference copies nothing: an installation hook still holding the caller's
 * object could otherwise change the contract validation compiles and expansion
 * checks every occurrence against.
 */
function detachStructural(declaration: StructuralDeclaration): StructuralDeclaration {
  const placement = declaration.placement;
  return Object.freeze({
    kind: "structural" as const,
    name: declaration.name,
    origin: declaration.origin,
    forms: Object.freeze([...declaration.forms]),
    props: structuredClone(declaration.props),
    syntax: Object.freeze([...declaration.syntax]),
    description: declaration.description,
    context: declaration.context,
    placement: Object.freeze(
      placement.kind === "parent"
        ? {
            kind: "parent" as const,
            minimumChildren: placement.minimumChildren,
            nested: placement.nested,
          }
        : { kind: "child" as const, parent: placement.parent },
    ),
    ...(declaration.diagnostics === undefined
      ? {}
      : { diagnostics: structuredClone(declaration.diagnostics) }),
  });
}

/** What one installation contributed, kept with the installation that owns it. */
export interface OwnedDeclarations {
  readonly owner: number;
  readonly declarations: readonly ExecutionDeclaration[];
  /** Whether this installation supplies the `expand` its structural forms need. */
  readonly expands: boolean;
  /** That implementation, bound at capture. Absent when it supplies none. */
  readonly expand?: StructuralExpander;
}

/**
 * Admit the structural half of every installation's catalog.
 *
 * Atomic: a failure in one structural declaration refuses that installation's
 * entire catalog, so no subset of it becomes visible. The checks are on the
 * declarations alone — no hook is called and no implementation is reached — so
 * this is usable where there is no execution, which is what lets `xmd syntax`
 * and document validation describe the environment a run would have.
 */
export function* admitStructuralDeclarations(
  owned: readonly OwnedDeclarations[],
): Operation<readonly AdmittedStructural[]> {
  const admitted: AdmittedStructural[] = [];
  const claimed = new Map<string, number>();

  for (const { owner, declarations, expands } of owned) {
    const structural = structuralDeclarations(declarations);
    if (structural.length === 0) {
      if (expands) {
        throw refuse(
          "an installation supplies a structural expand() without declaring a structural form. " +
            "One installation owns both, so an implementation nothing selects is refused rather " +
            "than installed.",
        );
      }
      continue;
    }
    if (!expands) {
      throw refuse(
        `the installation declaring "${structural[0]?.name}" supplies no structural expand(). ` +
          "One installation owns a structural form and its implementation together.",
      );
    }

    for (const declaration of structural) {
      const { name, origin } = declaration;
      if (!isComponentName(name)) {
        throw refuse("a structural declaration was given a name that is not a component name.");
      }
      if (RESERVED_STRUCTURAL.has(name)) {
        throw refuse(
          `a structural declaration was named "${name}", which is protected engine syntax ` +
            "rather than a form a host installs.",
        );
      }
      if (PROTECTED_COMPONENT_NAMES.has(name)) {
        throw refuse(`a host ${protectedNameRefusal(name, "declare as structural syntax")}.`);
      }
      if (origin.length === 0) {
        throw refuse(
          `the structural declaration "${name}" needs an origin naming where it came from.`,
        );
      }
      if (claimed.has(name)) {
        throw refuse(
          `"${name}" was declared twice. One execution declares a name once, so which ` +
            "declaration wins is never a question of installation order.",
        );
      }
      const badForms = formsRefusal(declaration.forms);
      if (badForms !== undefined) {
        throw refuse(`the structural declaration "${name}" ${badForms}.`);
      }
      if (declaration.syntax.length === 0) {
        throw refuse(
          `the structural declaration "${name}" states no syntax, so nothing describes how it ` +
            "is written.",
        );
      }
      if (declaration.description.length === 0) {
        throw refuse(`the structural declaration "${name}" states no description.`);
      }
      yield* compilePropsSchema(declaration.props);
      assertPlacement(name, declaration.placement);
      assertDiagnostics(name, declaration.diagnostics);
      claimed.set(name, owner);
    }

    const parents = new Set(
      structural
        .filter((declaration) => declaration.placement.kind === "parent")
        .map((declaration) => declaration.name),
    );
    for (const declaration of structural) {
      const placement = declaration.placement;
      if (placement.kind !== "child") {
        continue;
      }
      if (!parents.has(placement.parent)) {
        throw refuse(
          `the structural child "${declaration.name}" names the parent ` +
            `"${placement.parent}", which the installation declaring it does not declare. A ` +
            "child form is meaningful only beneath a parent its own installation owns.",
        );
      }
    }
    for (const declaration of structural) {
      if (declaration.placement.kind !== "parent") {
        continue;
      }
      const children = structural
        .filter(
          (candidate) =>
            candidate.placement.kind === "child" && candidate.placement.parent === declaration.name,
        )
        .map((candidate) => candidate.name);
      if (children.length === 0) {
        throw refuse(
          `the structural parent "${declaration.name}" declares no child form, so nothing may ` +
            "be written inside it.",
        );
      }
      admitted.push({
        declaration: detachStructural(declaration),
        owner,
        children: Object.freeze(children),
      });
    }
    for (const declaration of structural) {
      if (declaration.placement.kind !== "child") {
        continue;
      }
      admitted.push({
        declaration: detachStructural(declaration),
        owner,
        children: Object.freeze([]),
      });
    }
  }

  return Object.freeze(admitted);
}

/**
 * A declaration's own wording for the prop its occurrence got wrong.
 *
 * Core decides *that* the value is unacceptable — the schema it compiled says
 * so — and the declaration decides only how the sentence reads. A form that
 * states no template for the prop that failed keeps the ordinary schema
 * message.
 */
export function installedPropFailure(
  declaration: StructuralDeclaration,
  resolved: Record<string, Json>,
  error: unknown,
): Error {
  if (!(error instanceof SchemaValidationError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const diagnostics = declaration.diagnostics;
  const unknown = diagnostics?.unknownProp;
  if (unknown !== undefined) {
    for (const issue of error.issues) {
      const extra =
        issue.keyword === "additionalProperties" ? additionalProperty(issue.params) : undefined;
      if (extra !== undefined) {
        return new Error(unknown.replaceAll("{found}", extra));
      }
    }
  }
  const templates = diagnostics?.props;
  if (templates === undefined) {
    return error;
  }
  for (const issue of error.issues) {
    const missing = issue.keyword === "required" ? missingProperty(issue.params) : undefined;
    const prop = missing ?? issue.instancePath.replace(/^\//, "");
    const stated = templates[prop];
    if (stated === undefined) {
      continue;
    }
    if (missing !== undefined && stated.missing !== undefined) {
      return new Error(stated.missing);
    }
    if (issue.keyword === "type" && stated.invalidType !== undefined) {
      return new Error(stated.invalidType.replaceAll("{kind}", jsonKind(resolved[prop])));
    }
    if (missing === undefined && stated.invalidValue !== undefined) {
      return new Error(
        stated.invalidValue.replaceAll("{value}", JSON.stringify(resolved[prop]) ?? "undefined"),
      );
    }
  }
  return error;
}

function additionalProperty(params: Json): string | undefined {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const extra = params["additionalProperty"];
  return typeof extra === "string" ? extra : undefined;
}

function missingProperty(params: Json): string | undefined {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const missing = params["missingProperty"];
  return typeof missing === "string" ? missing : undefined;
}

/** How a value's kind reads in a declaration's own diagnostic. */
function jsonKind(value: Json | undefined): string {
  if (value === undefined) {
    return "nothing";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object") {
    return "an object";
  }
  return `a ${typeof value}`;
}

/**
 * The issues one occurrence's *literal* props raise against its declaration.
 *
 * Read from source alone, which is what lets document validation refuse a
 * malformed occurrence without running the document. A prop the author wrote as
 * an expression is a value the document computes: it is absent from the object
 * checked here, and the failures that absence would otherwise produce — a
 * missing required prop, chiefly — are dropped, because deciding it is
 * expansion's alone.
 */
export function* installedLiteralPropFailure(
  declaration: StructuralDeclaration,
  literals: Record<string, Json>,
  dynamic: ReadonlySet<string>,
): Operation<Error | undefined> {
  try {
    yield* validateProps(declaration.name, literals, declaration.props);
  } catch (error) {
    if (!(error instanceof SchemaValidationError)) {
      return error instanceof Error ? error : new Error(String(error));
    }
    const decided = error.issues.filter((issue) => {
      const missing = issue.keyword === "required" ? missingProperty(issue.params) : undefined;
      if (missing !== undefined) {
        return !dynamic.has(missing);
      }
      return true;
    });
    if (decided.length === 0) {
      return undefined;
    }
    return installedPropFailure(
      declaration,
      literals,
      new PropValidationIssues(declaration.name, decided),
    );
  }
  return undefined;
}

/** The decided subset of one failed validation, in the shape the mapping reads. */
class PropValidationIssues extends SchemaValidationError {
  constructor(componentName: string, issues: readonly NormalizedIssue[]) {
    super(componentName, `Prop validation failed for <${componentName} />:`, [...issues]);
  }
}

/**
 * Admit a flat catalog, as inspection and validation read one.
 *
 * Those surfaces describe declarations rather than run them: they never receive
 * installations, so they cannot ask which installation owns which form, and
 * they neither require nor invoke `expand()`. Same-owner parentage and the
 * declaration/implementation pairing are execution's questions, and execution
 * asks them with the real owners.
 */
export function admitDeclaredStructural(
  declarations: readonly ExecutionDeclaration[],
): Operation<readonly AdmittedStructural[]> {
  return admitStructuralDeclarations([
    {
      owner: 0,
      declarations,
      // Stated from the catalog itself. Inspection never receives an
      // implementation, so the pairing question is answered by whether there is
      // a structural form to implement — and a catalog with none is an ordinary
      // Markdown-only catalog rather than a broken pair.
      expands: structuralDeclarations(declarations).length > 0,
    },
  ]);
}

/**
 * The conflicts only a prepared execution can see.
 *
 * A reserved registration and a workflow bundle exist once the trusted host's
 * bootstrap has run, so these are asked after installation and before the root
 * import rather than with the intrinsic checks above.
 */
export function assertStructuralInstallable(
  entries: readonly AdmittedStructural[],
  claimedElsewhere: (name: string) => string | undefined,
): void {
  for (const entry of entries) {
    const conflict = claimedElsewhere(entry.declaration.name);
    if (conflict !== undefined) {
      throw refuse(
        `"${entry.declaration.name}" is both installed structural syntax and ${conflict}. Both ` +
          "claim the name rather than offering a default for it, so which one wins is not a " +
          "question of order.",
      );
    }
  }
}
