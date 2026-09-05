/**
 * What a document may write here, as one thing an execution carries.
 *
 * `xmd syntax` answers that question for an environment nobody is running.
 * Canonical `<Syntax>` answers it for the site an element was actually written
 * at, and the two have to be the same answer — a catalog an agent is shown and
 * a catalog an operator prints describe one vocabulary or they describe none.
 *
 * So there is one construction and one renderer, and this module is where an
 * execution keeps its own use of them. The observation is built from the
 * selection inputs the execution captured before any installation, middleware or
 * document code ran: the includes it resolves against, the registry it started
 * with, the identity components and exact Markdown its host declared, and the
 * component bundle it is closed over when it has one. Nothing is read from a
 * context, a registry answer, or anything a document can reach.
 *
 * A trusted host may state the catalog for its own profile instead. `xmd plan`
 * does: a Plan is written to be run by `xmd run`, so the vocabulary the agent
 * must be shown is the run profile's rather than the authorship execution's.
 * That contribution is captured with the rest of the installation, before any
 * installed code exists, and one execution accepts one — two are refused rather
 * than ordered, because ordering them would make which profile a document
 * observes depend on installation order.
 *
 * The observation carries no authority at all. It answers with text. Seeing a
 * component named in a catalog neither registers it, resolves it, nor authorizes
 * it: what a name means is still `selectComponent()`'s decision, and what may
 * run is still the execution's.
 */

import type { Operation } from "effection";

import { inspectSyntax } from "./inspect.ts";
import type { SyntaxCatalog } from "./inspect.ts";
import { renderSelectedDocumentation, renderSyntaxMarkdown } from "./syntax-markdown.ts";
import type { SelectedEntry } from "./syntax-markdown.ts";
import { documentationIndexFor } from "./component-documentation.ts";
import type { DocumentationIndex } from "./documentation-index.ts";
import { UnknownComponentError } from "./documentation-index.ts";
import type { WorkflowImportAuthority } from "./components/bundle.ts";
import type { DeclaredMarkdownComponent } from "./components/declared-markdown.ts";
import type { IdentityComponent } from "./invocation-identity.ts";
import type { ComponentRegistry } from "./types.ts";

/**
 * The catalog in scope for the segments being expanded.
 *
 * Held by the execution and handed to core's own expansion by value, beside the
 * import authority and the identity domains. It is not a Context: a context
 * resolves by name, and a name is not a secret, so a document could build one
 * and answer for the vocabulary it is shown.
 */
export interface CatalogObservation {
  /** The catalog this site describes, rendered as Markdown. */
  observe(): Operation<string>;
  /**
   * The selected components' metadata and long-form documentation.
   *
   * Two inputs, not one, and this is the reason the observation is an object
   * rather than a string. *What may I write here* and *what may I read about*
   * are different questions, and a narrowing evaluation boundary answers them
   * differently on purpose: the vocabulary it admits is smaller than the
   * vocabulary an author is entitled to understand.
   *
   * So selection reads the **enclosing authoring catalog**, which is why a
   * nested Plan can be told how `<Elicit>` works even where it may not run one,
   * and each rendered entry states whether it is available in the current
   * evaluation. Collapsing the two would either hide reference material an
   * author needs or imply an authority they do not have.
   */
  document(names: readonly string[]): Operation<string>;
}

/**
 * A trusted host's statement of the catalog its profile describes.
 *
 * Captured by value with the rest of the installation, before any installed
 * code, middleware or document code runs. It returns the catalog and core
 * renders it, so a host cannot make its profile print differently from the way
 * `xmd syntax` prints the same catalog.
 */
export type CatalogContribution = () => Operation<SyntaxCatalog>;

/** The selection inputs an execution captured, as catalog construction reads them. */
export interface CapturedCatalogInputs {
  readonly includes: readonly string[];
  /** The registrations this execution started with, captured before it ran. */
  readonly registry: ComponentRegistry;
  readonly components: readonly IdentityComponent[];
  readonly declarations: readonly DeclaredMarkdownComponent[];
  /** The bundle this execution is closed over, when a trusted host installed one. */
  readonly workflow?: WorkflowImportAuthority;
}

/**
 * The observation one execution's root carries.
 *
 * Nothing is built until an occurrence asks. An execution whose document never
 * writes `<Syntax>` enumerates no includes, parses no component and reads no
 * frontmatter, so carrying the observation costs a run that does not use it
 * nothing at all.
 *
 * Each ask builds afresh. Two authored occurrences are two observations, which
 * is what makes an occurrence's retained catalog its own rather than a copy of
 * whichever one ran first.
 */
export function rootCatalogObservation(
  inputs: CapturedCatalogInputs,
  contribution: CatalogContribution | undefined,
): CatalogObservation {
  function* current(): Operation<SyntaxCatalog> {
    return contribution === undefined ? yield* derived(inputs) : yield* contribution();
  }
  return {
    *observe(): Operation<string> {
      return renderSyntaxMarkdown(yield* current());
    },
    *document(names: readonly string[]): Operation<string> {
      // At the root the two inputs are one catalog: nothing has narrowed what
      // may execute, so what an author may read about and what they may run are
      // the same set, and every selected entry is available.
      const catalog = yield* current();
      const index = yield* documentationIndexFor();
      return renderSelectedDocumentation(select(catalog, catalog, names, index));
    },
  };
}

/**
 * The selected entries, in catalog order, with their documentation and
 * availability.
 *
 * `reference` is the catalog selection reads; `executable` is what the current
 * evaluation may actually run. At a root they are the same object. Under a
 * narrowing boundary they are not, and the difference is what each entry's
 * availability reports.
 */
export function select(
  reference: SyntaxCatalog,
  executable: SyntaxCatalog,
  names: readonly string[],
  index: DocumentationIndex,
): SelectedEntry[] {
  const requested = new Set(names);
  const runnable = new Set(
    executable.categories.flatMap((category) => category.entries.map((entry) => entry.name)),
  );
  const selected: SelectedEntry[] = [];
  // Walked in catalog order rather than request order, so two documents asking
  // for the same components in different orders render the same text — which is
  // what makes one occurrence's retained result comparable with another's.
  for (const category of reference.categories) {
    for (const entry of category.entries) {
      if (!requested.has(entry.name)) {
        continue;
      }
      requested.delete(entry.name);
      selected.push({
        entry,
        documentation: index.documentationFor(entry.name, entry.origin),
        available: runnable.has(entry.name),
      });
    }
  }
  // Whatever is left named nothing this site has. Refused whole rather than
  // rendered partially: a reader handed three of the four components they asked
  // about has no way to tell which request went unanswered.
  if (requested.size > 0) {
    throw new UnknownComponentError(
      `<Syntax> was asked to document ${[...requested].sort().join(", ")}, which ` +
        `${requested.size === 1 ? "is not a component" : "are not components"} available here.`,
    );
  }
  return selected;
}

function* derived(inputs: CapturedCatalogInputs): Operation<SyntaxCatalog> {
  return yield* inspectSyntax({
    includes: inputs.includes,
    registry: inputs.registry,
    components: inputs.components,
    declarations: inputs.declarations,
    ...(inputs.workflow === undefined ? {} : { workflow: inputs.workflow }),
  });
}

/**
 * An observation over a catalog a trusted boundary already decided.
 *
 * The narrowing seam. A canonical evaluation boundary that has already admitted
 * the exact vocabulary a subtree may write installs the corresponding catalog
 * for that subtree, and the enclosing observation is restored on leaving it. It
 * adds nothing: the catalog handed here is the admission's, so an entry that is
 * not in the admission cannot be in the observation.
 */
export function fixedCatalogObservation(
  catalog: SyntaxCatalog,
  /**
   * The authoring catalog this boundary is nested in.
   *
   * Where the two inputs come apart. `catalog` is what may *execute* here, and
   * this is what may be *read about* — the vocabulary of the site the evaluation
   * was written at. Omitted, the two are the same, which is the ordinary case
   * for a boundary that narrows nothing.
   *
   * A narrowing boundary passes both, and named selection then explains a
   * component this evaluation cannot run while saying so on the entry. Dropping
   * the enclosing catalog instead would leave a nested author unable to look up
   * the very components they are being asked to write about.
   */
  reference: SyntaxCatalog = catalog,
): CatalogObservation {
  const rendered = renderSyntaxMarkdown(catalog);
  return {
    // deno-lint-ignore require-yield
    *observe(): Operation<string> {
      return rendered;
    },
    *document(names: readonly string[]): Operation<string> {
      const index = yield* documentationIndexFor();
      return renderSelectedDocumentation(select(reference, catalog, names, index));
    },
  };
}
