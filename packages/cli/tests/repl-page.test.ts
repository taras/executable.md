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
import type { ReplPage, ScreenCell, ScreenScope } from "./support/repl-page.ts";
import { awaited } from "./support/mounted-repl.ts";
import { intoDraft } from "./support/screen-journeys.ts";

const WIDE = { columns: 160, rows: 36 };
const NARROW = { columns: 72, rows: 20 };
const BELOW = { columns: 60, rows: 15 };

/** The Draft's own heading, which its Send shares a row with. */
const DRAFT = "· draft";
const ROUND_BAR = { onRow: "✎ draft" };

/** The Sidekick tab, which its own Send is drawn below and right of. */
const SIDEKICK = "SIDEKICK";

/** What the Sidekick's composer invites, which is the pane's own prompt. */
const COMPOSER = "message the sidekick";

/** The Sidekick's own Send, scoped by the one bounded layout statement made here. */
const SIDEKICK_SEND: ScreenScope = { after: SIDEKICK, rightOf: SIDEKICK };

/** Where this label actually begins, asked of the emulator's own cells. */
function cellOf(page: ReplPage, label: string): ScreenCell[] {
  const cells = page.repl.terminal.screen?.cells() ?? [];
  const found: ScreenCell[] = [];
  cells.forEach((row, index) => {
    for (let column = 0; column < row.length; column += 1) {
      if (row.slice(column, column + label.length).join("") === label) {
        found.push({ column, row: index });
      }
    }
  });
  return found;
}

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

describe("REPL page — Send and its visible scope", () => {
  it("opens by pointer and moves focus from the editor directly to Send", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* typed(page, "unsent Message");
    yield* page.press("+ New Round");
    const opened = yield* page.until("focused Round editor", (one) =>
      one.shows("> Round 1 · draft"),
    );
    expect(opened.found("Send", ROUND_BAR)).toBe(1);
    expect(opened.found("[send]", SIDEKICK_SEND)).toBe(1);

    yield* tab(page);
    yield* page.until("focused Send", (one) => one.shows("> Send"));
    yield* page.key("Enter");
    yield* page.until("empty Send leaving the editor open", (one) => one.shows("Round 1 · draft"));
    yield* page.key("Backtab");
    yield* typed(page, "first line");
    yield* page.key("Enter");
    yield* typed(page, "second line");
    const draft = page.screen();
    expect(draft.locate("second line").row).toBe(draft.locate("first line").row + 1);
    expect(draft.shows("1 ✓")).toBe(false);

    yield* tab(page);
    yield* page.key("Enter");
    yield* page.until("the entry settling", (one) => one.shows("1 ✓"));
    expect(page.screen().shows("unsent Message")).toBe(true);
  });

  it("survives content that echoes a control's label, and refuses one never drawn", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* intoDraft(page);
    yield* typed(page, "Send appears in this draft");
    const ambiguous = yield* refusal(page.press("Send"));
    expect(ambiguous).toContain("is shown 2 times in the whole screen");

    expect(page.screen().found("Send", ROUND_BAR)).toBe(1);
    yield* page.press("Send", ROUND_BAR);
    yield* page.until("the echoed draft being submitted", (one) => one.shows("1 ✓"));

    const absent = yield* refusal(page.press("[submit]"));
    expect(absent).toContain('"[submit]" is shown 0 times');
    expect(absent).toContain("rows=");
  });
});

describe("REPL page — resize, a modal, and writes that never land", () => {
  it("keeps the draft across every size and refuses a pane the size removed", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* intoDraft(page);
    yield* typed(page, "keep this draft");

    // Narrow routes one surface: no tab row, no composer, one Send.
    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows("keep this draft")).toBe(true);
    expect(narrow.occurrences("Send")).toBe(1);
    expect(narrow.shows(SIDEKICK)).toBe(false);
    expect(narrow.shows(COMPOSER)).toBe(false);
    // The scope that named the Sidekick's Send is refused here, saying which
    // visible text it could not find rather than pressing the Draft's instead.
    const gone = yield* refusal(page.press("[send]", SIDEKICK_SEND));
    expect(gone).toContain(`exactly one row showing ${JSON.stringify(SIDEKICK)}`);
    expect(narrow.found("Send", ROUND_BAR)).toBe(1);

    // Below the minimum the screen is its own refusal and offers nothing.
    const refused = yield* page.resize(BELOW);
    expect(refused.shows("needs at least 72x20")).toBe(true);
    expect(refused.occurrences("[send]")).toBe(0);

    // Recovered, the draft is still what was typed into it.
    const recovered = yield* page.resize(WIDE);
    expect(recovered.shows("keep this draft")).toBe(true);
    expect(recovered.found("keep this draft", { after: DRAFT })).toBe(1);
    expect(recovered.occurrences("[send]")).toBe(1);
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

describe("REPL page — a column is a terminal cell, not a string offset", () => {
  it("locates a label after a wide glyph at the cell it is really drawn in", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* intoDraft(page);

    // Three double-width glyphs, typed as a person types them. They land on
    // the Draft's own value row, which is the row the Sidekick's Send shares —
    // so each one moves every later cell of that row two columns while adding
    // one character to its text.
    yield* typed(page, "\u754c\u754c\u754c");

    const reading = page.screen();
    const located = reading.locate("[send]", SIDEKICK_SEND);
    const drawn = cellOf(page, "[send]").filter((one) => one.row === located.row);
    expect(drawn).toHaveLength(1);
    // The one that matters: a located column is a terminal cell, so the cell it
    // names is where the label actually begins.
    expect(located).toEqual(drawn[0]);

    // The Draft's own Send, on a row the glyphs are not on, is unmoved and
    // still submits what was typed.
    const draftSend = reading.locate("Send", ROUND_BAR);
    expect(cellOf(page, "Send").filter((one) => one.row === draftSend.row)).toEqual([draftSend]);
    yield* page.press("Send", ROUND_BAR);
    yield* page.until("the wide entry settling", (one) => one.shows("1 \u2713"));
  });

  it("counts an anchor's own column in cells when a wide glyph precedes it", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* intoDraft(page);
    yield* typed(page, "\u754c\u754c\u754c");

    // The scope floor comes from the anchor's own first cell, so a scope that
    // admitted the Sidekick's Send before the glyphs still admits exactly it,
    // and still excludes the Draft's.
    const reading = page.screen();
    expect(reading.found("[send]", SIDEKICK_SEND)).toBe(1);
    expect(reading.found("Send", ROUND_BAR)).toBe(1);
    expect(reading.occurrences("[send]")).toBe(1);

    // And the glyphs themselves are read where they are drawn: the first is on
    // the Draft's value row, two cells wide, with nothing of it left behind.
    const glyphs = cellOf(page, "\u754c");
    expect(glyphs.length).toBeGreaterThan(0);
    const first = reading.locate("\u754c\u754c\u754c");
    expect(glyphs.some((one) => one.row === first.row && one.column === first.column)).toBe(true);
  });
});

const DRAFT_FOCUS = "> Round";

/** What a question form asks for, so its second field is a real text field. */
const REVIEW = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    message: { type: "string", minLength: 4 },
  },
  required: ["decision", "message"],
  additionalProperties: false,
} as const;

/** Send one Tab and wait for the screen it draws. */
function* tab(page: ReplPage): Operation<void> {
  const before = page.screen().index;
  yield* page.key("Tab");
  yield* page.until("the screen after a Tab", (one) => one.index > before);
}

/**
 * Select the Sidekick, which is what gives its composer the keystrokes.
 *
 * Its own tab is the route: pressing the composer's prompt does not move
 * focus, which the retired harness hid behind an internal key.
 */
function* intoComposer(page: ReplPage): Operation<void> {
  yield* page.press("BINDINGS");
  yield* page.until("the Bindings reading", (one) => !one.shows(COMPOSER));
  yield* page.press(SIDEKICK);
  yield* page.until("the Sidekick reading", (one) => one.shows(COMPOSER));
}

/** Ask the Sidekick something and wait for what it answers. */
function* asked(page: ReplPage, text: string, shown: string): Operation<void> {
  yield* intoComposer(page);
  yield* typed(page, text);
  yield* page.press("[send]", SIDEKICK_SEND);
  yield* page.until(`the reply showing ${JSON.stringify(shown)}`, (one) => one.shows(shown));
}

describe("REPL page — reaching a field the claim names, by keyboard", () => {
  it("puts a person's own entry in the Draft after a Sidekick exchange", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({ reply: "<Output>AUTHORED</Output>\n" });
    yield* asked(page, "author a component", "AUTHORED");

    expect(page.screen().shows(DRAFT_FOCUS)).toBe(false);

    yield* intoDraft(page);
    expect(page.screen().shows(DRAFT_FOCUS)).toBe(true);

    yield* typed(page, "<Output>the first entry</Output>");
    const drafted = page.screen();
    expect(drafted.found("the first entry", { after: DRAFT })).toBe(1);
    expect(drafted.found("the first entry", SIDEKICK_SEND)).toBe(0);

    yield* tab(page);
    yield* page.key("Enter");
    yield* page.until("entry 1 settling", (one) => one.shows("1 ✓"));
    expect(page.screen().shows("the first entry")).toBe(true);
  });

  it("replaces the agent Configure is holding", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.configuration({
      model: {
        selected: "balanced",
        choices: [
          { id: "balanced", name: "Balanced" },
          { id: "fast", name: "Fast" },
        ],
      },
      effort: { balanced: { selected: "medium", choices: [{ id: "medium", name: "Medium" }] } },
    });

    yield* page.press("[configure scribe]");
    yield* page.until("Configure", (one) => one.shows("[refresh]"));
    // Agent is the drawer's fixed Content entry.
    for (let press = 0; press < "scribe".length; press += 1) {
      const before = page.screen().index;
      yield* page.key("Backspace");
      yield* page.until("the screen after a Backspace", (one) => one.index > before);
    }
    yield* typed(page, "scrivener");
    expect(page.screen().shows("Agent: scrivener")).toBe(true);
    expect(page.screen().shows("Agent: scribe")).toBe(false);

    // What the drawer then offers is the outcome a replacement has: this agent
    // has its own settings, so the way to adopt it is a conversation of its own.
    expect(page.screen().shows("scrivener has its own settings.")).toBe(true);
    expect(page.screen().shows("[start new conversation]")).toBe(true);
  });

  it("answers the second field of a question form and submits it", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({
      reply: `<Elicit schema={${JSON.stringify(REVIEW)}} as="answer">Approve the plan?</Elicit>\n`,
    });
    yield* asked(page, "review it", "[answer sidekick]");
    yield* page.press("[answer sidekick]");
    yield* page.until("the form", (one) => one.shows("[submit]"));

    // First editable value -> second field label -> second editable value.
    yield* page.key("Alt+ArrowDown");
    yield* page.key("Alt+ArrowDown");
    yield* typed(page, "okay");
    const answered = page.screen();
    expect(answered.rows.some((row) => row.includes("*message: okay"))).toBe(true);
    expect(answered.rows.some((row) => row.includes("*decision: okay"))).toBe(false);

    // Submitted with the required choice still unmade, the form keeps what was
    // typed and says what is missing rather than answering.
    yield* page.press("[submit]");
    const refused = yield* page.until("the form saying what is missing", (one) =>
      one.shows("must have required property"),
    );
    expect(refused.rows.some((row) => row.includes("*message: okay"))).toBe(true);

    // Making the choice the refusal named completes the answer: the form goes
    // and the Sidekick carries on with what it was given.
    yield* page.press("( ) approve");
    yield* page.until("the form being answered", (one) => !one.shows("[submit]"));
  });
});
