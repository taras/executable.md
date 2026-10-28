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

import type { ReplDrawerRef, ReplPane, ReplSurface } from "../route.ts";

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
  /**
   * Ask the Sidekick for what the message box holds.
   *
   * Its own member rather than `submit`, because the two destinations are two
   * things: Run admits a document as an entry, and this sends a message to a
   * conversation. One action meaning either would be decided by whichever text
   * the reducer happened to look at.
   */
  | { readonly kind: "send-message" }
  /**
   * Stop whatever the Sidekick is doing.
   *
   * Only the Sidekick. An entry it already admitted belongs to the session and
   * goes on running, and leaving the command is `exit` — a control that meant
   * all three would be three decisions behind one key.
   */
  | { readonly kind: "stop-sidekick" }
  /**
   * Stop this exact entry's execution, and join everything it owned.
   *
   * Only that entry, and only the one this frame drew the control against: a
   * press that arrives after it has finished, or from a frozen reading of an
   * older one, names an entry the session is no longer running and stops
   * nothing. It carries no record and no outcome — what a stopped entry
   * retains is the root's to write, through the journal that root owns.
   */
  | { readonly kind: "stop-entry"; readonly entry: string }
  /**
   * Open the Entries catalog over this reading.
   *
   * Presentation and a selection of the Entries reading, and nothing else: no
   * scope, marker, conversation filter or draft moves, and nothing is
   * submitted, appended or asked of a provider. What changes a destination is
   * activating a row inside it.
   */
  | { readonly kind: "open-catalog" }
  /** Put the Entries catalog away, leaving the reading exactly as it stands. */
  | { readonly kind: "close-catalog" }
  | { readonly kind: "select-surface"; readonly surface: ReplSurface }
  /**
   * Read one of the two right-hand panes.
   *
   * One member for both, because they are one choice: activating the Sidekick
   * selects it as the reading as well, and activating Bindings puts the saved
   * surface back. Two actions would be two places deciding one rule.
   */
  | { readonly kind: "select-pane"; readonly pane: ReplPane }
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
  /**
   * Open the Sidekick's own question, which this key names.
   *
   * The key travels because the question it names is the only one this opens:
   * a reply may finish and ask again while somebody is reaching for the
   * control, and an opener that meant "whatever is pending" would open a
   * different question from the one it was drawn for.
   */
  | { readonly kind: "open-sidekick-question"; readonly question: string }
  /** Hide the Sidekick's question form, leaving the question pending. */
  | { readonly kind: "close-sidekick-question" }
  /** Give one field of the Sidekick's own form the focus text acts on. */
  | {
      readonly kind: "select-sidekick-field";
      readonly question: string;
      readonly field: string;
    }
  /** Put one offered value into one field of the Sidekick's own form. */
  | {
      readonly kind: "choose-sidekick";
      readonly question: string;
      readonly field: string;
      readonly option: string;
    }
  /** Answer the Sidekick's own question this key names, from its form. */
  | { readonly kind: "answer-sidekick"; readonly question: string }
  /**
   * Open Configure for this conversation, inspecting what its agent offers.
   *
   * The conversation travels because the choices belong to it: a drawer opened
   * for one conversation cannot be applied to another, and a reply that
   * finished and started a new one while somebody was reaching for this
   * control would otherwise be configured by it.
   */
  | { readonly kind: "open-configure"; readonly conversation: string | undefined }
  /** Ask the agent again for what it offers, explicitly. */
  | { readonly kind: "refresh-configure" }
  /** Hide Configure, discarding whatever was chosen and not applied. */
  | { readonly kind: "close-configure" }
  /** Choose one model, by the exact id the provider named. */
  | { readonly kind: "choose-model"; readonly model: string }
  /** Choose one effort level, which belongs to the model chosen now. */
  | { readonly kind: "choose-effort"; readonly effort: string }
  /** Give the agent-name field the focus text and Backspace act on. */
  | { readonly kind: "name-agent" }
  /** Save what Configure holds: a preference, or a replacement conversation. */
  | { readonly kind: "apply-configure" }
  /**
   * Send the saved failed request this names again, as a new message.
   *
   * Its conversation and message id, because that is what names one saved
   * request: the text is not evidence of which one, and two requests may read
   * identically.
   */
  | {
      readonly kind: "retry-message";
      readonly conversation: string;
      readonly message: number;
    }
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
   * Move the Sidekick question form's own window by whole lines.
   *
   * Its own member for the same reason `scroll-sessions` is: the two question
   * forms have two windows and two offsets, and one action meaning either would
   * move whichever the reducer guessed.
   */
  | { readonly kind: "scroll-sidekick-question"; readonly delta: number }
  /**
   * Move Configure's own window by whole lines.
   *
   * Its own member for the same reason the question form's is: Configure is a
   * pane-local drawer with a window of its own, and an agent that advertises
   * more choices than it can draw has choices only scrolling can reach.
   */
  | { readonly kind: "scroll-configure"; readonly delta: number }
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
   * Move the entry reading by whole rows.
   *
   * Its own member for the same reason the other two are: the transcript's
   * reading, the catalog and a drawer's question can all be open at once, and
   * one action meaning whichever the reducer guessed would move a region the
   * reader was not pointing at.
   */
  | { readonly kind: "scroll-reading"; readonly delta: number }
  /**
   * Open the chat that holds this saved Sidekick turn, and bring it into view.
   *
   * Its chat and its canonical ordinal, because that is what names one saved
   * turn: a title is not evidence of which one, and two turns may read
   * identically. It selects a *reading*, so it starts nothing, sends nothing
   * and changes no conversation anybody may continue.
   */
  | {
      readonly kind: "read-sidekick-turn";
      readonly conversation: string;
      /**
       * Its canonical ordinal, or none for work no record holds yet.
       *
       * None still opens the chat — that is where the turn is — and brings
       * nothing into view, because there is no saved row to bring. A predicted
       * ordinal would be a statement about whichever turn this conversation
       * happened to be on.
       */
      readonly turn: number | undefined;
    }
  /**
   * Stop reading a saved chat and go back to the current one.
   *
   * Only the selector: the Sidekick stays the selected reading, the saved
   * surface, the entry, the filter and the history position are untouched, and
   * the current message draft comes back exactly as it was.
   */
  | { readonly kind: "read-current-chat" }
  /**
   * Move the Sidekick's chat by whole rows.
   *
   * Its own member for the same reason `scroll-sessions` is: a wide frame has
   * the Sessions reading and a chat open at once, and one action meaning either
   * would move whichever the reducer guessed.
   */
  | { readonly kind: "scroll-sidekick"; readonly delta: number }
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
  /**
   * Show the Transcript's conversation choices, or put them away again.
   *
   * Presentation and nothing else: it starts no provider, writes no record and
   * changes no filter. Closing the choices leaves whichever conversation is
   * chosen exactly as it stands, because dismissing a chooser is not a choice.
   */
  | { readonly kind: "toggle-session-filter" }
  /** Open the drawer over the one pending permission request this key names. */
  | { readonly kind: "select-permission"; readonly request: string }
  /** Answer the selected request with one option the provider offered. */
  | {
      readonly kind: "choose-permission";
      readonly request: string;
      readonly option: string;
    }
  /** Dismiss the selected request, which denies it while the session runs on. */
  | { readonly kind: "dismiss-permission"; readonly request: string }
  /**
   * Leave the REPL.
   *
   * Lifecycle and nothing else. It is not an answer to a question, a decision
   * about a permission request or an outcome for an entry: a person who is
   * finished with a terminal has not said yes, no, or cancelled to anything that
   * was waiting, and a command that recorded one of those on their behalf would
   * be inventing a decision nobody made.
   */
  | { readonly kind: "exit" };
