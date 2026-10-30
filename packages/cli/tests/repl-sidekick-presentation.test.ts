/** Read Sidekick work from the pane and controls the terminal actually shows. */

import { awaitedFact } from "./support/mounted-repl.ts";
import { settledReading } from "./support/mounted-history.ts";
import type { ReplPage, ScreenReading } from "./support/repl-page.ts";
import { describe, it } from "@executablemd/test-support/bdd";
import type { Operation } from "effection";
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

function chatHas(reading: ScreenReading, text: string): boolean {
  return reading.found(text, reading.shows("DRAFT") ? { rightOf: "DRAFT" } : undefined) > 0;
}

function chatLines(reading: ScreenReading, anchor: string): string[] {
  const column = reading.locate(
    anchor,
    reading.shows("DRAFT") ? { rightOf: "DRAFT" } : undefined,
  ).column;
  const start = reading.locate("[↑ earlier]", SIDEKICK_CONTROLS).row;
  const end = reading.locate("[↓ later]", SIDEKICK_CONTROLS).row;
  return reading.rows.slice(start + 1, end).map((row) => row.slice(column).trim());
}

function* exchange(page: ReplPage, text: string, answer: string): Operation<void> {
  page.repl.fake.script({ reply: `<Output>${answer}</Output>\n` });
  yield* sendMessage(page, text);
  yield* page.until("the reply", (one) => chatHas(one, answer.split("\n")[0]));
  yield* page.until("the Sidekick at rest", sidekickIdle);
}

describe("Tier CF — complete messages and following the newest reply", () => {
  it("CF1: a message with its own lines keeps every one of them when the next arrives", function* () {
    const page = yield* useReplPage({ size: WIDE });
    const wide = "a-very-long-line-that-cannot-fit-this-pane-and-must-be-cut-across-rows";
    const first = ["one-A", "one-B", "", "one-C", wide].join("\n");
    yield* exchange(page, "first", first);
    const before = chatLines(page.screen(), "[S] one-A");
    const at = (rows: readonly string[], text: string): number =>
      rows.findIndex((row) => row.endsWith(text));
    for (const part of ["one-A", "one-B", "one-C"]) {
      expect(before.some((row) => row.endsWith(part))).toBe(true);
    }
    expect(before.join("")).toContain(wide);
    expect(at(before, "one-A")).toBeLessThan(at(before, "one-B"));
    expect(before[at(before, "one-B") + 1]).toBe("");
    yield* exchange(page, "second", "two-A\ntwo-B");
    const after = chatLines(page.screen(), "[S] one-A");
    for (const part of ["one-A", "one-B", "one-C", "two-A", "two-B"]) {
      expect(after.some((row) => row.endsWith(part))).toBe(true);
    }
    expect(after.join("")).toContain(wide);
    expect(at(after, "one-C")).toBeLessThan(at(after, "two-A"));
    expect(at(after, "two-A")).toBeLessThan(at(after, "two-B"));
    expect(page.screen().shows(COMPOSER)).toBe(true);
    expect(page.screen().found("[send]", { onRow: DRAFT })).toBe(1);
    yield* awaitedFact("two saved replies", function* () {
      return (
        (yield* settledReading(page.repl)).chat.filter((one) => one.kind === "response").length ===
        2
      );
    });
    const replies = (yield* settledReading(page.repl)).chat.filter(
      (one) => one.kind === "response",
    );
    expect(JSON.stringify(replies[0])).toContain("one-C");
  });

  it("CF2: a chat whose window filled shows its newest reply, at every size", function* () {
    const page = yield* useReplPage({ size: WIDE });
    for (let number = 1; number <= 12; number += 1) {
      yield* exchange(page, `ask-${number}`, `ANSWER-${number}`);
    }
    const read = yield* settledReading(page.repl);
    expect(read.chat.filter((one) => one.kind === "response")).toHaveLength(12);
    const fed = page.repl.terminal.fed;
    yield* page.until("the latest reply following without input", (one) =>
      chatHas(one, "[S] ANSWER-12"),
    );
    expect(page.repl.terminal.fed).toBe(fed);
    expect(page.screen().rows.some((row) => row.trimEnd().endsWith("[S] ANSWER-1"))).toBe(false);
    expect(JSON.stringify(read.chat)).toContain("ANSWER-1");
    for (const size of [{ columns: 120, rows: 30 }, NARROW, WIDE]) {
      const reading = yield* page.resize(size);
      expect(chatHas(reading, "[S] ANSWER-12")).toBe(true);
    }
    for (
      let press = 0;
      press < 60 && !page.screen().rows.some((row) => row.trimEnd().endsWith("[S] ANSWER-1"));
      press += 1
    ) {
      const before = page.screen().index;
      yield* page.press("[↑ earlier]", SIDEKICK_CONTROLS);
      yield* page.until("the earlier messages", (one) => one.index > before);
      if (
        page.screen().rows.some((row) => row.trimEnd().endsWith("[S] ANSWER-1")) &&
        !chatHas(page.screen(), "[S] ANSWER-12")
      ) {
        break;
      }
    }
    expect(page.screen().rows.some((row) => row.trimEnd().endsWith("[S] ANSWER-1"))).toBe(true);
  });
});
