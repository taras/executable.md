/**
 * The documentation canonical core ships for the components it owns.
 *
 * The bytes live in `src/components/components.md`, beside the registration
 * boundary they document, and are located from this module's own URL. Never
 * from the working directory and never through `--include`: a documentation set
 * that moved with the caller's directory would describe a different product
 * depending on where somebody stood, and a repository file could answer for it.
 *
 * Each build keeps the asset beside its module — `deno compile --include`
 * embeds it at the same relative path, the npm build copies it into the emitted
 * tree, and JSR publishes the source file — so the one lookup below is correct
 * in all four, and a build that forgets the asset fails loudly on first use
 * rather than quietly serving a product with no documentation.
 */

import { readFile } from "node:fs/promises";
import { until } from "effection";
import type { Operation } from "effection";

import { buildDocumentationIndex } from "./documentation-index.ts";
import type { DocumentationIndex, DocumentationSource } from "./documentation-index.ts";
import { CORE_ORIGIN, CORE_REGISTRY } from "./components/registry.ts";
import { PROTECTED_COMPONENT_NAMES } from "./components/protected.ts";

/** Where core's own documentation lives, as a URL beside this module. */
export function componentDocumentationUrl(): URL {
  return new URL("./components/components.md", import.meta.url);
}

/** Core's documentation source, read from the package rather than the caller. */
export function* readCoreDocumentation(): Operation<DocumentationSource> {
  const url = componentDocumentationUrl();
  try {
    return {
      owner: CORE_ORIGIN,
      asset: "packages/core/src/components/components.md",
      text: yield* until(readFile(url, "utf8")),
    };
  } catch (error) {
    throw new Error(
      `the packaged component documentation is missing from this build (looked in ${url.href})`,
      { cause: error },
    );
  }
}

/**
 * The index every documentation reader shares.
 *
 * Validated against what the *package* supplies, not against whichever catalog
 * is in scope. Those are different sets and conflating them is a real bug: a
 * narrowing evaluation boundary carries a catalog holding a handful of admitted
 * components, and validating core's own documentation against that would report
 * `Elicit` as a component core does not supply. What a heading has to name is a
 * component this build actually ships; which of them a given site can select is
 * a separate question the selection answers.
 */
export function* documentationIndexFor(): Operation<DocumentationIndex> {
  const sources = [yield* readCoreDocumentation()];
  return buildDocumentationIndex(sources, (owner) =>
    owner === CORE_ORIGIN ? CORE_COMPONENT_NAMES : new Set<string>(),
  );
}

/**
 * Every component canonical core supplies, by name.
 *
 * Its registrations and the protected tier together — the two ways core puts a
 * component into an execution — read from the same declarations execution reads,
 * so this cannot drift from what the package actually ships.
 */
const CORE_COMPONENT_NAMES: ReadonlySet<string> = new Set([
  ...CORE_REGISTRY.keys(),
  ...PROTECTED_COMPONENT_NAMES,
]);
