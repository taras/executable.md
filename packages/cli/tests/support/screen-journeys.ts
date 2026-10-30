/**
 * The words this product draws, and the keyboard routes a person takes to them.
 *
 * Every helper here is built from `support/repl-page.ts`'s own readings:
 * `shows`, `occurrences`, `found`, `locate` and the three scopes. None of them
 * counts a border, reads a focus cue, names a terminal column or builds a view,
 * and none of them searches for focus at run time: a route is a key count
 * measured on a fresh mount from a named opening state, written down here with
 * the receipt that measured it.
 *
 * Labels and headings are product text. A product that renames one renames it
 * here, which is the coupling a person's own reading already has.
 */

import { race, sleep, withResolvers } from "effection";
import type { Operation } from "effection";

import { ReplTerminal } from "../../src/repl/terminal.ts";
import { MOUNTED_DEADLINE_MS } from "./mounted-repl.ts";
import type { Terminal } from "./mounted-repl.ts";
import type { ReplPage, ScreenReading, ScreenScope } from "./repl-page.ts";

/** The Draft's own heading, which its Send shares a row with. */
export const DRAFT = " DRAFT";

/** The Sidekick tab, which its own Send is drawn below and right of. */
export const SIDEKICK = "SIDEKICK";

/** The other tab of that pane, whose selection takes the Sidekick's place. */
export const BINDINGS = "BINDINGS";

/** What the Sidekick's composer invites, which is the pane's own prompt. */
export const COMPOSER = "message the sidekick";

/** The Sidekick's own Send and Stop, by the one bounded layout statement available. */
export const SIDEKICK_PANE: ScreenScope = { after: SIDEKICK, rightOf: SIDEKICK };

/**
 * The rows the Sidekick's composer draws its own value on.
 *
 * Its prompt is drawn once, and the value sits under it, so the rows below that
 * prompt are the composer's own. A pane scope cannot say this: the composer's
 * value begins at column 104 while the tab above it begins at 106, so a floor
 * taken from the tab excludes the field. Measured at 160x36.
 */
export const COMPOSER_VALUE: ScreenScope = { after: COMPOSER };

/**
 * The rows the Draft draws its own value on.
 *
 * Below its heading, which is where a field of this product puts its value. The
 * composer's rows are below it too, so a case that must tell one field from the
 * other asks for this and for {@link COMPOSER_VALUE} being empty of it.
 */
export const DRAFT_VALUE: ScreenScope = { after: DRAFT };

/**
 * The Sidekick's own Send and Stop, found from its composer rather than its tab.
 *
 * The composer's prompt is drawn once wherever that field exists, and the
 * pane's controls are right of its own first cell while the Draft's are left of
 * it — measured at 160x36: the prompt at column 108, this pane's Send at 153,
 * the Draft's at 94. A drawer of this pane covers its tab but not the composer,
 * so this scope keeps answering while {@link SIDEKICK_PANE} cannot.
 */
export const SIDEKICK_CONTROLS: ScreenScope = { rightOf: COMPOSER };

/** The guidance row says this while the Draft takes keystrokes, and not otherwise. */
export const TYPING = "Type here";

/** How the History rail marks an entry that reached each outcome. */
export const RAIL: Readonly<Record<string, string>> = Object.freeze({
  ok: "✓",
  err: "×",
  cancelled: "-",
  unfinished: "●",
});

/** Send one Tab and wait for the screen it draws. */
export function* tab(page: ReplPage): Operation<void> {
  const before = page.screen().index;
  yield* page.key("Tab");
  yield* page.until("the screen after a Tab", (one) => one.index > before);
}

/** Send one Backspace and wait for the screen it draws. */
export function* backspace(page: ReplPage): Operation<void> {
  const before = page.screen().index;
  yield* page.key("Backspace");
  yield* page.until("the screen after a Backspace", (one) => one.index > before);
}

/** Type into whatever holds the keystrokes, and wait until the screen shows it. */
export function* typed(page: ReplPage, text: string): Operation<void> {
  yield* page.type(text);
  yield* page.until(`the screen showing ${JSON.stringify(text)}`, (one) => one.shows(text));
}

/**
 * Walk the focus ring to the Draft.
 *
 * The product advertises both the route and the arrival: its guidance row says
 * "Type here" while the Draft takes the keystrokes and offers the way to it
 * otherwise. The ring wraps, so the walk is bounded.
 * Receipt: work/terminal-field-routes-2/receipts/.
 */
export function* intoDraft(page: ReplPage): Operation<void> {
  for (let press = 0; press < 40 && !page.screen().shows(TYPING); press += 1) {
    yield* tab(page);
  }
  if (!page.screen().shows(TYPING)) {
    // The guidance row is where this product advertises the Draft, and a
    // refusal takes that row for itself. History is the way to put a sentence
    // like that away: it is modal, it changes no entry, and closing it leaves
    // the guidance row saying what the focus ring is doing again.
    yield* page.press("[history]");
    yield* page.until("the History drawer", (one) => one.shows("[close]"));
    yield* page.press("[close]");
    yield* page.until("the drawer closing", (one) => !one.shows("[close]"));
    for (let press = 0; press < 40 && !page.screen().shows(TYPING); press += 1) {
      yield* tab(page);
    }
  }
  if (!page.screen().shows(TYPING)) {
    throw new Error(`the Draft never took the keystrokes. ${page.describe()}`);
  }
}

/**
 * Select the Sidekick, which is what gives its composer the keystrokes.
 *
 * Its own tab is the route, taken from the other one so the selection is a
 * real change: pressing the composer's prompt moves no focus on this product.
 */
export function* intoComposer(page: ReplPage): Operation<void> {
  yield* pressTab(page, BINDINGS, (one) => !one.shows(COMPOSER));
  yield* pressTab(page, SIDEKICK, (one) => one.shows(COMPOSER));
}

/**
 * Press one of the pane's tabs until the pane is the one it names.
 *
 * Measured: with an entry running, the first press on a tab leaves the reading
 * it draws unchanged and the second selects the pane, while on an idle screen
 * the first is enough. Pressing a tab already selected changes nothing, so the
 * walk is bounded and repeats are harmless.
 */
function* pressTab(
  page: ReplPage,
  tabLabel: string,
  chosen: (reading: ScreenReading) => boolean,
): Operation<void> {
  for (let press = 0; press < 3 && !chosen(page.screen()); press += 1) {
    const before = page.screen().index;
    yield* page.press(tabLabel);
    yield* page.until(`the screen after pressing ${tabLabel}`, (one) => one.index > before);
  }
  if (!chosen(page.screen())) {
    throw new Error(`pressing ${tabLabel} never gave its pane the reading. ${page.describe()}`);
  }
}

/**
 * Put several lines in the Draft as one chunk, the way a paste arrives.
 *
 * The screen wraps a value into the rows its field has, so the arrival is read
 * from the last line's own words rather than from the whole text: a wrapped
 * value is not on the screen as one string.
 */
export function* pasteDraft(page: ReplPage, text: string): Operation<void> {
  yield* intoDraft(page);
  // The last word rather than the last line: a field fits a value into the
  // rows it has, so a long line is not on the screen as one string.
  const last = (text.trimEnd().split(/\s+/).at(-1) ?? "").slice(0, 24);
  yield* page.type(text);
  yield* page.until(
    `the Draft holding ${JSON.stringify(last)}`,
    (one) => one.found(last, DRAFT_VALUE) > 0,
  );
}

/** Put this text in the Draft, wherever the keystrokes were going before. */
export function* draftText(page: ReplPage, text: string): Operation<void> {
  yield* intoDraft(page);
  yield* typed(page, text);
}

/** Put this text in the Draft and submit it as an entry. */
export function* submitDraft(page: ReplPage, text: string): Operation<void> {
  yield* draftText(page, text);
  yield* page.key("Enter");
}

/** Send the composer's text with the Sidekick's own Send, once it is offered. */
export function* sendMessage(page: ReplPage, text: string): Operation<void> {
  yield* intoComposer(page);
  yield* typed(page, text);
  yield* page.until(
    "the Sidekick offering its own Send",
    (one) => one.found("[send]", SIDEKICK_PANE) === 1,
  );
  yield* page.press("[send]", SIDEKICK_PANE);
}

/** Ask the Sidekick something and wait for a reply that shows this. */
export function* asked(page: ReplPage, text: string, shown: string): Operation<void> {
  yield* sendMessage(page, text);
  yield* page.until(`the reply showing ${JSON.stringify(shown)}`, (one) => one.shows(shown));
}

/** Press the Sidekick's own Stop. Waits for nothing: what Stop does is the case's question. */
export function stopSidekick(page: ReplPage): Operation<void> {
  // Its own Stop is in its pane. A drawer of its own covers that pane's tab,
  // and then the Stop to press is the drawer's: at or right of the way out
  // every drawer draws, which the Draft's own Stop is left of.
  const reading = page.screen();
  if (reading.occurrences("[stop]") === 1) {
    return page.press("[stop]");
  }
  if (reading.shows(COMPOSER)) {
    return page.press("[stop]", SIDEKICK_CONTROLS);
  }
  return page.press("[stop]", { rightOf: "[close]" });
}

/** Its own Send offered and its own Stop gone. */
export function sidekickIdle(reading: ScreenReading): boolean {
  // A drawer of this pane covers its composer, and a pane with no composer
  // offers no Send: asked then, the answer is that it is not at rest.
  if (!reading.shows(COMPOSER)) {
    return false;
  }
  return (
    reading.found("[send]", SIDEKICK_CONTROLS) === 1 &&
    reading.found("[stop]", SIDEKICK_CONTROLS) === 0
  );
}

/**
 * The Sidekick pane's own rows, as this screen draws them.
 *
 * Below the tab row and from the Draft heading's own cell rightward. The pane's
 * chat is drawn a couple of cells left of its tab, so the tab's column is too
 * far right to be a floor, while the sidebar's copy of a reply sits far left of
 * the Draft. Both bounds are cells of text this screen draws.
 *
 * It does not separate the Transcript, which shares those columns, so words
 * both readings draw are asked of the whole screen by count instead.
 */
export function paneLines(reading: ScreenReading): string[] {
  // A drawer over this pane covers its tab row, and then the pane draws none
  // of its own rows.
  if (!reading.shows(SIDEKICK)) {
    return [];
  }
  const tabs = reading.locate(SIDEKICK).row;
  const floor = reading.locate(DRAFT).column;
  return reading.rows.map((row, index) =>
    index > tabs ? row.slice(Math.min(floor, row.length)) : "",
  );
}

/** Whether the Sidekick's own pane shows this text. */
export function sidekickShows(reading: ScreenReading, text: string): boolean {
  return paneLines(reading).some((row) => row.includes(text));
}

/** Wait until the History rail marks this entry with the mark its outcome has. */
export function entrySettles(
  page: ReplPage,
  order: number,
  outcome: keyof typeof RAIL,
): Operation<ScreenReading> {
  const mark = `${order} ${RAIL[outcome]}`;
  return page.until(`entry ${order} reaching ${outcome}`, (one) => one.shows(mark));
}

/** Whether a drawer is open: its own way out is the one every drawer draws. */
export function drawerOpen(reading: ScreenReading): boolean {
  return reading.shows("[close]");
}

/** Open the History drawer and wait for the positions it offers. */
export function* openHistory(page: ReplPage): Operation<void> {
  yield* page.press("[history]");
  yield* page.until("the History drawer", (one) => drawerOpen(one) && one.shows("History"));
}

/** Put the open drawer away with its own Close. */
export function* closeDrawer(page: ReplPage): Operation<void> {
  yield* page.press("[close]");
  yield* page.until("the drawer closing", (one) => !drawerOpen(one));
}

/** Whether the person said this, as the chat attributes it. */
export function saidByPerson(reading: ScreenReading, text: string): boolean {
  return reading.shows(`[U] ${text}`);
}

/** Whether the Sidekick said this, as the chat attributes it. */
export function saidBySidekick(reading: ScreenReading, text: string): boolean {
  return reading.shows(`[S] ${text}`);
}

/** The words of a refusal, for a case that asserts the refusal itself. */
export function* refusal(attempt: Operation<unknown>): Operation<string> {
  try {
    yield* attempt;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  throw new Error("that operation was expected to refuse, and it completed");
}

/** Collapse whitespace, for a value the screen wrapped over several rows. */
export function unwrapped(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Wait for the first screen a command this case started drew for a person.
 *
 * For a case that runs `runReplProgram` itself, with options the page does not
 * mount: the same middleware the page installs, around the write the product
 * already had, so the wait is per completed write rather than a poll. The way
 * out is on every drawable screen of this product, so its label is what says
 * there is one. Install this before the command is spawned and yield the
 * operation it answers with where the screen has to be up.
 */
export function* drawnScreen(terminal: Terminal): Operation<Operation<void>> {
  const first = withResolvers<void>();
  yield* ReplTerminal.around({
    *write([bytes], next) {
      yield* next(bytes);
      if ((terminal.screen?.rows() ?? []).some((row) => row.includes("[exit]"))) {
        first.resolve();
      }
    },
  });
  return race([
    first.operation,
    (function* (): Operation<void> {
      yield* sleep(MOUNTED_DEADLINE_MS);
      throw new Error(`no screen offering the way out was drawn within ${MOUNTED_DEADLINE_MS}ms`);
    })(),
  ]);
}

/** Whether the Draft holds this text, and the composer does not. */
export function draftHolds(reading: ScreenReading, text: string): boolean {
  return reading.found(text, DRAFT_VALUE) > 0 && reading.found(text, COMPOSER_VALUE) === 0;
}

/** Whether the composer holds this text. */
export function composerHolds(reading: ScreenReading, text: string): boolean {
  return reading.found(text, COMPOSER_VALUE) > 0;
}

/** Whether a question form or Configure is open: its own submit or refresh says so. */
export function formOpen(reading: ScreenReading): boolean {
  return reading.shows("[submit]");
}

/** Open the Sidekick's own question and wait for the form it draws. */
export function* openQuestion(page: ReplPage): Operation<void> {
  yield* page.press("[answer sidekick]");
  yield* page.until("the question's form", (one) => formOpen(one));
}

/**
 * Answer a question form's second field, the one that takes text.
 *
 * Two Tabs from the opened form reach its editable line: the first selects the
 * field, the second its value. An enum field is chosen rather than typed into,
 * so the text field is the second of this product's review forms.
 * Receipt: work/terminal-field-routes-2/receipts/.
 */
export function* intoSecondField(page: ReplPage): Operation<void> {
  yield* tab(page);
  yield* tab(page);
}

/** Walk that route and type this answer, which is what says the field took it. */
export function* answerField(page: ReplPage, name: string, text: string): Operation<void> {
  yield* intoSecondField(page);
  yield* page.type(text);
  yield* page.until(`${name} holding ${JSON.stringify(text)}`, (one) =>
    one.shows(`*${name}: ${text}`),
  );
}

/** Choose one of the options a form draws for an enum field. */
export function* chooseOption(page: ReplPage, label: string): Operation<void> {
  yield* page.press(`( ) ${label}`);
}

/** Submit the open form with its own control. */
export function submitForm(page: ReplPage): Operation<void> {
  return page.press("[submit]");
}

/** Open Configure from the Sidekick's own header and wait for what it draws. */
export function* openConfigure(page: ReplPage, agent: string): Operation<void> {
  yield* page.press(`[configure ${agent}]`);
  yield* page.until("Configure", (one) => one.shows("[refresh]"));
}

/** Choose one of Configure's own offers, which it draws as options. */
export function* chooseOffer(page: ReplPage, label: string): Operation<void> {
  yield* page.press(`( ) ${label}`);
  yield* page.until(`${label} being chosen`, (one) => one.shows(`(x) ${label}`));
}

/** Select one of the inspection column's two tabs and wait for its reading. */
export function selectPane(page: ReplPage, pane: "sidekick" | "bindings"): Operation<void> {
  return pane === "sidekick"
    ? pressTab(page, SIDEKICK, (one) => one.shows(COMPOSER))
    : pressTab(page, BINDINGS, (one) => !one.shows(COMPOSER));
}
