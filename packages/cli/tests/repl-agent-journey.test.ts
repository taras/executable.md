/** Agent journeys use the same terminal surface a person uses to read them. */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";

import { useReplPage } from "./support/repl-page.ts";
import {
  draftHolds,
  draftText,
  sendMessage,
  SIDEKICK_CONTROLS,
  sidekickIdle,
  sidekickShows,
} from "./support/screen-journeys.ts";

const WIDE = { columns: 160, rows: 36 };

describe("Agent journey: terminal-visible replies and ownership", () => {
  it("reads a scripted Agent reply in the Sidekick pane", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({
      reply: "<Output>Agent reviewed the draft.</Output>\n",
    });
    yield* sendMessage(page, "review this draft");
    yield* page.until(
      "the Agent reply",
      (one) => sidekickShows(one, "Agent reviewed the draft."),
    );
    yield* page.until("the Agent returning to Send", sidekickIdle);
    expect(page.screen().found("[send]", SIDEKICK_CONTROLS)).toBe(1);
  });

  it("keeps a Draft edit separate while an Agent conversation is visible", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({
      reply: "<Output>Keep the entry local.</Output>\n",
    });
    yield* sendMessage(page, "tell me where the entry belongs");
    yield* page.until(
      "the Agent answer",
      (one) => sidekickShows(one, "Keep the entry local."),
    );
    yield* draftText(page, "manual entry");
    expect(draftHolds(page.screen(), "manual entry")).toBe(true);
    expect(draftHolds(page.screen(), "Keep the entry local.")).toBe(false);
  });

  it("keeps two Agent replies in order on the visible conversation", function* () {
    const page = yield* useReplPage({ size: WIDE });
    page.repl.fake.script({ reply: "<Output>First answer.</Output>\n" });
    page.repl.fake.script({ reply: "<Output>Second answer.</Output>\n" });
    yield* sendMessage(page, "first question");
    yield* page.until(
      "the first Agent answer",
      (one) => sidekickShows(one, "First answer."),
    );
    yield* sendMessage(page, "second question");
    const second = yield* page.until(
      "the second Agent answer",
      (one) => sidekickShows(one, "Second answer."),
    );
    const rows = second.rows.join("\n");
    expect(rows.indexOf("First answer.")).toBeLessThan(
      rows.indexOf("Second answer."),
    );
  });
});
