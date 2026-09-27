/**
 * Everything this product can be asked to do.
 *
 * Closed, and the only vocabulary that crosses from the component tree to the
 * root. A component turns a normalized key, a piece of text or a pointer into
 * one of these; the root is the only thing that decides what any of them changes.
 * Nothing below the root holds the session, the repository, the route or a host
 * operation, so a component cannot act — it can only ask.
 *
 * Every member says what was asked for and names the thing it was asked about.
 * None of them carries a model object, because the root already has the model
 * and a component's copy of one could be a frame out of date.
 */

import type { ReplDrawerRef, ReplSurface } from "../route.ts";

export type ReplAction =
  /** Text for whichever field has focus. */
  | { readonly kind: "type"; readonly text: string }
  /** Remove the last decoded text unit from whichever field has focus. */
  | { readonly kind: "erase" }
  /** Admit the draft as this execution's one entry. */
  | { readonly kind: "submit" }
  | { readonly kind: "select-surface"; readonly surface: ReplSurface }
  /** Select a structural scope by its key path, outermost first. */
  | { readonly kind: "select-scope"; readonly scopes: readonly string[] }
  | { readonly kind: "open-drawer"; readonly drawer: ReplDrawerRef }
  /** Close the innermost open drawer. Never an answer to anything. */
  | { readonly kind: "close-drawer" }
  /** Freeze the view at one history position. */
  | { readonly kind: "select-marker"; readonly marker: string }
  /** Return to the Journal head. */
  | { readonly kind: "go-live" }
  | { readonly kind: "pause" }
  | { readonly kind: "continue" }
  /** Answer the question waiting right now. */
  | { readonly kind: "answer" };
