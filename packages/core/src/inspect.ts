import type { Operation } from "effection";
import { readTextFile } from "@executablemd/runtime";

import type {
  ComponentOrigin,
  ComponentRegistry,
  ComponentSelection,
  InvocationForm,
  PropsSchema,
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
import { admitDeclaration, mergeRegistry } from "./components/registration.ts";
import { declaredRegistry } from "./components/declared-registry.ts";
import { admitDeclaredMarkdown, declaredCatalog } from "./components/declared-markdown.ts";
import type { DeclaredMarkdownComponent } from "./components/declared-markdown.ts";
import { repositoryCandidateNames } from "./components/candidates.ts";
import { PROTECTED_COMPONENT_NAMES } from "./components/protected.ts";
import type { WorkflowImportAuthority } from "./components/bundle.ts";
import { documentationOf } from "./components/documentation.ts";
import type { ComponentDocumentation } from "./components/documentation.ts";
import { STRUCTURAL_DECLARATIONS } from "./structural.ts";
import { assertDistinctIdentityNames } from "./invocation-identity.ts";
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
  /**
   * The exact Markdown a host would declare to an execution, with the same
   * meaning `ExecutionInstallation.declarations` gives it — admissibility
   * included. Private declarations are never described: nothing a document can
   * write resolves one.
   */
  declarations?: readonly DeclaredMarkdownComponent[];
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
  const declared = declaredCatalog(
    yield* admitDeclaredMarkdown(options.declarations ?? [], registry),
  );
  const selected = yield* selectComponent(name, {
    includes,
    registry,
    ...(declared === undefined ? {} : { declared }),
  });

  switch (selected.kind) {
    case "structural":
      return {
        kind: "structural",
        construct: selected.construct,
        origin: { kind: "structural", construct: selected.construct },
      };
    case "protected":
      return {
        kind: "registered",
        origin: selected.origin,
        props: selected.component.props,
        ...(selected.component.returns === undefined
          ? {}
          : { returns: selected.component.returns }),
        ...describedContract(yield* completeEntry(name, selected)),
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
    case "declared-markdown": {
      const entry = yield* completeEntry(name, selected);
      return {
        kind: "markdown",
        origin: entry.origin,
        props: entry.props,
        ...(entry.returnMode === "text" ? {} : { returns: entry.returns }),
        ...describedContract(entry),
      };
    }
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
  readonly sourceKind: "registered" | "markdown" | "declared-markdown";
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
   * The registrations to describe, when the caller holds them.
   *
   * Omitted reads whatever the calling scope installed, which is what `xmd
   * syntax` wants — it assembles the profile it is describing and then asks. An
   * execution passes the registry it *captured* instead: what a document may
   * write is decided by the registrations the execution started with, and a
   * nested `registerComponents()` somewhere inside it does not change the
   * environment the run was assembled as.
   */
  readonly registry?: ComponentRegistry;
  /**
   * The component bundle the execution being described is closed over.
   *
   * Omitted for an inspection: `xmd syntax` installs no bundle, so it describes
   * a document rather than a run. An execution that has one passes it, because
   * leaving it out would describe a workflow root as having none of the
   * components its own pinned tree supplies. Nothing here imports or executes a
   * bundle member: the pinned source is already in hand, and describing it
   * parses the same bytes execution would.
   */
  readonly workflow?: WorkflowImportAuthority;
  /**
   * Identity components the host would declare to an execution, with the same
   * meaning `ExecuteOptions.components` gives them — admissibility included.
   *
   * A set an execution would refuse is refused here too: two declarations of
   * one name, and any declaration registration would not accept. Read for their
   * structural metadata alone; the factory is never called, because it takes an
   * execution's claimant and describing an environment mints no execution and
   * no claimant to give it.
   */
  readonly components?: readonly IdentityComponent[];
  /**
   * The exact Markdown a host would declare to an execution, with the same
   * meaning `ExecutionInstallation.declarations` gives it — admissibility
   * included. A private declaration contributes no entry: it is not a name a
   * document can write, so a catalog that listed it would describe syntax that
   * does not exist.
   */
  readonly declarations?: readonly DeclaredMarkdownComponent[];
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
  const bundled = options.workflow;
  const declared = options.components ?? [];
  // The whole declaration set is admitted before anything is built from it, on
  // exactly the terms ordinary execution admits it on. A set an execution would
  // refuse describes an environment no document could ever run in, and
  // answering for it would be describing a run that cannot happen.
  assertDistinctIdentityNames(declared);
  for (const component of declared) {
    yield* admitDeclaration(component);
  }
  const registry = mergeRegistry(
    options.registry ?? (yield* Component.operations.registry),
    declaredRegistry(declared),
  );
  // Admitted on exactly the terms an execution installs declarations on, and
  // for the same reason the identity components above are: a set a run would
  // refuse describes an environment no document could ever run in.
  const declarations = declaredCatalog(
    yield* admitDeclaredMarkdown(options.declarations ?? [], registry),
  );

  const names = yield* repositoryCandidateNames(includes);
  for (const name of declarations?.names() ?? []) {
    names.add(name);
  }
  for (const declaration of STRUCTURAL_DECLARATIONS) {
    names.add(declaration.name);
  }
  // Core's own claim, so it is enumerated wherever a catalog is built rather
  // than only where a host remembered to mention it.
  for (const name of PROTECTED_COMPONENT_NAMES) {
    names.add(name);
  }
  for (const name of bundled?.names() ?? []) {
    names.add(name);
  }
  for (const registered of effectiveRegistry(registry).keys()) {
    names.add(registered);
  }

  const structural: StructuralSyntaxEntry[] = [];
  const builtIn: CompleteComponentSyntaxEntry[] = [];
  const userProvided: (CompleteComponentSyntaxEntry | OriginOnlyComponentSyntaxEntry)[] = [];

  for (const name of [...names].sort(byCodePoint)) {
    const selected = yield* selectComponent(name, {
      includes,
      registry,
      ...(bundled === undefined ? {} : { workflow: bundled }),
      ...(declarations === undefined ? {} : { declared: declarations }),
    });
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
  if (selected.kind === "protected") {
    const { component, origin } = selected;
    // Described from the declaration alone. The factory is never called: it
    // takes an execution's claimant, and describing an environment mints no
    // execution and no claimant to give it.
    return complete(name, origin, "registered", {
      forms: component.forms ?? BOTH_FORMS,
      props: component.props,
      captures: component.captures ?? [],
      returns: component.returns,
      documentation: documentationOf(component),
    });
  }

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

  if (selected.kind === "declared-markdown") {
    const { definition, origin, digest, forms } = selected;
    return complete(name, { kind: "declared-markdown", origin, digest }, "declared-markdown", {
      forms,
      props: definition.props,
      captures: [],
      returns: definition.returns,
      documentation: documentationOf(definition.meta),
    });
  }

  if (selected.kind === "workflow") {
    // The pinned bytes, already in hand: the bundle was read from the
    // definition's own commit before this execution existed, so describing one
    // reads no file, imports no module and runs nothing. It is the run author's
    // own Markdown, reported at the canonical path it holds inside that commit.
    const definition = yield* parseMarkdownDefinition(name, selected.path, selected.content);
    return complete(name, { kind: "repository", path: selected.path }, "markdown", {
      forms: BOTH_FORMS,
      props: definition.props,
      captures: [],
      returns: definition.returns,
      documentation: documentationOf(definition.meta),
    });
  }

  if (selected.kind !== "repository") {
    // An unresolved name is exactly the absence the catalog reports by leaving
    // it out.
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
  sourceKind: "registered" | "markdown" | "declared-markdown",
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
