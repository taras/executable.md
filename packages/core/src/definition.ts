import { Ok } from "effection";
import type { Operation, Result } from "effection";
import type { ComponentDefinition, Segment } from "./types.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { compilePropsSchema, compileReturnsSchema } from "./validate.ts";
import { scanComponentSpans, scanSegments } from "./scanner.ts";
import { findTarget, outlineDocument, retainedRanges, selectTarget } from "./document-targets.ts";
import type { DocumentOutline, DocumentTargetInfo } from "./document-targets.ts";

import matter from "gray-matter";

/**
 * Whether a path names a function component. Execution imports `.ts`
 * roots as modules and parses everything else as Markdown, so inspection
 * classifies a root the same way rather than requiring a `.md` suffix.
 */
export function isFunctionComponentPath(path: string): boolean {
  return path.endsWith(".ts");
}

/** A document's frontmatter data, its markdown body, and where the body sits. */
interface ParsedSource {
  data: Record<string, unknown>;
  content: string;
  baseOffset: number;
  baseLine: number;
}

/**
 * Split frontmatter from the markdown body without reading either.
 *
 * The markdown body is a verbatim suffix of the raw file, so the body start
 * is computed by length — never by content search, which could false-match
 * body text repeated inside frontmatter. The invariant check turns any
 * gray-matter normalization surprise into a loud error instead of silently
 * wrong source positions.
 */
function parseSource(path: string, content: string): ParsedSource {
  const parsed = matter(content);
  const baseOffset = content.length - parsed.content.length;
  if (content.slice(baseOffset) !== parsed.content) {
    throw new Error(`frontmatter parse did not preserve the markdown body verbatim: ${path}`);
  }
  let baseLine = 1;
  for (let i = 0; i < baseOffset; i++) {
    if (content[i] === "\n") {
      baseLine++;
    }
  }
  return { data: parsed.data, content: parsed.content, baseOffset, baseLine };
}

/** The static heading structure a document's body offers as targets. */
export function documentOutline(path: string, content: string): DocumentOutline {
  const body = parseSource(path, content).content;
  return outlineDocument(body, scanComponentSpans(body));
}

/**
 * The exact canonical target a selector names in this document's content, or
 * the failure describing why it names none.
 *
 * Synchronous and free of effects, so the resolution that decides *what* runs
 * happens before anything runs — including inside the durable operation that
 * records the root, and inside a replay guard reading recorded content. The
 * outcome comes back rather than being thrown because both of those callers
 * record it as data before anyone reports it.
 */
export function resolveDocumentTarget(
  path: string,
  content: string,
  selector: string,
): Result<string> {
  const found = findTarget(documentOutline(path, content), selector);
  return found.ok ? Ok(found.value.target) : found;
}

interface CompiledFrontmatter {
  meta: Record<string, unknown>;
  props: ComponentDefinition["props"];
  returns: ComponentDefinition["returns"];
}

function* compileFrontmatter(data: Record<string, unknown>): Operation<CompiledFrontmatter> {
  const { meta, props, returns } = parseFrontmatter(data);
  yield* compilePropsSchema(props);
  if (returns !== undefined) {
    yield* compileReturnsSchema(returns);
  }
  return { meta, props, returns };
}

function buildDefinition(
  name: string,
  path: string,
  frontmatter: CompiledFrontmatter,
  bodySegments: Segment[],
): ComponentDefinition {
  // `returns` stays absent in text mode: absence is what distinguishes a text
  // component from one that explicitly declares a string return.
  const definition: ComponentDefinition = {
    kind: "markdown",
    name,
    path,
    meta: frontmatter.meta,
    props: frontmatter.props,
    bodySegments,
  };
  if (frontmatter.returns !== undefined) {
    definition.returns = frontmatter.returns;
  }
  return definition;
}

/**
 * Parse markdown source into a component definition. Execution and
 * inspection share this so their frontmatter and schema behavior cannot
 * drift: both compile the props and return schemas, so a malformed schema
 * fails the same way whether the document runs or is only described.
 */
export function* parseMarkdownDefinition(
  name: string,
  path: string,
  content: string,
): Operation<ComponentDefinition> {
  const body = parseSource(path, content);
  const frontmatter = yield* compileFrontmatter(body.data);
  return buildDefinition(
    name,
    path,
    frontmatter,
    scanSegments(body.content, { path, baseOffset: body.baseOffset, baseLine: body.baseLine }),
  );
}

/** A root document as parsed: what it declares, and what it addresses. */
export interface ParsedRootDocument {
  definition: ComponentDefinition;
  /** Canonical encoded target fragments in document order, duplicates kept. */
  targets: readonly string[];
  /** The same fragments, in the same order, each with its own description. */
  targetInfo: readonly DocumentTargetInfo[];
  /** The exact canonical target selected, when one was requested. */
  target?: string;
}

/**
 * Parse a root document, projecting it to one target when a selector asks for
 * one.
 *
 * Selection happens here, before any segment exists, so a selector that names
 * nothing or names several sections fails with nothing expanded. Without a
 * selector the whole body is scanned exactly as an ordinary markdown component
 * is.
 *
 * A projection scans each retained range on its own, with the origin that range
 * has in the original file, rather than scanning a concatenated string. Skipped
 * source therefore cannot renumber what follows it: a retained element keeps
 * the offset and line it was authored at, and with them its expansion ID.
 */
export function* parseRootMarkdownDefinition(
  name: string,
  path: string,
  content: string,
  selector?: string,
): Operation<ParsedRootDocument> {
  // The order is the contract, and it is the same on every public path.
  // Syntax first, because the outline comes from it; then the target, because a
  // caller who named nothing the document offers asked the wrong question and
  // should hear that rather than a complaint about a schema they did not reach;
  // then the schemas; then the projected definition.
  const body = parseSource(path, content);
  const outline = outlineDocument(body.content, scanComponentSpans(body.content));

  if (selector === undefined) {
    const frontmatter = yield* compileFrontmatter(body.data);
    const bodySegments = scanSegments(body.content, {
      path,
      baseOffset: body.baseOffset,
      baseLine: body.baseLine,
    });
    return {
      definition: buildDefinition(name, path, frontmatter, bodySegments),
      targets: outline.targets,
      targetInfo: outline.targetInfo,
    };
  }

  const entry = selectTarget(outline, selector);
  const frontmatter = yield* compileFrontmatter(body.data);
  const newlines = newlineCounts(body.content);
  const bodySegments: Segment[] = [];
  for (const range of retainedRanges(outline, entry)) {
    bodySegments.push(
      ...scanSegments(body.content.slice(range.start, range.end), {
        path,
        baseOffset: body.baseOffset + range.start,
        baseLine: body.baseLine + newlines[range.start]!,
      }),
    );
  }
  return {
    definition: buildDefinition(name, path, frontmatter, bodySegments),
    targets: outline.targets,
    targetInfo: outline.targetInfo,
    target: entry.target,
  };
}

/** How many newlines precede each offset, so a retained range knows its line. */
function newlineCounts(body: string): number[] {
  const counts = new Array<number>(body.length + 1);
  let seen = 0;
  for (let i = 0; i < body.length; i++) {
    counts[i] = seen;
    if (body[i] === "\n") {
      seen++;
    }
  }
  counts[body.length] = seen;
  return counts;
}
