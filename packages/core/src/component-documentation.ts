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
import { CORE_ORIGIN } from "./components/registry.ts";
import type { SyntaxCatalog } from "./inspect.ts";
import { owningPackage } from "./documentation-index.ts";

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
 * The index for one catalog, validated against what that catalog actually holds.
 *
 * The catalog supplies the known names, so a heading naming something this build
 * does not supply is caught here rather than becoming an entry nothing can ever
 * select. That is also what keeps the index and the catalog from disagreeing
 * about which components exist.
 */
export function* documentationIndexFor(catalog: SyntaxCatalog): Operation<DocumentationIndex> {
  const sources = [yield* readCoreDocumentation()];
  return buildDocumentationIndex(sources, (owner) => namesOwnedBy(catalog, owner));
}

/** Every component in this catalog that the named package supplies. */
function namesOwnedBy(catalog: SyntaxCatalog, owner: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const category of catalog.categories) {
    for (const entry of category.entries) {
      if (owningPackage(entry.origin) === owner) {
        names.add(entry.name);
      }
    }
  }
  return names;
}
