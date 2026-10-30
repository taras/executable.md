/**
 * Read the mounted REPL as a person does: from the cells its completed writes
 * leave on the terminal. Geometry and palette invariants stay with the
 * renderer and layout tests, where their owned handles make those claims.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { useReplPage } from "./support/repl-page.ts";
import {
  BINDINGS,
  COMPOSER,
  DRAFT,
  DRAFT_VALUE,
  SIDEKICK,
  SIDEKICK_PANE,
  TYPING,
  closeDrawer,
  draftHolds,
  draftText,
  intoComposer,
  openHistory,
} from "./support/screen-journeys.ts";

const WIDE = { columns: 160, rows: 36 };
const MEDIUM = { columns: 120, rows: 30 };
const NARROW = { columns: 72, rows: 20 };
const BELOW = { columns: 60, rows: 15 };

describe("REPL presentation: the screen says what is placed", () => {
  it("keeps the shell and its readable surfaces at the supported sizes", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const wide = page.screen();
    expect(wide.shows("XMD REPL")).toBe(true);
    expect(wide.shows("TRANSCRIPT")).toBe(true);
    expect(wide.shows(BINDINGS)).toBe(true);
    expect(wide.shows(SIDEKICK)).toBe(true);
    expect(wide.shows("HISTORY")).toBe(true);
    expect(wide.occurrences("[send]")).toBe(2);

    const medium = yield* page.resize(MEDIUM);
    expect(medium.shows("XMD REPL")).toBe(true);
    expect(medium.shows("HISTORY")).toBe(true);
    expect(medium.shows(TYPING)).toBe(true);

    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows("XMD REPL")).toBe(true);
    expect(narrow.shows("HISTORY")).toBe(true);
    expect(narrow.occurrences("[send]")).toBe(1);
    expect(narrow.shows(SIDEKICK)).toBe(false);
    expect(narrow.shows(COMPOSER)).toBe(false);

    const refused = yield* page.resize(BELOW);
    expect(refused.shows("needs at least 72x20")).toBe(true);
    expect(refused.occurrences("[send]")).toBe(0);
  });

  it("keeps source text in the field that draws it", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const source = "<Checkout />";
    yield* draftText(page, source);
    const reading = page.screen();
    expect(reading.found(source, DRAFT_VALUE)).toBe(1);
    expect(draftHolds(reading, source)).toBe(true);
    expect(reading.found(source, { after: COMPOSER })).toBe(0);
  });

  it("keeps a modal readable and leaves the Draft unchanged behind it", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* draftText(page, "keep this draft");
    yield* openHistory(page);
    expect(page.screen().shows("History")).toBe(true);
    yield* page.type("ignored by the drawer");
    yield* closeDrawer(page);
    const closed = page.screen();
    expect(draftHolds(closed, "keep this draft")).toBe(true);
    expect(draftHolds(closed, "ignored by the drawer")).toBe(false);
  });

  it("keeps the Sidekick scope distinct from the Draft Send", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* intoComposer(page);
    const reading = page.screen();
    expect(reading.found("[send]", SIDEKICK_PANE)).toBe(1);
    expect(reading.found("[send]", { onRow: DRAFT })).toBe(1);
  });
});
