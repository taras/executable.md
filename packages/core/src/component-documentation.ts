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

import { fileURLToPath } from "node:url";
import { readTextFile } from "@executablemd/runtime";
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
      // The host filesystem operation the root document's own read goes
      // through, not the document-facing `Files` authority: this is the engine
      // reading its own package, and what a running document installed must not
      // decide what its documentation says. The path is derived from this
      // module's URL, so it is package-relative whatever the working directory
      // and search path are.
      text: yield* readTextFile(fileURLToPath(url)),
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
export function* documentationIndexFor(
  /**
   * What the packages installed in this execution supply, beside core's own.
   *
   * Assembled by the trusted host, with the rest of the installation, before any
   * document code exists — the Agent, CLI, testing, web and workflow bundles
   * each contribute their own file and the set of components it must cover. Not
   * a setter and not a context: a document that could add a source could
   * describe components it does not have, and one that could remove a source
   * could hide the documentation of a component it does.
   */
  contributed: readonly DocumentationContribution[] = [],
): Operation<DocumentationIndex> {
  const core: DocumentationContribution = {
    source: yield* readCoreDocumentation(),
    supplies: CORE_COMPONENT_NAMES,
  };
  const all = [core, ...contributed];
  const supplied = new Map(all.map((one) => [one.source.owner, one.supplies]));
  return buildDocumentationIndex(
    all.map((one) => one.source),
    (owner) => supplied.get(owner) ?? new Set<string>(),
  );
}

/** One package's documentation, and the components it must account for. */
export interface DocumentationContribution {
  readonly source: DocumentationSource;
  /**
   * Every public component this package supplies.
   *
   * Both halves of the check: a heading outside this set is documentation for
   * something the package does not have, and a member of it with no heading is
   * a component shipped without documentation.
   */
  readonly supplies: ReadonlySet<string>;
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
