/**
 * The refusal core raises when a documentation request names a component this
 * site does not have.
 *
 * Its own module, importing nothing, because both ends of the contract need it:
 * `syntax-reference.ts` raises it and `components/Syntax.ts` recognizes it, and
 * those two already reach each other through the protected tier. Sharing it
 * from either side would close that loop.
 *
 * ## Why it is a class, recognized before the durable boundary
 *
 * `<Syntax>` persists its lookup, and a failure crossing that boundary is
 * rebuilt: the class is gone, `instanceof` is false, and only the message and
 * the declared name survive. Both of those are things a *symbols provider*
 * could produce for a failure of its own — and a provider that throws is this
 * run's infrastructure failing rather than a refusal of what the request asked
 * for. Reading one as the other would state something untrue about the request.
 *
 * So it is recognized while the original is still in hand, inside the durable
 * executor, by `instanceof` — which no provider can satisfy. It is raised
 * strictly around the selection core performs itself, after the provider has
 * already returned successfully.
 *
 * ## How the conclusion survives replay
 *
 * Not as an error. The executor turns a recognized refusal into the retained
 * value `{ refused }`, and `components/Syntax.ts` re-raises it — marked — when
 * that value is read back, which happens after the durable operation returns on
 * a live run and on a replay alike. A refusal that could not be published is
 * therefore never interpreted at all.
 *
 * The namespaced name is for a reader looking at a diagnostic. Nothing decides
 * anything by comparing it.
 */

/** The namespaced name a selection refusal declares, for diagnostics alone. */
export const SYNTAX_SELECTION_REFUSAL = "executablemd.core.syntax-selection-refusal";

/** One documentation selection core refused. */
export class SyntaxSelectionRefusal extends Error {
  override name = SYNTAX_SELECTION_REFUSAL;
}
