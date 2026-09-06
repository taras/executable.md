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
 *
 * **A contribution of the same value already in the chain is not appended
 * twice.** One package's declarative vocabulary is deliberately entered at more
 * than one layer — the repository-composition set by an ordinary run's bootstrap
 * *and* again inside a workflow attachment, because either may be the only one;
 * a nested run or evaluation host the same way — and the inner scope descends
 * from the outer, so both wrappers are in one chain. Appending the second would
 * refuse at collection, which turns valid layering into a failure while there is
 * no ambiguity to resolve: a repetition of the same value says exactly what the
 * first one said, and there is no winner to pick. So it coalesces, and the
 * repeated bootstrap keeps both its registrations and one documentation value.
 *
 * Equality is by value over all four of {@link identical}'s inputs. Anything
 * short of that — matching on the asset alone, say — would coalesce two
 * bootstraps that genuinely disagree, and silently keep whichever ran first.
 */
export function* contributeDocumentation(
  contribute: (read: DocumentationReader) => Operation<DocumentationContribution>,
): Operation<void> {
  yield* Documentation.around({
    *contributions([read], next): Operation<readonly DocumentationContribution[]> {
      const enclosing = yield* next(read);
      const mine = yield* contribute(read);
      return enclosing.some((one) => identical(one, mine)) ? enclosing : [...enclosing, mine];
    },
  });
}

/**
 * Whether two contributions are the same value.
 *
 * All four of what a contribution *is*: the owning package, the asset identity,
 * the exact documentation text, and the set of components it accounts for. The
 * text is not redundant with the asset — two bootstraps can name one path and
 * read different bytes, from a stale build tree or a substituted reader — and
 * coalescing those would pick a winner silently, which is the whole thing this
 * boundary exists to prevent.
 *
 * Compared by value, not by identity: each bootstrap builds a fresh object, and
 * a `Set` has no order, so two contributions listing the same names in different
 * orders are the same statement.
 */
function identical(one: DocumentationContribution, other: DocumentationContribution): boolean {
  return (
    one.source.owner === other.source.owner &&
    one.source.asset === other.source.asset &&
    one.source.text === other.source.text &&
    sameNames(one.supplies, other.supplies)
  );
}

/** Two name sets holding the same names, whatever order they were built in. */
function sameNames(one: ReadonlySet<string>, other: ReadonlySet<string>): boolean {
  return one.size === other.size && [...one].every((name) => other.has(name));
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
 * Two contributions that *disagree* about one component of one package refuse
 * here, wherever they sat in the chain. A later one silently winning would make
 * what a document is told about a component depend on the order its host
 * happened to bootstrap packages in.
 *
 * Only a disagreement reaches this far: a repetition of the same value never
 * arrives, because `contributeDocumentation()` recognizes its own statement in
 * the chain and does not append it twice. What is left overlaps on one owning
 * package and one component name while differing in asset, text or the set of
 * components accounted for. Two *different owners* documenting a same-spelled
 * component is not a conflict — documentation joins by name and origin — and
 * neither is one owner accounting for disjoint sets from two files.
 *
 * Collection is where a disagreement is caught, because it is the only boundary
 * every execution passes through. Deferring it to the named form's index would
 * let a document that writes bare `<Syntax />`, or no `<Syntax>` at all, run to
 * completion on an assembly nobody validated.
 */
export function* capturedDocumentation(
  read: DocumentationReader = packagedAssetReader,
): Operation<readonly DocumentationContribution[]> {
  const contributed = yield* Documentation.operations.contributions(read);
  // Keyed by owning package *and* component name, because that pair is what
  // documentation joins on. Two packages may document same-spelled components,
  // and one package may account for disjoint sets from two files; neither is a
  // question anyone has to answer, so neither is a conflict.
  const seen = new Map<string, DocumentationContribution>();
  for (const one of contributed) {
    for (const name of one.supplies) {
      const owner = one.source.owner;
      const first = seen.get(`${owner} ${name}`);
      if (first !== undefined) {
        throw new DocumentationIndexError(
          `${owner} contributes documentation for ${name} twice, and the two ` +
            `contributions are not the same: ${difference(first, one)}. One component of ` +
            "one package has one documentation value, whichever order the bootstraps " +
            "supplied it — so there is no winner to pick.",
        );
      }
      seen.set(`${owner} ${name}`, one);
    }
  }
  return snapshotContributions(contributed);
}

/**
 * What two conflicting contributions disagree about, for the refusal to name.
 *
 * An identical pair never reaches this — `contributeDocumentation()` coalesces
 * those — so at least one of the three differs, and saying which is the
 * difference between a diagnosis and a complaint.
 */
function difference(first: DocumentationContribution, second: DocumentationContribution): string {
  if (first.source.asset !== second.source.asset) {
    return `they name different assets, ${first.source.asset} and ${second.source.asset}`;
  }
  if (first.source.text !== second.source.text) {
    return `both name ${first.source.asset}, but its text differs between them`;
  }
  return (
    `both name ${first.source.asset} with the same text, but they account for ` +
    "different components"
  );
}
