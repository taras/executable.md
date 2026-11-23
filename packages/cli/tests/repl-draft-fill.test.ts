import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useReplPage } from "./support/repl-page.ts";
import {
  intoComposer,
  composerHolds,
  draftShows,
  draftOpen,
  sidekickIdle,
} from "./support/screen-journeys.ts";

describe("Sidekick draft fills", () => {
  it("closes a consumed Sidekick draft and displays its output", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    yield* intoComposer(page);
    page.repl.fake.script({
      reply:
        "<REPL.EntryInput>&lt;Output&gt;submitted marker&lt;/Output&gt;</REPL.EntryInput><REPL.Submit />",
    });
    page.repl.fake.script({ reply: "<Output>Submit ready.</Output>" });
    yield* page.type("fill and submit");
    yield* page.key("Enter");
    const shown = yield* page.until(
      "the settled submission",
      (one) => one.shows("Submit ready.") && sidekickIdle(one),
    );
    expect(draftOpen(shown)).toBe(false);
    expect(shown.shows("submitted marker")).toBe(true);
  });
  it("opens a Sidekick-filled draft without taking composer focus", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    yield* intoComposer(page);
    page.repl.fake.script({ reply: "<REPL.EntryInput>filled marker</REPL.EntryInput>" });
    page.repl.fake.script({ reply: "<Output>Fill ready.</Output>" });
    yield* page.type("fill it");
    yield* page.key("Enter");
    const shown = yield* page.until(
      "the settled fill",
      (one) => one.shows("Fill ready.") && sidekickIdle(one),
    );
    expect(draftShows(shown, "filled marker")).toBe(true);
    yield* page.type("composer marker");
    yield* page.until("the composer keeps focus", (one) => composerHolds(one, "composer marker"));
  });
  it("does not open an empty Sidekick fill", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    yield* intoComposer(page);
    page.repl.fake.script({ reply: "<REPL.EntryInput></REPL.EntryInput>" });
    page.repl.fake.script({ reply: "<Output>Empty ready.</Output>" });
    yield* page.type("empty fill");
    yield* page.key("Enter");
    const shown = yield* page.until(
      "the empty fill",
      (one) => one.shows("Empty ready.") && sidekickIdle(one),
    );
    expect(draftOpen(shown)).toBe(false);
  });
});
