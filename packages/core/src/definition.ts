import type { Operation } from "effection";
import type { ComponentDefinition } from "./types.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { compilePropsSchema, compileReturnsSchema } from "./validate.ts";
import { scanSegments } from "./scanner.ts";

import matter from "gray-matter";

/**
 * Whether a path names a function component. Execution imports `.ts`
 * roots as modules and parses everything else as Markdown, so inspection
 * classifies a root the same way rather than requiring a `.md` suffix.
 */
export function isFunctionComponentPath(path: string): boolean {
  return path.endsWith(".ts");
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
  const parsed = matter(content);
  const { meta, props, returns } = parseFrontmatter(parsed.data);
  yield* compilePropsSchema(props);
  if (returns !== undefined) {
    yield* compileReturnsSchema(returns);
  }
  // The markdown body is a verbatim suffix of the raw file, so the body start
  // is computed by length — never by content search, which could false-match
  // body text repeated inside frontmatter. The invariant check turns any
  // gray-matter normalization surprise into a loud error instead of silently
  // wrong source positions.
  const bodyStart = content.length - parsed.content.length;
  if (content.slice(bodyStart) !== parsed.content) {
    throw new Error(`frontmatter parse did not preserve the markdown body verbatim: ${path}`);
  }
  let baseLine = 1;
  for (let i = 0; i < bodyStart; i++) {
    if (content[i] === "\n") {
      baseLine++;
    }
  }
  const bodySegments = scanSegments(parsed.content, {
    path,
    baseOffset: bodyStart,
    baseLine,
  });

  // `returns` stays absent in text mode: absence is what distinguishes a text
  // component from one that explicitly declares a string return.
  const definition: ComponentDefinition = {
    kind: "markdown",
    name,
    path,
    meta,
    props,
    bodySegments,
  };
  if (returns !== undefined) {
    definition.returns = returns;
  }
  return definition;
}
