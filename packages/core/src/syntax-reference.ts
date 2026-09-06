/**
 * What a document may write here, as one thing an execution carries.
 *
 * `xmd syntax` answers that question for an environment nobody is running.
 * Canonical `<Syntax>` answers it for the site an element was actually written
 * at, and the two have to be the same answer — symbols an agent is shown and
 * symbols an operator prints describe one vocabulary or they describe none.
 *
 * So there is one construction and one renderer, and this module is where an
 * execution keeps its own use of them. The reference is built from the
 * selection inputs the execution captured before any installation, middleware or
 * document code ran: the includes it resolves against, the registry it started
 * with, the identity components and exact Markdown its host declared, and the
 * component bundle it is closed over when it has one. Nothing is read from a
 * context, a registry answer, or anything a document can reach.
 *
 * A trusted host may state the symbols for its own profile instead. `xmd plan`
 * does: a Plan is written to be run by `xmd run`, so the vocabulary the agent
 * must be shown is the run profile's rather than the authorship execution's.
 * That provider is captured with the rest of the installation, before any
 * installed code exists, and one execution accepts one — two are refused rather
 * than ordered, because ordering them would make which profile a document is
 * shown depend on installation order.
 *
 * The reference carries no authority at all. It answers with text. Seeing a
 * component named in the symbols neither registers it, resolves it, nor
 * authorizes it: what a name means is still `selectComponent()`'s decision, and
 * what may run is still the execution's.
 */

import type { Operation } from "effection";

import { inspectSyntax } from "./inspect.ts";
import type { SyntaxSymbols } from "./inspect.ts";
import { renderSelectedDocumentation, renderSyntaxMarkdown } from "./syntax-markdown.ts";
import type { SelectedEntry } from "./syntax-markdown.ts";
import { documentationIndexFor } from "./component-documentation.ts";
import type { DocumentationContribution } from "./component-documentation.ts";
import type { DocumentationIndex } from "./documentation-index.ts";
import { UnknownComponentError } from "./documentation-index.ts";
import type { WorkflowImportAuthority } from "./components/bundle.ts";
import type { DeclaredMarkdownComponent } from "./components/declared-markdown.ts";
import type { IdentityComponent } from "./invocation-identity.ts";
import type { ComponentOrigin, ComponentRegistry } from "./types.ts";

/**
 * The symbols in scope for the segments being expanded.
 *
 * Held by the execution and handed to core's own expansion by value, beside the
 * import authority and the identity domains. It is not a Context: a context
 * resolves by name, and a name is not a secret, so a document could build one
 * and answer for the vocabulary it is shown.
 */
export interface SyntaxReference {
  /** The symbols this site describes, rendered as Markdown. */
  symbols(): Operation<string>;
  /**
   * The selected components' metadata and long-form documentation.
   *
   * Two inputs, not one, and this is the reason the reference is an object
   * rather than a string. *What may I write here* and *what may I read about*
   * are different questions, and a narrowing evaluation boundary answers them
   * differently on purpose: the vocabulary it admits is smaller than the
   * vocabulary an author is entitled to understand.
   *
   * So selection reads the **enclosing authoring symbols**, which is why a
   * nested Plan can be told how `<Elicit>` works even where it may not run one,
   * and each rendered entry states whether it is available in the current
   * evaluation. Collapsing the two would either hide reference material an
   * author needs or imply an authority they do not have.
   */
  documentation(names: readonly string[]): Operation<string>;
  /**
   * The reference for a subtree that may execute less than this site.
   *
   * The narrowing seam, and it belongs here rather than in the evaluator
   * because everything it needs is already here. A canonical evaluation
   * boundary that has admitted a vocabulary hands it over; what comes back
   * reports that vocabulary from `symbols()` and keeps *this* reference's
   * authoring symbols and documentation index for `documentation()`.
   *
   * Deriving it any other way would mean the evaluator recovering the raw
   * contributions and rebuilding an index — which is both a hole (that list is
   * execution-private for a reason) and a way for the two indexes to drift.
   * Narrowing what may run is not narrowing what may be read about, and the
   * reference is the thing that already knows both.
   */
  available(symbols: SyntaxSymbols): SyntaxReference;
}

/**
 * A trusted host's statement of the symbols its profile describes.
 *
 * Captured by value with the rest of the installation, before any installed
 * code, middleware or document code runs. It returns the symbols and core
 * renders them, so a host cannot make its profile print differently from the
 * way `xmd syntax` prints the same symbols.
 */
export type SyntaxSymbolsProvider = () => Operation<SyntaxSymbols>;

/** The selection inputs an execution captured, as symbol construction reads them. */
export interface CapturedSymbolInputs {
  readonly includes: readonly string[];
  /** The registrations this execution started with, captured before it ran. */
  readonly registry: ComponentRegistry;
  readonly components: readonly IdentityComponent[];
  readonly declarations: readonly DeclaredMarkdownComponent[];
  /** The bundle this execution is closed over, when a trusted host installed one. */
  readonly workflow?: WorkflowImportAuthority;
}

/**
 * The reference one execution's root carries.
 *
 * Nothing is built until an occurrence asks. An execution whose document never
 * writes `<Syntax>` enumerates no includes, parses no component and reads no
 * frontmatter, so carrying the reference costs a run that does not use it
 * nothing at all.
 *
 * Each ask builds afresh. Two authored occurrences are two references, which
 * is what makes an occurrence's retained symbols its own rather than a copy of
 * whichever one ran first.
 */
export function rootSyntaxReference(
  inputs: CapturedSymbolInputs,
  provider: SyntaxSymbolsProvider | undefined,
  /**
   * The documentation the installed packages contribute.
   *
   * Handed in rather than assumed, so a document's own named lookup reads the
   * index its profile assembled. Defaulting to none is what made an Agent
   * component answer with documentation on the command line and with the
   * fallback sentence inside a document.
   */
  contributions: readonly DocumentationContribution[] = [],
): SyntaxReference {
  function* current(): Operation<SyntaxSymbols> {
    return provider === undefined ? yield* derived(inputs) : yield* provider();
  }
  // Snapshotted once, here, so the contributions a reference reads are the
  // ones the collection boundary captured rather than whatever the caller's
  // objects hold by the time a document asks.
  const captured = snapshotContributions(contributions);
  // No admission at a root: nothing has narrowed what may execute, so the one
  // set of symbols this resolves is both what a document may write and what it
  // may read about.
  return referencing(current, undefined, captured);
}

/**
 * One reference over authoring symbols and executable ones.
 *
 * `authoring` is what named lookup reads and `admitted` is what may run. At a
 * root they are the same operation; a narrowed reference keeps the authoring
 * symbols and replaces the admitted ones, which is the whole of the seam.
 */
function referencing(
  /** The authoring symbols: what may be read about here. */
  authoring: () => Operation<SyntaxSymbols>,
  /**
   * What may *execute* here, when a boundary has narrowed it.
   *
   * Absent at a root, where the two are the same symbols — and must be the same
   * *value*. Resolving twice would call the trusted symbols provider twice
   * for one occurrence, and the environment could move between the two calls:
   * an entry's metadata would then come from different symbols than the
   * availability reported beside it.
   */
  admitted: SyntaxSymbols | undefined,
  contributions: readonly DocumentationContribution[],
): SyntaxReference {
  return {
    *symbols(): Operation<string> {
      // A narrowed reference reports its admission and asks the enclosing
      // symbols for nothing — the bare form is about what runs.
      return renderSyntaxMarkdown(admitted ?? (yield* authoring()));
    },
    *documentation(names: readonly string[]): Operation<string> {
      // One resolution, both decisions.
      const readable = yield* authoring();
      const runnable = admitted ?? readable;
      const index = documentationIndexFor(contributions);
      return renderSelectedDocumentation(select(readable, runnable, names, index));
    },
    available(next: SyntaxSymbols): SyntaxReference {
      // The enclosing authoring symbols and the enclosing contributions,
      // unchanged. Only what may execute is replaced, so a nested author keeps
      // the documentation they had and every entry reports its availability
      // against the admission.
      return referencing(authoring, next, contributions);
    },
  };
}

/**
 * One symbol entry's identity: its name and its complete origin.
 *
 * Every member of the origin participates, not just its kind — a workflow blob
 * differs from another by `sourceHash`, a declared component by `digest`, two
 * registrations by their package and whether either is reserved. Comparing any
 * less would let a component that merely resembles the admitted one report
 * itself as admitted.
 */
function identityOf(entry: { name: string; origin: ComponentOrigin }): string {
  const origin = entry.origin;
  const parts: readonly string[] =
    origin.kind === "structural"
      ? [origin.construct]
      : origin.kind === "repository"
        ? [origin.path]
        : origin.kind === "registered"
          ? [origin.origin, String(origin.reserved)]
          : origin.kind === "protected"
            ? [origin.origin]
            : origin.kind === "workflow"
              ? [origin.path, origin.sourceHash]
              : [origin.origin, origin.digest];
  // Length-prefixed, so no member's content can spell a separator and make two
  // different identities collide.
  return [entry.name, origin.kind, ...parts].map((part) => `${part.length}:${part}`).join("");
}

/**
 * The selected entries, in symbol order, with their documentation and
 * availability.
 *
 * `authoring` is what selection reads; `admitted` is what the current
 * evaluation may actually run. At a root they are the same object. Under a
 * narrowing boundary they are not, and the difference is what each entry's
 * availability reports.
 */
export function select(
  authoring: SyntaxSymbols,
  admitted: SyntaxSymbols,
  names: readonly string[],
  index: DocumentationIndex,
): SelectedEntry[] {
  const requested = new Set(names);
  // Keyed by identity, not by name. A name is a spelling, and the whole point of
  // the two inputs is that the enclosing symbols may hold a *different*
  // component under the same one: an authoring entry for the built-in `Elicit`
  // beside an admitted repository `Elicit.md` is two components. Reporting the
  // authoring entry as available because something called `Elicit` can run
  // would tell an author they may execute the thing they were just shown.
  const runnable = new Set(
    admitted.categories.flatMap((category) => category.entries.map(identityOf)),
  );
  const selected: SelectedEntry[] = [];
  // Walked in symbol order rather than request order, so two documents asking
  // for the same components in different orders render the same text — which is
  // what makes one occurrence's retained result comparable with another's.
  for (const category of authoring.categories) {
    for (const entry of category.entries) {
      // Components only. `names` is a component lookup under the current
      // contract, so a structural construct is not a thing this can select —
      // and skipping it here leaves the name in `requested`, which refuses
      // below rather than silently rendering nothing for it.
      if (!requested.has(entry.name) || entry.kind === "structural") {
        continue;
      }
      requested.delete(entry.name);
      selected.push({
        entry,
        documentation: index.documentationFor(entry.name, entry.origin),
        available: runnable.has(identityOf(entry)),
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

function* derived(inputs: CapturedSymbolInputs): Operation<SyntaxSymbols> {
  return yield* inspectSyntax({
    includes: inputs.includes,
    registry: inputs.registry,
    components: inputs.components,
    declarations: inputs.declarations,
    ...(inputs.workflow === undefined ? {} : { workflow: inputs.workflow }),
  });
}

/**
 * A defensive copy of what a caller handed the installation boundary.
 *
 * Field by field, and the name set materialized into one this module owns. A
 * contribution is a caller's object: the array can be reordered, the source
 * replaced, the `Set` added to after capture, and an iterable can answer
 * differently the second time it is walked. Retaining any of those would make
 * what a document is told about the product depend on what its host did
 * afterwards.
 */
export function snapshotContributions(
  contributions: readonly DocumentationContribution[],
): readonly DocumentationContribution[] {
  return Object.freeze(
    [...contributions].map((one) =>
      Object.freeze({
        source: Object.freeze({
          owner: String(one.source.owner),
          asset: String(one.source.asset),
          text: String(one.source.text),
        }),
        supplies: new Set([...one.supplies].map((name) => String(name))),
      }),
    ),
  );
}

/**
 * A reference over symbols a trusted boundary already decided.
 *
 * The narrowing seam. A canonical evaluation boundary that has already admitted
 * the exact vocabulary a subtree may write installs the corresponding symbols
 * for that subtree, and the enclosing reference is restored on leaving it. It
 * adds nothing: the symbols handed here are the admission's, so an entry that is
 * not in the admission cannot be in the reference.
 */
export function syntaxReference(
  admitted: SyntaxSymbols,
  /**
   * The authoring symbols this boundary is nested in.
   *
   * Where the two inputs come apart. `admitted` is what may *execute* here, and
   * this is what may be *read about* — the vocabulary of the site the evaluation
   * was written at. Omitted, the two are the same, which is the ordinary case
   * for a boundary that narrows nothing.
   *
   * A narrowing boundary passes both, and named selection then explains a
   * component this evaluation cannot run while saying so on the entry. Dropping
   * the enclosing symbols instead would leave a nested author unable to look up
   * the very components they are being asked to write about.
   */
  authoring: SyntaxSymbols = admitted,
  /**
   * The enclosing execution's documentation contributions, carried across the
   * seam.
   *
   * Narrowing what may *execute* does not narrow what an author may read about:
   * the enclosing authoring documentation travels in with the enclosing
   * symbols, so a nested author keeps the reference material they had. #713
   * installs the executable symbols; this is the index that goes with it.
   */
  contributions: readonly DocumentationContribution[] = [],
): SyntaxReference {
  const captured = snapshotContributions(contributions);
  return referencing(
    // deno-lint-ignore require-yield
    function* () {
      return authoring;
    },
    admitted,
    captured,
  );
}
