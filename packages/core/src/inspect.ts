import type { Operation } from "effection";
import { readTextFile } from "@executablemd/runtime";

import type { ComponentOrigin, PropsSchema, ReturnsSchema } from "./types.ts";
import { isFunctionComponentPath, parseMarkdownDefinition } from "./definition.ts";
import { Component } from "./component-api.ts";
import { selectComponent } from "./components/select.ts";
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
}

/**
 * Describe a root markdown document — read from a path or supplied as text —
 * and return what it declares, without running it. Inspection performs the same
 * frontmatter and schema
 * validation as execution, but never expands the document, evaluates a
 * code block, imports a body component, starts an agent, or creates a
 * journal — so describing a document is always free of its effects.
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
  const definition = yield* parseMarkdownDefinition("__root__", path, content);

  return {
    path,
    meta: definition.meta,
    props: definition.props,
    returns: definition.returns ?? TEXT_RETURN_SCHEMA,
    returnMode: definition.returns === undefined ? "text" : "value",
  };
}

export interface InspectComponentOptions {
  /** The name a document would write. */
  name: string;
  /** Where to look, matching the search path execution uses. */
  componentDirs?: string[];
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
  | {
      kind: "registered";
      origin: ComponentOrigin;
      props: PropsSchema;
      returns?: ReturnsSchema;
    }
  | { kind: "markdown"; origin: ComponentOrigin; props: PropsSchema; returns?: ReturnsSchema }
  | { kind: "function"; origin: ComponentOrigin }
  | { kind: "unresolved"; searched: string[]; registered: readonly ComponentOrigin[] };

/**
 * Describe what a component name resolves to, without running it.
 *
 * Inspection and execution share `selectComponent`, so they cannot disagree
 * about which tier wins. Describing a name imports no TypeScript module,
 * expands nothing, parses no candidate that was not selected, and creates no
 * journal.
 */
export function* inspectComponent(options: InspectComponentOptions): Operation<ComponentInfo> {
  const { name, componentDirs } = options;
  const registry = yield* Component.operations.registry;
  const selected = yield* selectComponent(name, { componentDirs, registry });

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
      };
    case "unresolved":
      return { kind: "unresolved", searched: selected.searched, registered: selected.registered };
    case "repository": {
      const origin: ComponentOrigin = { kind: "repository", path: selected.path };
      if (isFunctionComponentPath(selected.path)) {
        return { kind: "function", origin };
      }
      const source = yield* readTextFile(selected.path);
      const definition = yield* parseMarkdownDefinition(name, selected.path, source);
      return {
        kind: "markdown",
        origin,
        props: definition.props,
        ...(definition.returns === undefined ? {} : { returns: definition.returns }),
      };
    }
  }
}
