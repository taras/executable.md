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

import { stillDescribes } from "./components/import-authority.ts";
import { CanonicalImports } from "./components/import-authority.ts";
import type {
  ImportAuthority,
  ImportedDefinition,
  ImportRefusal,
} from "./components/import-authority.ts";
import { ProgramEvaluationError } from "./program-identity.ts";
import type { ImportProviderIdentity, ResolvedProgramComponent } from "./program-identity.ts";

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
      if (identity.origin.length === 0 || identity.revision.length === 0) {
        throw new ProgramEvaluationError(
          "An identified import provider states a non-empty origin and revision.",
        );
      }
      if (origins.has(identity.origin)) {
        throw new ProgramEvaluationError(
          `Two import providers are installed under the origin "${identity.origin}", so it names ` +
            "no single authority.",
        );
      }
      origins.add(identity.origin);
      return (name, key, definition) =>
        imports.supply(
          name,
          { origin: identity.origin, key, revision: identity.revision },
          definition,
        );
    },
  };
}

/** What one program's imports refuse, and why. */
const REFUSED: Record<ImportRefusal, string> = {
  unissued:
    "Component.importComponent middleware answered a complete program's import with a definition " +
    "canonical resolution did not settle for it.",
  "another-name":
    "Component.importComponent middleware answered a complete program's import with the " +
    "definition canonical resolution settled for another component.",
  changed:
    "Component.importComponent middleware changed the definition canonical resolution settled " +
    "before the program invoked it.",
};

/**
 * The answers one admitted program invokes.
 *
 * Built from the resolution that passed the compatibility comparison, so the
 * definition a program expands is the one the comparison was about. Asking the
 * chain again and invoking whatever came back is the gap this closes: a
 * provider could answer one way while the site was being checked and another
 * way while the program ran.
 *
 * A name that resolved to nothing is not closed here. It reaches the ordinary
 * chain and produces the ordinary unresolved failure, which is what a program
 * naming a component this site does not have should say.
 */
export class ProgramImports implements ImportAuthority {
  readonly #answers: ReadonlyMap<string, ImportedDefinition>;

  constructor(resolved: readonly ResolvedProgramComponent[]) {
    const answers = new Map<string, ImportedDefinition>();
    for (const entry of resolved) {
      if (entry.definition !== undefined && !answers.has(entry.name)) {
        answers.set(entry.name, entry.definition);
      }
    }
    this.#answers = answers;
  }

  closes(name: string): boolean {
    return this.#answers.has(name);
  }

  /**
   * The answer canonical resolution settled, for the import the program made.
   *
   * The chain still runs, so the execution records its own selection and
   * identity domain exactly as it does for any other import. What changes is
   * what comes back: the answer must still describe what the comparison
   * passed, and the object invoked is the copy the comparison was about. A
   * provider that answered one way while the site was checked and another way
   * while the program ran is refused here rather than preferred.
   */
  authorize(name: string, answer: ImportedDefinition): ImportedDefinition {
    const settled = this.#answers.get(name);
    if (settled === undefined) {
      throw new ProgramEvaluationError(REFUSED.unissued);
    }
    if (answer !== settled && read(() => stillDescribes(settled, answer)) !== true) {
      throw new ProgramEvaluationError(REFUSED.changed);
    }
    return settled;
  }
}

/** One read of an answer that may refuse to be read. */
function read<T>(inspect: () => T): T | undefined {
  try {
    return inspect();
  } catch {
    return undefined;
  }
}
