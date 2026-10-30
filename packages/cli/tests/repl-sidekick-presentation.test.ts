/** Read Sidekick work from the pane and controls the terminal actually shows. */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { useReplPage } from "./support/repl-page.ts";
import {
  COMPOSER,
  composerHolds,
  DRAFT,
  draftHolds,
  intoComposer,
  sendMessage,
  SIDEKICK,
  SIDEKICK_CONTROLS,
  SIDEKICK_PANE,
  sidekickIdle,
  sidekickShows,
  stopSidekick,
  typed,
} from "./support/screen-journeys.ts";

const WIDE = { columns: 160, rows: 36 };
const NARROW = { columns: 72, rows: 20 };

describe("Sidekick presentation: visible work owns its controls", () => {
  it("sends one message through the Sidekick pane and reads the reply", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({ reply: "<Output>Noted.</Output>\n" });
    yield* sendMessage(page, "explain the entry");
    yield* page.until("the Sidekick reply", (one) => sidekickShows(one, "Noted."));
    yield* page.until("the Sidekick returning to Send", sidekickIdle);
    expect(page.screen().found("[send]", SIDEKICK_PANE)).toBe(1);
  });

  it("keeps the composer separate from the Draft", function* () {
    const page = yield* useReplPage({ size: WIDE });
    yield* intoComposer(page);
    yield* typed(page, "a Sidekick question");
    const reading = page.screen();
    expect(composerHolds(reading, "a Sidekick question")).toBe(true);
    expect(draftHolds(reading, "a Sidekick question")).toBe(false);
    expect(reading.found("[send]", { onRow: DRAFT })).toBe(1);
  });

  it("routes one visible surface at narrow size and recovers when widened", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const narrow = yield* page.resize(NARROW);
    expect(narrow.shows(SIDEKICK)).toBe(false);
    expect(narrow.shows(COMPOSER)).toBe(false);
    expect(narrow.occurrences("[send]")).toBe(1);
    const wide = yield* page.resize(WIDE);
    expect(wide.shows(SIDEKICK)).toBe(true);
    expect(wide.shows(COMPOSER)).toBe(true);
    expect(wide.occurrences("[send]")).toBe(2);
  });

  it("shows Stop while a Sidekick turn is held and restores Send after Stop", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({
      held: true,
      reply: "<Output>never reached</Output>\n",
    });
    yield* sendMessage(page, "hold this turn");
    yield* page.until("the Sidekick Stop", (one) => one.found("[stop]", SIDEKICK_CONTROLS) === 1);
    yield* stopSidekick(page);
    yield* page.until("the Sidekick returning to Send", sidekickIdle);
    expect(page.screen().shows("never reached")).toBe(false);
  });
});
