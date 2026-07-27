import type { Operation } from "effection";
import { readTextFile } from "@executablemd/runtime";

import type { PropsSchema } from "./types.ts";
import { isFunctionComponentPath, parseMarkdownDefinition } from "./definition.ts";

export interface InspectOptions {
  /** Path to the root markdown document, resolved from the contextual cwd. */
  path: string;
}

export interface DocumentInfo {
  /** The path the document was read from. */
  path: string;

  /** Frontmatter keys other than the reserved `props` and `required`. */
  meta: Record<string, unknown>;

  /** The document's declared props schema. */
  props: PropsSchema;
}

/**
 * Read a root markdown document and return what it declares, without
 * running it. Inspection performs the same frontmatter and schema
 * validation as execution, but never expands the document, evaluates a
 * code block, imports a body component, starts an agent, or creates a
 * journal — so describing a document is always free of its effects.
 */
export function* inspectDocument(options: InspectOptions): Operation<DocumentInfo> {
  const { path } = options;
  if (isFunctionComponentPath(path)) {
    throw new Error("Root document must be a markdown file, not a function component");
  }

  // Reading through the contextual filesystem resolves a relative path
  // against the working directory, exactly as execution does.
  const content = yield* readTextFile(path);
  const definition = parseMarkdownDefinition("__root__", path, content);

  return { path, meta: definition.meta, props: definition.props };
}
