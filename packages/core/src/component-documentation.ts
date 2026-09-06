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

import { readTextFile } from "@effectionx/fs";
import type { Operation } from "effection";

import { buildDocumentationIndex } from "./documentation-index.ts";
import type { DocumentationIndex, DocumentationSource } from "./documentation-index.ts";
import { CORE_ORIGIN, CORE_REGISTRY } from "./components/registry.ts";
import { PROTECTED_COMPONENT_NAMES } from "./components/protected.ts";
import { AGENT_REGISTRATIONS, agentIdentityComponents } from "./agent/components.ts";

/** Where core's own documentation lives, as a URL beside this module. */
export function componentDocumentationUrl(): URL {
  return new URL("./components/components.md", import.meta.url);
}

/**
 * Where the Agent registrations' documentation lives.
 *
 * Beside `agent/components.ts`, which is the boundary that registers them. They
 * carry core's origin, so they are core's components for the join; what makes
 * them a separate file is that they are a separate registration boundary, and
 * documentation belongs beside the code it documents.
 */
export function agentDocumentationUrl(): URL {
  return new URL("./agent/components.md", import.meta.url);
}

/**
 * The Agent registrations' contribution, for a host that installs them.
 *
 * Offered rather than assumed: a run that registers no Agent components has no
 * Agent components to document, and demanding their documentation would refuse
 * an index for a profile that is complete without them.
 */
export function* agentDocumentation(
  read: DocumentationReader = packagedAssetReader,
): Operation<DocumentationContribution> {
  return {
    source: yield* readPackagedDocumentation(
      agentDocumentationUrl(),
      { owner: CORE_ORIGIN, asset: "packages/core/src/agent/components.md" },
      read,
    ),
    supplies: agentComponentNames(),
  };
}

/**
 * Every component the Agent registration boundary supplies, by name.
 *
 * Built when asked rather than at module scope. The Agent bootstrap imports this
 * module for its own contribution, so a module-scoped set built from
 * `AGENT_REGISTRATIONS` would read that array before its own module finished
 * evaluating, depending on which of the two was loaded first.
 */
function agentComponentNames(): ReadonlySet<string> {
  return new Set([
    ...AGENT_REGISTRATIONS.map((registration) => registration.name),
    ...agentIdentityComponents().map((component) => component.name),
  ]);
}

/** Core's documentation source, read from the package rather than the caller. */
export function* readCoreDocumentation(
  read: DocumentationReader = packagedAssetReader,
): Operation<DocumentationSource> {
  const url = componentDocumentationUrl();
  try {
    return {
      owner: CORE_ORIGIN,
      asset: "packages/core/src/components/components.md",
      // The direct Effection filesystem, not `API.Fs` and not the document
      // facing `Files` authority. Both of those are middleware a running
      // document can compose around: a repository component, an eval block or
      // an installed handler could answer the read and decide what the product's
      // own documentation says. This is the engine reading an immutable asset
      // out of its own package, so it goes to the filesystem directly, at a URL
      // derived from this module — package-relative whatever the working
      // directory and search path are.
      text: yield* read(url),
    };
  } catch (error) {
    throw new Error(
      `the packaged component documentation is missing from this build (looked in ${url.href})`,
      { cause: error },
    );
  }
}

/**
 * A contribution built from the registrations it documents.
 *
 * The set is derived from the same declarations the package installs, so a
 * component added to a boundary demands documentation without anyone having to
 * remember to list it here. That is the whole point of deriving it: a
 * hand-maintained second list is exactly the thing that goes stale.
 */
export function* packageDocumentation(
  url: URL,
  named: { owner: string; asset: string },
  supplies: Iterable<string>,
  read: DocumentationReader = packagedAssetReader,
): Operation<DocumentationContribution> {
  return {
    source: yield* readPackagedDocumentation(url, named, read),
    supplies: new Set(supplies),
  };
}

/**
 * How one execution reads its packaged assets.
 *
 * Carried by value from where the execution is built, never held in module
 * scope. A module-level reader would be one variable shared by every execution
 * in the process: two runs in one process would read through each other's, and
 * a test that substituted one would change what an unrelated execution is told
 * the product says. It is also not a provider, a Context, an installation field
 * or a hook — nothing a document, a component or an installed package can reach
 * names it at all.
 */
export type DocumentationReader = (url: URL) => Operation<string>;

/** The reader every ordinary execution uses. */
export const packagedAssetReader: DocumentationReader = readTextFile;

/** One packaged documentation asset, read the same guarded way. */
export function* readPackagedDocumentation(
  url: URL,
  named: { owner: string; asset: string },
  read: DocumentationReader = packagedAssetReader,
): Operation<DocumentationSource> {
  try {
    return { ...named, text: yield* read(url) };
  } catch (error) {
    throw new Error(
      `the packaged component documentation ${named.asset} is missing from this build ` +
        `(looked in ${url.href})`,
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
export function documentationIndexFor(
  /**
   * What the packages bootstrapped in this execution supply, core's own
   * included.
   *
   * Collected through the `Documentation` Api at the trusted boundary, before
   * any document code exists — core is the terminal, and the Agent, CLI,
   * testing, web and workflow bootstraps each append their own file and the set
   * of components it must cover. Nothing is added here: a second core entry
   * appended by this function would be a source no bootstrap accounted for, and
   * the collector's duplicate refusal would never see it.
   */
  all: readonly DocumentationContribution[],
): DocumentationIndex {
  // Merged per owner, not replaced. One package can have several registration
  // boundaries — core registers its own components and its Agent components
  // from two files — and keying by owner alone would let the second boundary's
  // set hide the first's, so every component in the file that lost would look
  // like documentation for something the package does not supply.
  const supplied = new Map<string, Set<string>>();
  for (const one of all) {
    const held = supplied.get(one.source.owner) ?? new Set<string>();
    for (const name of one.supplies) {
      held.add(name);
    }
    supplied.set(one.source.owner, held);
  }
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
 *
 * Deliberately not `CORE_COMPONENT_NAMES`, which is the registrations alone.
 * Documentation has to account for the protected tier as well, and two sets
 * under one name would eventually be used for each other's question.
 */
export const CORE_DOCUMENTED_NAMES: ReadonlySet<string> = new Set([
  ...CORE_REGISTRY.keys(),
  ...PROTECTED_COMPONENT_NAMES,
]);
