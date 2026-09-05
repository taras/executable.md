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
import { renderSyntaxMarkdown } from "./syntax-markdown.ts";
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
  return {
    *observe(): Operation<string> {
      return renderSyntaxMarkdown(
        contribution === undefined ? yield* derived(inputs) : yield* contribution(),
      );
    },
  };
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
export function fixedCatalogObservation(catalog: SyntaxCatalog): CatalogObservation {
  const rendered = renderSyntaxMarkdown(catalog);
  return {
    // deno-lint-ignore require-yield
    *observe(): Operation<string> {
      return rendered;
    },
  };
}
