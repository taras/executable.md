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
  /**
   * Text for one named field, or for the entry draft when it names none.
   *
   * The name travels with the text because focus belongs to the mounted tree
   * and this vocabulary does not: a control that emitted bare text would have
   * its characters delivered to whichever field the application last recorded,
   * which is not necessarily the one under the cursor.
   */
  | { readonly kind: "type"; readonly text: string; readonly field?: string }
  /** Remove the last Unicode scalar value from one named field, or the draft. */
  | { readonly kind: "erase"; readonly field?: string }
  /** Admit the draft as this execution's next entry. */
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
  /** Answer the question waiting right now, from the form as it stands. */
  | { readonly kind: "answer" }
  /** Give this form field the focus that text and Backspace act on. */
  | { readonly kind: "select-field"; readonly field: string }
  /** Put one offered enum value into one field. */
  | { readonly kind: "choose"; readonly field: string; readonly option: string }
  /**
   * Move the read-only message region by whole lines.
   *
   * A delta rather than a position, because the control that emits it knows
   * which way it points and nothing else: how far the region can go is the
   * frame's to decide, and clamping belongs where the height is known.
   */
  | { readonly kind: "scroll"; readonly delta: number }
  /**
   * Move the Sessions reading by whole rows.
   *
   * Its own member rather than `scroll`, because the two windows are open at
   * once: a drawer scrolls the question it is asking while the reading behind it
   * keeps the row somebody left it on, and one action meaning either would move
   * whichever the reducer guessed.
   */
  | { readonly kind: "scroll-sessions"; readonly delta: number }
  /**
   * Move the Entries catalog by whole rows.
   *
   * Its own member for the same reason `scroll-sessions` is: a wide frame has
   * both readings open at once, and one action meaning either would move
   * whichever the reducer guessed rather than the list the control belongs to.
   */
  | { readonly kind: "scroll-entries"; readonly delta: number }
  /**
   * Show only the conversation this provider session key names.
   *
   * The key and nothing else: which turns that is, and whether the key still
   * names a conversation at all, is the root's to resolve against the reading it
   * holds.
   */
  | { readonly kind: "select-session"; readonly session: string }
  /** Show every conversation again. Distinct from selecting one, so it cannot be a key nobody has. */
  | { readonly kind: "all-sessions" }
  /** Open the drawer over the one pending permission request this key names. */
  | { readonly kind: "select-permission"; readonly request: string }
  /** Answer the selected request with one option the provider offered. */
  | {
      readonly kind: "choose-permission";
      readonly request: string;
      readonly option: string;
    }
  /** Dismiss the selected request, which denies it while the session runs on. */
  | { readonly kind: "dismiss-permission"; readonly request: string };
