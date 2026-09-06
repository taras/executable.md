/**
 * How a package contributes the documentation for the components it registers.
 *
 * Documentation composes with the components it describes. A package's
 * bootstrap installs its registrations and its documentation together, through
 * this one namespaced Api, so a host that bootstraps a package gets both by
 * invoking one thing. The alternative — a host-maintained list of every
 * package's documentation, kept beside a host-maintained list of every
 * package's registrations — is two lists that drift, and they did: a nested run
 * registered `<WebForm>` and then reported it undocumented, because one list
 * had been updated and the other had not.
 *
 * ## The terminal is core's own
 *
 * `contributions()` answers with core's own documentation and nothing else. A
 * package wraps it, delegates, and appends its own:
 *
 * ```ts
 * yield* Documentation.around({
 *   *contributions([read], next) {
 *     return [...(yield* next(read)), yield* webDocumentation(read)];
 *   },
 * });
 * ```
 *
 * Composition is why order cannot choose a winner: every wrapper delegates, so
 * every contribution reaches the collector, and two contributions for one
 * component refuse there rather than the later one silently replacing the
 * earlier.
 *
 * ## What an execution reads
 *
 * Canonical execution asks *once*, after trusted host bootstrap and before the
 * root import or any document code, and snapshots the answer by value. So
 * middleware a document or a component installs later composes into a chain
 * nothing reads: what `<Syntax names={…}>` renders is what the host assembled,
 * not what the document arranged afterwards. Two executions assembled in
 * separate scopes see their own, because a scope is what an Api answer belongs
 * to.
 *
 * The execution's own asset reader travels as the argument rather than being
 * read from module scope, so every package's asset is read through the reader
 * belonging to the execution that asked, and two executions in one process
 * cannot read through each other's.
 */

import { type Api, createApi } from "@effectionx/context-api";
import type { Operation } from "effection";

import {
  CORE_DOCUMENTED_NAMES,
  packagedAssetReader,
  readCoreDocumentation,
} from "./component-documentation.ts";
import type { DocumentationContribution, DocumentationReader } from "./component-documentation.ts";
import { DocumentationIndexError } from "./documentation-index.ts";
import { snapshotContributions } from "./syntax-reference.ts";

/** What this Api answers. */
export interface DocumentationApi {
  /**
   * Every bootstrapped package's documentation, in bootstrap order.
   *
   * Order is not authority: it decides how the list reads, and nothing else.
   * Two contributions naming one component of one package refuse wherever they
   * sit in it.
   */
  contributions(read: DocumentationReader): Operation<readonly DocumentationContribution[]>;
}

/**
 * The namespace a package's bootstrap reaches.
 *
 * Stable and namespaced so a separately loaded copy of a package composes here
 * too: what makes two copies agree is the Api's name, not a shared module
 * instance. It carries documentation and nothing else — no definitions, no
 * import witnesses, no registration handle — so composing with it grants a
 * package no authority it did not already have.
 */
export const Documentation: Api<DocumentationApi> = createApi<DocumentationApi>("Documentation", {
  /**
   * Canonical core's own documentation, as the terminal.
   *
   * Every chain ends here, so core's components are documented in an execution
   * that bootstrapped no other package at all.
   */
  *contributions(read: DocumentationReader): Operation<readonly DocumentationContribution[]> {
    return [{ source: yield* readCoreDocumentation(read), supplies: CORE_DOCUMENTED_NAMES }];
  },
});

/**
 * Add this package's documentation to whatever the enclosing scope contributes.
 *
 * The one call a package's bootstrap makes, beside registering its components.
 * It delegates first and appends after, so nothing it composes over is lost and
 * no bootstrap can answer for a package that is not its own.
 *
 * The contribution is read when the collector asks, not when this is called,
 * and through the reader the collector supplies: a bootstrap installed in one
 * execution's scope reads that execution's assets.
 */
export function* contributeDocumentation(
  contribute: (read: DocumentationReader) => Operation<DocumentationContribution>,
): Operation<void> {
  yield* Documentation.around({
    *contributions([read], next): Operation<readonly DocumentationContribution[]> {
      return [...(yield* next(read)), yield* contribute(read)];
    },
  });
}

/**
 * What this execution's packages contributed, captured by value.
 *
 * Asked once, where canonical execution is assembled: after the trusted host's
 * bootstrap and before the root import, so what a document later installs
 * composes into a chain nothing reads. Snapshotted field by field for the same
 * reason the installation boundary snapshots anything — the objects belong to
 * whoever built them, and their `Set`s and strings can move afterwards.
 *
 * Two contributions naming one component of one package refuse here, wherever
 * they sat in the chain. A later one silently winning would make what a
 * document is told about a component depend on the order its host happened to
 * bootstrap packages in.
 */
export function* capturedDocumentation(
  read: DocumentationReader = packagedAssetReader,
): Operation<readonly DocumentationContribution[]> {
  const contributed = yield* Documentation.operations.contributions(read);
  const seen = new Map<string, string>();
  for (const one of contributed) {
    for (const name of one.supplies) {
      const owner = one.source.owner;
      const key = `${owner} ${name}`;
      const first = seen.get(key);
      if (first !== undefined && first !== one.source.asset) {
        throw new DocumentationIndexError(
          `${owner} contributes documentation for ${name} from both ${first} and ` +
            `${one.source.asset}. One component of one package has one documentation source, ` +
            "whichever order the packages bootstrapped in.",
        );
      }
      seen.set(key, one.source.asset);
    }
  }
  return snapshotContributions(contributed);
}
