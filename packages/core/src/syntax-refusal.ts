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
 * run's infrastructure failing, not a mistake the candidate that wrote the
 * request can correct. Recovering one as the other would hand a broken
 * installation back to an agent as retry context.
 *
 * So this is recognized while the original is still in hand, inside the
 * executor, by `instanceof` — which no provider can satisfy — and only the
 * *conclusion* travels out, in a variable core's own closure owns. It is raised
 * strictly around the selection core performs itself, after the provider has
 * already returned successfully.
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
