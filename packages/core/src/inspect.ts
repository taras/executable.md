import type { Operation } from "effection";
import { readTextFile } from "@executablemd/runtime";

import type {
  ComponentOrigin,
  ComponentRegistry,
  ComponentSelection,
  FunctionComponentDefinition,
  InvocationForm,
  PropsSchema,
  RegistryEntry,
  ReturnsSchema,
} from "./types.ts";
import {
  isFunctionComponentPath,
  parseMarkdownDefinition,
  parseRootMarkdownDefinition,
} from "./definition.ts";
import type { DocumentTargetInfo } from "./document-targets.ts";
import { Component } from "./component-api.ts";
import { DEFAULT_INCLUDES, effectiveRegistry, selectComponent } from "./components/select.ts";
import { ComponentRegistrationError, mergeRegistry } from "./components/registration.ts";
import { repositoryCandidateNames } from "./components/candidates.ts";
import { documentationOf } from "./components/documentation.ts";
import type { ComponentDocumentation } from "./components/documentation.ts";
import { STRUCTURAL_DECLARATIONS } from "./structural.ts";
import { formsRefusal } from "./invocation-identity.ts";
import type { IdentityComponent } from "./invocation-identity.ts";
import { readRootSource, rootSourcePath } from "./root-source.ts";
import type { RootDocumentSource } from "./root-source.ts";

const TEXT_RETURN_SCHEMA: ReturnsSchema = { type: "string" };

/**
 * The root document to describe: a path resolved from the contextual cwd, or
 * text supplied with its `<eval>` identity.
 */
export type InspectOptions = RootDocumentSource;

export interface DocumentInfo {
  /** The path the document was read from, or `<eval>` for supplied text. */
  path: string;

  /** Frontmatter keys other than the reserved `props`, `required`, and `returns`. */
  meta: Record<string, unknown>;

  /** The document's declared props schema. */
  props: PropsSchema;

  /**
   * The document's effective return schema: `{ type: "string" }` when it
   * declares no `returns`, otherwise the validated declared schema.
   */
  returns: ReturnsSchema;

  /**
   * Whether the document returns rendered text or a declared value. An
   * explicit `returns: { type: string }` produces the same effective schema as
   * the default, so the mode — not the schema — tells the two apart.
   */
  returnMode: "text" | "value";

  /**
   * Every target the document addresses, as canonical encoded fragments without
   * the document path or a leading `#`, in document order.
   *
   * Duplicates are retained: two sections that canonicalize to the same path
   * are an ambiguity a caller can see rather than one a selector resolves
   * arbitrarily.
   */
  readonly targets: readonly string[];

  /**
   * The same targets, in the same order and with the same duplicates, each
   * carrying the description its section states — when it states one.
   *
   * Informational: `targets` remains the identity surface, and mapping this
   * array back to its `target` members reproduces it exactly. A description
   * decides nothing about selection, projection, execution, or replay.
   */
  readonly targetInfo: readonly DocumentTargetInfo[];

  /**
   * The exact canonical target the requested selector resolved to. Present only
   * when a target was requested and resolved; it is never the caller's glob.
   */
  readonly target?: string;
}

/**
 * Describe a root markdown document — read from a path or supplied as text —
 * and return what it declares, without running it. Inspection performs the same
 * frontmatter and schema
 * validation as execution, but never expands the document, evaluates a
 * code block, imports a body component, starts an agent, or creates a
 * journal — so describing a document is always free of its effects.
 *
 * Target discovery and selection happen here too. A requested selector that
 * names no section, or several, fails as a `DocumentTargetError` — before
 * anything is expanded, and without a journal ever existing.
 */
export function* inspectDocument(options: InspectOptions): Operation<DocumentInfo> {
  const path = rootSourcePath(options);
  if (isFunctionComponentPath(path)) {
    throw new Error("Root document must be a markdown file, not a function component");
  }

  // Reading through the contextual filesystem resolves a relative path
  // against the working directory, exactly as execution does. Supplied text
  // is already here, so describing it reads nothing.
  const content = yield* readRootSource(options);
  const parsed = yield* parseRootMarkdownDefinition("__root__", path, content, options.target);
  const { definition } = parsed;

  return {
    path,
    meta: definition.meta,
    props: definition.props,
    returns: definition.returns ?? TEXT_RETURN_SCHEMA,
    returnMode: definition.returns === undefined ? "text" : "value",
    targets: parsed.targets,
    targetInfo: parsed.targetInfo,
    ...(parsed.target === undefined ? {} : { target: parsed.target }),
  };
}

export interface InspectComponentOptions {
  /** The name a document would write. */
  name: string;
  /** Where to look, matching the search path execution uses. */
  includes?: string[];
}

/**
 * What a name resolves to, and how much of it can be described without running
 * anything.
 *
 * A registration and a Markdown file describe themselves fully — both are
 * already parsed or already in the module graph. A repository `.ts` component
 * reports only where it is: its schemas live on the module's exports, and
 * loading the module would run its top-level code.
 */
export type ComponentInfo =
  | { kind: "structural"; construct: string; origin: ComponentOrigin }
  | ({
      kind: "registered";
      origin: ComponentOrigin;
      props: PropsSchema;
      returns?: ReturnsSchema;
    } & DescribedContract)
  | ({
      kind: "markdown";
      origin: ComponentOrigin;
      props: PropsSchema;
      returns?: ReturnsSchema;
    } & DescribedContract)
  | { kind: "function"; origin: ComponentOrigin }
  | { kind: "unresolved"; searched: string[]; registered: readonly ComponentOrigin[] };

/**
 * What a fully describable component reports beyond its schemas.
 *
 * The same values the catalog carries, built by the same code, so describing
 * one name and describing the whole environment cannot disagree. `returns`
 * above stays the *declared* schema — absent in text mode — while `returnMode`
 * is what tells the two apart.
 */
export interface DescribedContract extends ComponentDocumentation {
  readonly forms: readonly InvocationForm[];
  readonly captures: readonly string[];
  readonly returnMode: "text" | "value";
}

/**
 * Describe what a component name resolves to, without running it.
 *
 * Inspection and execution share `selectComponent`, so they cannot disagree
 * about which tier wins. Describing a name imports no TypeScript module,
 * expands nothing, parses no candidate that was not selected, and creates no
 * journal.
 */
export function* inspectComponent(options: InspectComponentOptions): Operation<ComponentInfo> {
  const { name, includes } = options;
  const registry = yield* Component.operations.registry;
  const selected = yield* selectComponent(name, { includes, registry });

  switch (selected.kind) {
    case "structural":
      return {
        kind: "structural",
        construct: selected.construct,
        origin: { kind: "structural", construct: selected.construct },
      };
    case "registered":
      return {
        kind: "registered",
        origin: selected.origin,
        props: selected.definition.props,
        ...(selected.definition.returns === undefined
          ? {}
          : { returns: selected.definition.returns }),
        ...describedContract(yield* completeEntry(name, selected)),
      };
    case "unresolved":
      return { kind: "unresolved", searched: selected.searched, registered: selected.registered };
    case "workflow":
      // A component bundle is authority one document execution runs under.
      // Inspection installs none, so this tier answers for no inspection.
      throw new Error(
        `Component ${name} resolved through a workflow component bundle, which describes a ` +
          "document execution rather than a document.",
      );
    case "repository": {
      const origin: ComponentOrigin = { kind: "repository", path: selected.path };
      if (isFunctionComponentPath(selected.path)) {
        return { kind: "function", origin };
      }
      const entry = yield* completeEntry(name, selected);
      return {
        kind: "markdown",
        origin,
        props: entry.props,
        ...(entry.returnMode === "text" ? {} : { returns: entry.returns }),
        ...describedContract(entry),
      };
    }
  }
}

/** The catalog entry for a selection that is known to describe itself fully. */
function* completeEntry(
  name: string,
  selected: ComponentSelection,
): Operation<CompleteComponentSyntaxEntry> {
  const entry = yield* componentEntry(name, selected);
  if (entry === undefined || entry.inspectability !== "complete") {
    throw new Error(`component ${name} resolved to something that describes no contract`);
  }
  return entry;
}

function describedContract(entry: CompleteComponentSyntaxEntry): DescribedContract {
  const { forms, captures, returnMode, description, as, context } = entry;
  return {
    forms,
    captures,
    returnMode,
    ...(description === undefined ? {} : { description }),
    ...(as === undefined ? {} : { as }),
    ...(context === undefined ? {} : { context }),
  };
}

/**
 * The forms a component accepts when it declares none: both of them.
 *
 * Omission is what every registration meant before forms could be declared, and
 * it is what a Markdown component means — a Markdown definition renders its
 * content where `<Content />` appears and renders without it either way.
 */
const BOTH_FORMS: readonly InvocationForm[] = ["self-closing", "paired"];

/**
 * Everything a document may write here, as one value.
 *
 * Version 1, and the version is part of the contract rather than a note about
 * it: a consumer reads `version` before anything else and never has to guess
 * which shape it received. The three categories are a fixed tuple in a fixed
 * order, so a reader indexes them and a renderer walks them without sorting.
 */
export interface SyntaxCatalog {
  readonly version: 1;
  readonly categories: readonly [
    {
      readonly kind: "structural";
      readonly entries: readonly StructuralSyntaxEntry[];
    },
    {
      readonly kind: "built-in";
      readonly entries: readonly CompleteComponentSyntaxEntry[];
    },
    {
      readonly kind: "user-provided";
      readonly entries: readonly (CompleteComponentSyntaxEntry | OriginOnlyComponentSyntaxEntry)[];
    },
  ];
}

/** One construct the engine owns, with the forms an author writes it in. */
export interface StructuralSyntaxEntry {
  readonly kind: "structural";
  readonly name: string;
  readonly origin: Extract<ComponentOrigin, { kind: "structural" }>;
  readonly syntax: readonly string[];
  readonly description: string;
  readonly as?: string;
  readonly context?: string;
}

/**
 * One component whose contract is known without running anything.
 *
 * A registration is already in the module graph and a Markdown component is
 * already parsed, so both describe themselves completely. `returns` is the
 * *effective* schema — `{ type: "string" }` in text mode — and `returnMode` is
 * what tells a declared string return apart from the default.
 */
export interface CompleteComponentSyntaxEntry {
  readonly kind: "component";
  readonly name: string;
  readonly origin: Exclude<ComponentOrigin, { kind: "structural" }>;
  readonly sourceKind: "registered" | "markdown";
  readonly inspectability: "complete";
  readonly forms: readonly ("self-closing" | "paired")[];
  readonly props: PropsSchema;
  readonly captures: readonly string[];
  readonly returnMode: "text" | "value";
  readonly returns: ReturnsSchema;
  readonly description?: string;
  readonly as?: string;
  readonly context?: string;
}

/**
 * One repository `.ts` component, reported by where it is and nothing else.
 *
 * Its contract lives on the module's exports, and loading the module would run
 * its top-level code — which describing an environment must not do. The entry
 * carries no props, forms, captures, return or prose at all, so a reader is
 * never shown an empty contract that reads like a complete one.
 */
export interface OriginOnlyComponentSyntaxEntry {
  readonly kind: "component";
  readonly name: string;
  readonly origin: Extract<ComponentOrigin, { kind: "repository" }>;
  readonly sourceKind: "typescript";
  readonly inspectability: "origin-only";
}

export interface InspectSyntaxOptions {
  /** Where to look, matching the search path execution uses. */
  readonly includes?: readonly string[];
  /**
   * Identity components the host would declare to an execution, with the same
   * meaning `ExecuteOptions.components` gives them.
   *
   * Read for their structural metadata alone. The factory is never called: it
   * takes an execution's claimant, and describing an environment mints no
   * execution and no claimant to give it.
   */
  readonly components?: readonly IdentityComponent[];
}

/**
 * Every structural construct and every selected component a document could
 * write here, without running any of it.
 *
 * Observation, never authority. This installs nothing, executes nothing,
 * constructs no durable stream, mints no invocation, calls no identity
 * factory and expands no body; the registrations it selects against are
 * whatever the calling scope already installed. What it reads from the
 * filesystem is which files exist and, for a selected Markdown component, that
 * file's frontmatter.
 *
 * The decision about what a name means is `selectComponent()`'s, exactly as it
 * is for execution. This adds the names to ask about and the shape of the
 * answer.
 */
export function* inspectSyntax(options: InspectSyntaxOptions): Operation<SyntaxCatalog> {
  const includes = options.includes ?? DEFAULT_INCLUDES;
  const registry = mergeRegistry(
    yield* Component.operations.registry,
    declaredRegistry(options.components ?? []),
  );

  const names = yield* repositoryCandidateNames(includes);
  for (const declaration of STRUCTURAL_DECLARATIONS) {
    names.add(declaration.name);
  }
  for (const registered of effectiveRegistry(registry).keys()) {
    names.add(registered);
  }

  const structural: StructuralSyntaxEntry[] = [];
  const builtIn: CompleteComponentSyntaxEntry[] = [];
  const userProvided: (CompleteComponentSyntaxEntry | OriginOnlyComponentSyntaxEntry)[] = [];

  for (const name of [...names].sort(byCodePoint)) {
    const selected = yield* selectComponent(name, { includes, registry });
    if (selected.kind === "structural") {
      structural.push(structuralEntry(selected.construct));
      continue;
    }
    const entry = yield* componentEntry(name, selected);
    if (entry === undefined) {
      continue;
    }
    // A repository override therefore removes the name from `built-in` and adds
    // its one selected entry to `user-provided`: selection chose once, and the
    // catalog reports what it chose rather than everything it could have.
    if (entry.inspectability === "origin-only" || entry.origin.kind === "repository") {
      userProvided.push(entry);
    } else {
      builtIn.push(entry);
    }
  }

  return {
    version: 1,
    categories: [
      { kind: "structural", entries: structural },
      { kind: "built-in", entries: builtIn },
      { kind: "user-provided", entries: userProvided },
    ],
  };
}

/**
 * Compare by code point rather than by UTF-16 code unit.
 *
 * The registration grammar admits only ASCII, so today the two agree; spelling
 * the intended order out means a name that ever reaches beyond it sorts the way
 * the contract says rather than the way the default comparator happens to.
 */
function byCodePoint(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const one = a[i]?.codePointAt(0) ?? 0;
    const other = b[i]?.codePointAt(0) ?? 0;
    if (one !== other) {
      return one - other;
    }
  }
  return a.length - b.length;
}

/**
 * The identity declarations a host would make, as registry entries selection
 * can decide against.
 *
 * The implementation slot holds a refusal rather than what the factory would
 * build, because building it is the authority this has none of: the factory
 * takes an execution's claimant, and there is no execution here. Nothing in
 * inspection reaches an implementation, so the refusal is unreachable — it is
 * there so that anything which ever did would fail loudly rather than run a
 * component with no execution behind it.
 */
function declaredRegistry(components: readonly IdentityComponent[]): ComponentRegistry {
  const entries = new Map<string, RegistryEntry>();
  for (const component of components) {
    // The same check registration makes, at the other place a declaration
    // enters: ordinary execution registers these, and inspection reads them
    // without registering anything, so a malformed one has to be refused twice
    // or it is refused only when a document happens to run.
    const badForms = formsRefusal(component.forms);
    if (badForms !== undefined) {
      throw new ComponentRegistrationError(
        `the identity component "${component.name}" ${badForms}`,
      );
    }
    const definition: FunctionComponentDefinition = {
      kind: "function",
      name: component.name,
      props: component.props,
      ...(component.returns === undefined ? {} : { returns: component.returns }),
      ...(component.captures === undefined ? {} : { captures: component.captures }),
      ...(component.forms === undefined ? {} : { forms: component.forms }),
      ...documentationOf(component),
      fn: uninvocable,
    };
    entries.set(component.name, { default: { definition, origin: component.origin } });
  }
  return entries;
}

// deno-lint-ignore require-yield
function* uninvocable(): Operation<never> {
  throw new Error(
    "this component was described rather than executed, so it has no implementation to run",
  );
}

function structuralEntry(construct: string): StructuralSyntaxEntry {
  const declaration = STRUCTURAL_DECLARATIONS.find((candidate) => candidate.name === construct);
  if (declaration === undefined) {
    throw new Error(`structural construct ${construct} has no declaration`);
  }
  return {
    kind: "structural",
    name: declaration.name,
    origin: { kind: "structural", construct: declaration.name },
    syntax: declaration.syntax,
    description: declaration.description,
    ...(declaration.as === null ? {} : { as: declaration.as }),
    ...(declaration.context === null ? {} : { context: declaration.context }),
  };
}

/**
 * The catalog entry one selection produces, or `undefined` when the selection
 * describes nothing a document can write here.
 *
 * Shared with `inspectComponent()` below, so a single name and the whole
 * catalog cannot disagree about what a component's contract is.
 */
function* componentEntry(
  name: string,
  selected: ComponentSelection,
): Operation<CompleteComponentSyntaxEntry | OriginOnlyComponentSyntaxEntry | undefined> {
  if (selected.kind === "registered") {
    const { definition, origin } = selected;
    if (origin.kind === "structural") {
      return undefined;
    }
    return complete(name, origin, "registered", {
      forms: definition.forms ?? BOTH_FORMS,
      props: definition.props,
      captures: definition.captures ?? [],
      returns: definition.returns,
      documentation: documentationOf(definition),
    });
  }

  if (selected.kind !== "repository") {
    // A bundled or unresolved name describes no environment a document writes
    // in: inspection installs no bundle, and a name nothing supplies is exactly
    // the absence the catalog reports by leaving it out.
    return undefined;
  }

  const origin: Extract<ComponentOrigin, { kind: "repository" }> = {
    kind: "repository",
    path: selected.path,
  };
  if (isFunctionComponentPath(selected.path)) {
    return {
      kind: "component",
      name,
      origin,
      sourceKind: "typescript",
      inspectability: "origin-only",
    };
  }

  const source = yield* readTextFile(selected.path);
  const definition = yield* parseMarkdownDefinition(name, selected.path, source);
  return complete(name, origin, "markdown", {
    forms: BOTH_FORMS,
    props: definition.props,
    captures: [],
    returns: definition.returns,
    // Ordinary frontmatter metadata. A non-string value stays in `meta`, fails
    // nothing, and contributes no documentation field.
    documentation: documentationOf(definition.meta),
  });
}

interface CompleteContract {
  forms: readonly InvocationForm[];
  props: PropsSchema;
  captures: readonly string[];
  /** Absent in text mode, which is what `returnMode` reports. */
  returns: ReturnsSchema | undefined;
  documentation: ComponentDocumentation;
}

function complete(
  name: string,
  origin: Exclude<ComponentOrigin, { kind: "structural" }>,
  sourceKind: "registered" | "markdown",
  contract: CompleteContract,
): CompleteComponentSyntaxEntry {
  return {
    kind: "component",
    name,
    origin,
    sourceKind,
    inspectability: "complete",
    forms: contract.forms,
    props: contract.props,
    captures: contract.captures,
    returnMode: contract.returns === undefined ? "text" : "value",
    returns: contract.returns ?? TEXT_RETURN_SCHEMA,
    ...contract.documentation,
  };
}
