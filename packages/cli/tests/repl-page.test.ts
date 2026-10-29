/**
 * The running REPL driven through the terminal and read from what it shows.
 *
 * These are the representative consumers of `support/repl-page.ts`: they
 * install no observation of their own in the product, and every fact they
 * assert is text a person can read on the screen after a write the command
 * completed. Two labels spelled the same are told apart by the visible text
 * beside them, a label shown twice inside the scope asked for is refused
 * rather than guessed, and a screen that draws neither is refused by name.
 *
 * Expected words come from the specification and from what this product
 * actually draws; nothing here asks the command where it put something.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";

import { useReplPage } from "./support/repl-page.ts";
import type { ReplPage, ScreenScope } from "./support/repl-page.ts";
import { awaited } from "./support/mounted-repl.ts";

const WIDE = { columns: 160, rows: 36 };
const NARROW = { columns: 72, rows: 20 };
const BELOW = { columns: 60, rows: 15 };

/** The Draft's own heading, which its Send shares a row with. */
const DRAFT = " DRAFT";

/** The Sidekick tab, which its own Send is drawn below and right of. */
const SIDEKICK = "SIDEKICK";

/** What the Sidekick's composer invites, which is the pane's own prompt. */
const COMPOSER = "message the sidekick";

/** The Sidekick's own Send, scoped by the one bounded layout statement made here. */
const SIDEKICK_SEND: ScreenScope = { after: SIDEKICK, rightOf: SIDEKICK };

/** The message a refusal carries, for a case that asserts the refusal itself. */
function* refusal(attempt: Operation<unknown>): Operation<string> {
  try {
    yield* attempt;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  throw new Error("that operation was expected to refuse, and it completed");
}

/** Type into whatever holds focus, and wait until the screen shows it. */
function* typed(page: ReplPage, text: string): Operation<void> {
  yield* page.type(text);
  yield* page.until(`the screen showing ${JSON.stringify(text)}`, (one) => one.shows(text));
}

describe("REPL page — two Sends, told apart by what is drawn beside them", () => {
  it("presses the Draft's Send and leaves the Sidekick's conversation alone", function* () {
    const page = yield* useReplPage({ size: WIDE });

    // The screen really does draw this label twice, which is what makes the
    // scope necessary rather than decorative.
    const shown = page.screen();
    expect(shown.occurrences("[send]")).toBe(2);
    expect(shown.found("[send]", { onRow: DRAFT })).toBe(1);
    expect(shown.found("[send]", SIDEKICK_SEND)).toBe(1);

    // Unscoped, the locator refuses rather than taking the first of the two.
    const ambiguous = yield* refusal(page.press("[send]"));
    expect(ambiguous).toContain("is shown 2 times in the whole screen");

    // The composer is the Sidekick's, and it is drawn left of that tab's own
    // first cell — so the tab's column is not the pane's left edge, and this
    // scope says only what it says.
    expect(shown.found(COMPOSER, SIDEKICK_SEND)).toBe(0);
    expect(shown.occurrences(COMPOSER)).toBe(1);

    yield* typed(page, "the first entry");
    // The text went to the Draft, not to the composer behind the other label.
    const drafted = page.screen();
    expect(drafted.found("the first entry", { after: DRAFT })).toBe(1);
    expect(drafted.found("the first entry", SIDEKICK_SEND)).toBe(0);

    yield* page.press("[send]", { onRow: DRAFT });
    // The entry the press submitted, as the History rail marks it settled.
    yield* page.until("entry 1 settling", (one) => one.shows("1 ✓"));
    // And the other pane was not asked anything: its own emptiness still shows.
    expect(page.screen().shows("No messages yet")).toBe(true);
    expect(page.repl.fake.prompts).toHaveLength(0);
  });

  it("survives content that echoes a control's label, and refuses one never drawn", function* () {
    const page = yield* useReplPage({ size: WIDE });

    // A draft that quotes the control's own label. The echo is drawn on the
    // Draft's value rows, below its heading, so the screen now shows the label
    // three times and an unscoped press is refused with every cell named.
    yield* page.type("[send]");
    // Waited for by the count, because the label this types is already drawn
    // twice as a control: showing it is not evidence the Draft took it.
    const echoing = yield* page.until(
      "the Draft holding the label it quoted",
      (one) => one.occurrences("[send]") === 3,
    );
    const ambiguous = yield* refusal(page.press("[send]"));
    expect(ambiguous).toContain("is shown 3 times in the whole screen");

    // Both scopes still resolve, because each names a row the echo is not on:
    // the heading row carries the Draft's own control, and the echo sits under
    // it rather than beside it.
    expect(echoing.found("[send]", { onRow: DRAFT })).toBe(1);
    expect(echoing.found("[send]", SIDEKICK_SEND)).toBe(1);

    // And the scoped press still reaches the control rather than the echo.
    yield* page.press("[send]", { onRow: DRAFT });
    yield* page.until("the echoed draft being submitted", (one) => one.shows("1 \u2713"));

    // A label this product never draws is refused by name, with the rows read.
    const absent = yield* refusal(page.press("[submit]", { onRow: DRAFT }));
    expect(absent).toContain('"[submit]" is shown 0 times');
    expect(absent).toContain("rows=");
  });
});

describe("REPL page — resize, a modal, and writes that never land", () => {
  it("keeps the draft across every size and refuses a pane the size removed", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* typed(page, "keep this draft");

    // Narrow routes one surface: no tab row, no composer, one Send.
    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows("keep this draft")).toBe(true);
    expect(narrow.occurrences("[send]")).toBe(1);
    expect(narrow.shows(SIDEKICK)).toBe(false);
    expect(narrow.shows(COMPOSER)).toBe(false);
    // The scope that named the Sidekick's Send is refused here, saying which
    // visible text it could not find rather than pressing the Draft's instead.
    const gone = yield* refusal(page.press("[send]", SIDEKICK_SEND));
    expect(gone).toContain(`exactly one row showing ${JSON.stringify(SIDEKICK)}`);
    expect(narrow.found("[send]", { onRow: DRAFT })).toBe(1);

    // Below the minimum the screen is its own refusal and offers nothing.
    const refused = yield* page.resize(BELOW);
    expect(refused.shows("needs at least 72x20")).toBe(true);
    expect(refused.occurrences("[send]")).toBe(0);

    // Recovered, the draft is still what was typed into it.
    const recovered = yield* page.resize(WIDE);
    expect(recovered.shows("keep this draft")).toBe(true);
    expect(recovered.found("keep this draft", { after: DRAFT })).toBe(1);
    expect(recovered.occurrences("[send]")).toBe(2);
  });

  it("an open History drawer takes the typing the Draft would have had", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* typed(page, "kept while open");

    yield* page.press("[history]");
    const opened = yield* page.until("the History drawer", (one) => one.shows("[close]"));
    expect(opened.shows("History")).toBe(true);

    // Typed at the drawer, and the Draft behind it did not take it: its own
    // text is unchanged and the stray characters are not under its heading.
    yield* page.type("stray");
    yield* page.press("[close]");
    yield* page.until("the drawer closing", (one) => !one.shows("[close]"));
    const after = page.screen();
    expect(after.found("kept while open", { after: DRAFT })).toBe(1);
    expect(after.found("stray", { after: DRAFT })).toBe(0);
  });

  it("publishes no reading for a write that is held, and resumes when it lands", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const terminal = page.repl.terminal;
    const held = page.screen().index;

    // The next write blocks inside the delegation this middleware wraps, so
    // the screen it would have left is never read.
    terminal.holdNextPresent();
    yield* page.type("held while writing");
    yield* awaited("the write being held", () => terminal.holdPresent !== undefined);
    expect(page.screen().index).toBe(held);
    expect(page.screen().shows("held while writing")).toBe(false);

    terminal.holdPresent?.release();
    const landed = yield* page.until("the held write landing", (one) =>
      one.shows("held while writing"),
    );
    expect(landed.index).toBeGreaterThan(held);
  });
});
