/**
 * What a person meant, said as intent.
 *
 * An action names *what should happen* — pause the run, go back, move focus —
 * and never how it was asked for or what it would take to do it. No key code, no
 * node, no route, no journal record. That is the whole of why the same control
 * can be reached with the keyboard and with a pointer and produce one thing:
 * there is nothing in an action for the two to differ about.
 *
 * An action is dispatched on the scope of the node it came from, so every
 * branch between that node and the root sees it on the way up. A branch may
 * **own** one — consuming it, or translating it into the action it really means
 * in that context — and what survives reaches the application root, which is
 * the only thing that turns an action into a new state.
 *
 * Reaching the default means nothing owned it. That throws rather than passing
 * quietly, because an interface that dispatches an action nobody implements is
 * broken in a way silence would hide until somebody noticed the button did
 * nothing.
 */

import { createApi } from "effection/experimental";

export type ReplAction =
  /** Pause a live run. */
  | { readonly kind: "pause" }
  /** Resume a paused one. */
  | { readonly kind: "continue" }
  /** Leave a reconstruction and stand at the paused head again. */
  | { readonly kind: "return-to-head" }
  /** Open a reconstruction of the selected recorded moment. */
  | { readonly kind: "inspect" }
  /** Undo one step of where you are, never of what has happened. */
  | { readonly kind: "back" }
  /** Close the drawer that is open, which is what Back means inside one. */
  | { readonly kind: "close-drawer" }
  /** Move focus, in the tree's own terms rather than the ring's implementation. */
  | { readonly kind: "focus"; readonly move: "next" | "previous" | "owner" }
  /**
   * The ones a real execution owns.
   *
   * Every one of these is a thing the interface offers and this study cannot
   * perform: submitting an entry, forking a recorded moment, answering a
   * suspension. They are still actions — the control emits one, the root owns
   * it, and what the root does is refuse in a way a person can see. Leaving
   * them unwired would have been a button that silently does nothing, which is
   * the failure the whole action boundary exists to make impossible.
   */
  | { readonly kind: "run" }
  | { readonly kind: "fork" }
  | { readonly kind: "submit" }
  | { readonly kind: "approve" }
  | { readonly kind: "request-changes" }
  | { readonly kind: "stop" }
  | { readonly kind: "decline" }
  | { readonly kind: "disclose-schema" };

/** An action that reached the root without anything owning it. */
export class UnownedActionError extends Error {
  constructor(action: ReplAction) {
    super(`nothing owns the action ${JSON.stringify(action)}`);
    this.name = "UnownedActionError";
  }
}

export const ReplActionApi = createApi("xmd:repl:action", {
  dispatch(action: ReplAction): void {
    throw new UnownedActionError(action);
  },
});
