/**
 * Identified import providers, and the answers a complete program runs
 * (specs/executable-mdx-spec.md §5.7).
 *
 * `Component.importComponent` middleware may answer an import without
 * delegating, or replace what came back. That is ordinary and supported, and it
 * is also why a complete program cannot describe what it will run by resolving
 * the name a second way: the answer that runs is the chain's, and a second
 * resolution describes a definition nobody invokes.
 *
 * So a provider that answers or replaces states who it is. It does that here,
 * at its installation boundary, and canonical execution mints it a claimant
 * bound to this one execution. Marking an answer with that claimant binds the
 * provider's terms to that exact object in execution-private state — never on
 * the definition, which is data an answer can copy, and never through a
 * replaceable Context answer.
 *
 * ## What the identity is, and is not
 *
 * It is an assertion by the authority installed at the site, exactly as a
 * registration's origin is. Nothing here proves a provider is who it says; what
 * it buys is that the assertion is *stable and versioned*, so a continuation
 * can be told the implementation changed. A provider reusing one revision for a
 * different implementation is breaking its own contract, and the engine does
 * not try to repair that by reading the definition.
 *
 * Two live providers under one origin refuse, because then an origin no longer
 * names one authority.
 *
 * ## An unidentified answer is not refused, it is unusable
 *
 * A document that installs a raw replacement keeps working: ordinary expansion
 * never asks any of this. What it cannot do is stand behind a durable grant,
 * because a continuation would have nothing to compare and would invoke
 * whatever answered on the day it resumed.
 */

import { createContext } from "effection";
import type { Context, Operation } from "effection";

import { CanonicalImports } from "./components/import-authority.ts";
import type { ImportedDefinition } from "./components/import-authority.ts";
import { ProgramEvaluationError } from "./program-identity.ts";
import type { ImportProviderIdentity } from "./program-identity.ts";

/** How an identified provider marks one answer as its own. */
export interface ImportProviderClaimant {
  (name: string, key: string, definition: ImportedDefinition): ImportedDefinition;
}

/** What canonical execution offers an identified provider for one execution. */
export interface ImportProviderRegistry {
  claimant(identity: ImportProviderIdentity): ImportProviderClaimant;
}

/**
 * Where an identified provider finds this execution's claimant minter.
 *
 * A Context, because a provider installed by a host or a document has no other
 * way to reach the execution it is being installed into. That is not a hole:
 * the claimant grants nothing. It labels an answer, the label is compared
 * rather than trusted, and what is invoked is core's own copy.
 */
export const ImportProviders: Context<ImportProviderRegistry | undefined> = createContext<
  ImportProviderRegistry | undefined
>("component.importProviders", undefined);

/**
 * Mark this provider's answers with a stable versioned identity.
 *
 * Called once where the provider is installed, before its middleware is. A
 * provider outside any execution receives a claimant that marks nothing, so the
 * same installation code works in a context that has no admission to make.
 */
export function* useImportProvider(
  identity: ImportProviderIdentity,
): Operation<ImportProviderClaimant> {
  const registry = yield* ImportProviders.get();
  if (registry === undefined) {
    return (_name, _key, definition) => definition;
  }
  return registry.claimant(identity);
}

/** The registry canonical execution installs for one execution. */
export function createImportProviderRegistry(imports: CanonicalImports): ImportProviderRegistry {
  const origins = new Set<string>();
  return {
    claimant(identity: ImportProviderIdentity): ImportProviderClaimant {
      // Read once, here, and never again. What a provider states is an object it
      // still holds: a getter can answer one origin to the duplicate check and
      // another to the claim, and a plain object can be edited after this
      // returns. Copying the primitives out at registration is what makes the
      // identity this claimant marks answers with the identity that was
      // validated and counted.
      const origin = identity.origin;
      const revision = identity.revision;
      if (typeof origin !== "string" || typeof revision !== "string") {
        throw new ProgramEvaluationError(
          "An identified import provider states its origin and revision as strings.",
        );
      }
      if (origin.length === 0 || revision.length === 0) {
        throw new ProgramEvaluationError(
          "An identified import provider states a non-empty origin and revision.",
        );
      }
      if (origins.has(origin)) {
        throw new ProgramEvaluationError(
          `Two import providers are installed under the origin "${origin}", so it names ` +
            "no single authority.",
        );
      }
      origins.add(origin);
      return (name, key, definition) =>
        imports.supply(name, { origin, key, revision: revision }, definition);
    },
  };
}
