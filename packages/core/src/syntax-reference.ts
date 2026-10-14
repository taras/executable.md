/**
 * What a document may write here, as one thing an execution carries.
 *
 * `xmd syntax` answers that question for an environment nobody is running, and
 * canonical `<Syntax>` answers it for the site an element was actually written
 * at. Both reach the answer through the contextual `Syntax` Api, so there is
 * one construction and one renderer, and this module owns what that Api falls
 * back to when nothing nearer answers.
 *
 * Two references are built here. The execution's own is built from the
 * selection inputs it captured before any installation, middleware or document
 * code ran: the includes it resolves against, the registry it started with, the
 * identity components and exact Markdown its host declared, and the component
 * bundle it is closed over when it has one. A host's own is built from the lazy
 * source `useSyntax()` was handed, closed over the documentation contributions
 * that were in scope when it was called. `xmd plan` uses that one, because a
 * Plan is a program a later `xmd run` executes: the vocabulary the agent must
 * be shown is that profile's rather than the authorship execution's.
 *
 * Either way the reference holds the *default* answer, not the effective one.
 * It is reached through ordinary contextual dispatch, so nearer middleware can
 * answer instead, delegate to it, or transform what it returns — which is why
 * `documentation()` asks the Api for the symbols availability is decided
 * against rather than deciding that for itself.
 *
 * The reference admits nothing at all. It answers with symbols and with text.
 * Seeing a component named in either neither registers it, resolves it, nor
 * admits it: what a name means is still `selectComponent()`'s decision, and
 * what may run is still the execution's.
 */

import { type Operation, scoped } from "effection";
import { NamedBasis, Syntax } from "./syntax-api.ts";

import { inspectSyntax } from "./inspect.ts";
import type { SyntaxSymbols } from "./inspect.ts";
import { renderSelectedDocumentation } from "./syntax-markdown.ts";
import type { SelectedEntry } from "./syntax-markdown.ts";
import { documentationIndexFor } from "./component-documentation.ts";
import type { DocumentationContribution } from "./component-documentation.ts";
import type { DocumentationIndex } from "./documentation-index.ts";
import { UnknownComponentError } from "./documentation-index.ts";
import type { WorkflowComponentCatalog } from "./components/bundle.ts";
import type { ExecutionDeclaration } from "./execution-declarations.ts";
import type { IdentityComponent } from "./invocation-identity.ts";
import { SyntaxSelectionRefusal } from "./syntax-refusal.ts";
import type { ComponentOrigin, ComponentRegistry } from "./types.ts";

/**
 * The default description for the segments being expanded.
 *
 * Held by the execution and handed to core's own expansion by value, beside the
 * component resolution and the identity domains. It is not itself a Context: a
 * context resolves by name, and a name is not a secret, so a document could
 * build one and answer for the vocabulary it is shown. What a document *can*
 * reach is the public `Syntax` Api in front of it, which answers with text and
 * grants nothing.
 */
export interface SyntaxReference {
  /** The symbols this site describes, structured. */
  symbols(): Operation<SyntaxSymbols>;
  /**
   * The selected components' metadata and long-form documentation.
   *
   * Two inputs, not one, and this is the reason the reference is an object
   * rather than a value. *What may I write here* and *what may I read about*
   * are different questions, and a narrowing evaluation boundary answers them
   * differently on purpose: the vocabulary it admits is smaller than the
   * vocabulary an author is entitled to understand.
   *
   * So selection reads the **enclosing authoring symbols**, which is why a
   * nested Plan can be told how `<Elicit>` works even where it may not run one,
   * and each rendered entry states whether it is available in the current
   * evaluation. Collapsing the two would either hide reference material an
   * author needs or imply a permission they do not have.
   *
   * Availability is decided against the *effective* symbols, read once through
   * the Api, so a host or boundary that customized what may run here is the
   * same thing that decides what this annotation says.
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

/** The selection inputs an execution captured, as symbol construction reads them. */
export interface CapturedSymbolInputs {
  readonly includes: readonly string[];
  /** The registrations this execution started with, captured before it ran. */
  readonly registry: ComponentRegistry;
  readonly components: readonly IdentityComponent[];
  readonly declarations: readonly ExecutionDeclaration[];
  /** The bundle this execution is closed over, when a trusted host installed one. */
  readonly workflow?: WorkflowComponentCatalog;
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
  // Snapshotted once, here, so the contributions a reference reads are the
  // ones the collection boundary captured rather than whatever the caller's
  // objects hold by the time a document asks.
  const captured = snapshotContributions(contributions);
  // No admission at a root: nothing has narrowed what may execute, so the one
  // set of symbols this resolves is both what a document may write and what it
  // may read about.
  return referencing(() => derived(inputs), undefined, captured);
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
    *symbols(): Operation<SyntaxSymbols> {
      // A narrowed reference reports its admission and asks the enclosing
      // symbols for nothing — the bare form is about what runs. Otherwise this
      // is the default answer, and the basis below is consulted first so that
      // the one occurrence already resolving a basis gets that same value back
      // instead of resolving a moving root a second time.
      return admitted ?? (yield* NamedBasis.get()) ?? (yield* authoring());
    },
    documentation(names: readonly string[]): Operation<string> {
      return scoped(function* () {
        // One basis per occurrence, resolved here and published for the length
        // of this lookup only. Availability is then read through the Api, so a
        // host or boundary that customized what runs decides the annotation —
        // and when that read reaches *this* reference's default, it comes back
        // with the basis above rather than inspecting the root again. Two
        // occurrences enter two scopes and resolve independently.
        const readable = yield* authoring();
        yield* NamedBasis.set(readable);
        const runnable = yield* Syntax.operations.symbols;
        const index = documentationIndexFor(contributions);
        // Only the selection this module performs itself is restated under
        // core's own namespaced identity. Both symbol reads have already
        // returned, so nothing either of them raised can reach this.
        let selected;
        try {
          selected = select(readable, runnable, names, index);
        } catch (error) {
          if (error instanceof UnknownComponentError) {
            throw new SyntaxSelectionRefusal(error.message);
          }
          throw error;
        }
        return renderSelectedDocumentation(selected);
      });
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
      ? // One kind, two shapes: the engine names the construct it owns, and an
        // installation names the origin that declared it, so the two cannot
        // produce one identity.
        "construct" in origin
        ? [origin.construct]
        : [origin.origin]
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
    // Raised as the ordinary refusal it is. `documentation()` restates it under
    // core's own namespaced identity, because that is the one place that knows
    // the provider already returned successfully.
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

/**
 * The reference a host's own profile carries.
 *
 * What `useSyntax()` binds. The source is lazy for the reason the derived one
 * is — a command that never renders a description inspects nothing — and the
 * contributions are snapshotted here, from the scope that called the helper,
 * because a host that bootstrapped a profile and then handed over a bare
 * symbols callback would lose the index its own packages contributed.
 *
 * No admission: a host states one profile, and what narrows it afterwards is a
 * canonical evaluation boundary rather than this.
 */
export function profileSyntaxReference(
  source: () => Operation<SyntaxSymbols>,
  contributions: readonly DocumentationContribution[],
): SyntaxReference {
  return referencing(source, undefined, snapshotContributions(contributions));
}
