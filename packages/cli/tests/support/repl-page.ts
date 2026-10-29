/**
 * What a person does at the mounted REPL, each act finished by what the screen shows.
 *
 * Every act is real input — keystrokes and pointer presses through the
 * terminal's own input — and every wait is a question about a completed
 * presentation, asked again each time another one completes. Nothing here
 * reaches the owner, holds an append or joins a teardown: a case that is about
 * one of those says so in its own body.
 */

import type { Operation } from "effection";

import { NARROW } from "../../src/repl/layout.ts";
import type { ReplTerminalSize } from "../../src/repl/terminal.ts";
import {
  coordinateOf,
  DRAFT_PROMPT,
  draftText,
  focusedField,
  focusedOn,
  MESSAGE_PROMPT,
  messageText,
  rowsShow,
  screenOf,
  sidekickColumn,
  sidekickPaneIn,
  untilShown,
} from "../fixtures/repl/issue-883/mounted-program.ts";
import type { Terminal } from "../fixtures/repl/issue-883/mounted-program.ts";

/** Send these bytes, and wait until the screen shows what they were for. */
export function* pressed(
  terminal: Terminal,
  bytes: string,
  what: string,
  shows: (terminal: Terminal) => boolean,
): Operation<void> {
  terminal.feed(bytes);
  yield* untilShown(terminal, what, shows);
}

/** Where the focus cue is drawn: every `>` on the screen, by row and column. */
function cue(terminal: Terminal): string {
  return screenOf(terminal)
    .map((line) => [...line.matchAll(/>/g)].map((found) => found.index).join(","))
    .join("|");
}

/**
 * Move focus one press at a time until it reaches what this names.
 *
 * Where focus lands is drawn by a frame after the one that first shows a
 * screen — at startup, after a resize, when a drawer closes — so a traversal
 * starts once the cue is drawn, and each press is done when the cue has moved.
 */
export function* traverse(
  terminal: Terminal,
  what: string,
  reached: (terminal: Terminal) => boolean,
  key = "\t",
): Operation<void> {
  yield* untilShown(terminal, `the focus cue, before moving it toward ${what}`, (one) =>
    screenOf(one).some((line) => /(?:^|\s)>(?:>|\s*\S)/.test(line)),
  );
  for (let press = 0; press < 240; press += 1) {
    if (reached(terminal)) {
      return;
    }
    const before = cue(terminal);
    yield* pressed(
      terminal,
      key,
      `a press moving focus toward ${what}`,
      (one) => cue(one) !== before,
    );
  }
  throw new Error(`focus never reached ${what} in 240 presses`);
}

/** Press at the cell this label is drawn in, at or right of `from`. */
export function* pointAt(terminal: Terminal, label: string, from = 0): Operation<void> {
  const at = coordinateOf(terminal, label, from);
  if (at === undefined) {
    throw new Error(
      `no control labelled ${label} is on the screen. rows=` +
        JSON.stringify(screenOf(terminal).filter((line) => line.trim().length > 0)),
    );
  }
  const before = terminal.drawn;
  yield* pressed(
    terminal,
    `\x1b[<0;${at.column + 1};${at.row + 1}M`,
    `the frame after pressing ${label}`,
    (one) => one.drawn > before,
  );
}

/** Tab to the Draft and type this into it. */
export function* typeDraft(terminal: Terminal, text: string): Operation<void> {
  yield* traverse(terminal, "the Draft", (one) => focusedField(one, DRAFT_PROMPT));
  const held = draftText(terminal);
  yield* pressed(
    terminal,
    text,
    `the Draft holding ${JSON.stringify(held + text)}`,
    (one) => draftText(one) === held + text,
  );
}

/**
 * Tab to the Draft, put this source in it and press Enter.
 *
 * Done when the Draft has taken the source; whether an entry was admitted is
 * the case's own question.
 */
export function* submitDraft(terminal: Terminal, source: string): Operation<void> {
  yield* traverse(terminal, "the Draft", (one) => focusedField(one, DRAFT_PROMPT));
  const held = draftText(terminal);
  yield* pressed(terminal, source, "the Draft taking the source", (one) => draftText(one) !== held);
  terminal.feed("\r");
}

/** Select the Sidekick by its tab, which gives its message box the focus. */
export function* selectSidekick(terminal: Terminal): Operation<void> {
  yield* traverse(terminal, "the Sidekick tab", (one) => focusedOn(one, "Sidekick"));
  yield* pressed(terminal, "\r", "the message box taking the focus its tab claimed", (one) =>
    focusedField(one, MESSAGE_PROMPT),
  );
}

/** Tab to the Sidekick's message box and type this into it. */
export function* typeMessage(terminal: Terminal, text: string): Operation<void> {
  yield* traverse(terminal, "the message box", (one) => focusedField(one, MESSAGE_PROMPT));
  const held = messageText(terminal);
  yield* pressed(terminal, text, `the message box holding ${JSON.stringify(held + text)}`, (one) =>
    messageText(one).includes(held + text),
  );
}

/**
 * Type a message and press the Sidekick pane's own Send, once the pane offers it.
 *
 * A reply can be drawn before its cycle ends, and until then the pane offers
 * Stop where Send was.
 */
export function* send(terminal: Terminal, text: string): Operation<void> {
  if (!focusedField(terminal, MESSAGE_PROMPT)) {
    yield* selectSidekick(terminal);
  }
  yield* typeMessage(terminal, text);
  yield* untilShown(terminal, "the Sidekick pane offering Send", (one) =>
    rowsShow(sidekickPane(one), "[send]"),
  );
  yield* pointAt(terminal, "[send]", sidekickColumn(terminal));
}

/** The Sidekick pane's own rows, beside nothing else. */
export function sidekickPane(terminal: Terminal): readonly string[] {
  return sidekickPaneIn(screenOf(terminal));
}

/** Shrink below the minimum, and hand back the refusal that size draws. */
export function* refusedAt(terminal: Terminal, size: ReplTerminalSize): Operation<string[]> {
  const before = terminal.drawn;
  terminal.resized(size);
  yield* untilShown(
    terminal,
    `the refusal at ${size.columns}x${size.rows}`,
    (one) => one.drawn > before && rowsShow(screenOf(one), `${NARROW.columns}x${NARROW.rows}`),
  );
  return screenOf(terminal);
}
