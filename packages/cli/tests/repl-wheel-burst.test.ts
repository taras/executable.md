import { beforeEach, describe, it } from "@executablemd/test-support/bdd";
import { journalBeforeEach } from "@executablemd/test-support/failure-journal";
import { expect } from "@executablemd/test-support/expect";
import { scoped, sleep } from "effection";
import type { Operation } from "effection";
import { useReplPage } from "./support/repl-page.ts";
import type { ReplPage, ScreenCell, ScreenReading } from "./support/repl-page.ts";
import { draftHolds, intoComposer, intoDraft, paneLines } from "./support/screen-journeys.ts";
import { generateTypingHistory } from "./support/typing-history.ts";

const OWNER = "packages/cli/tests/repl-wheel-burst.test.ts";

const SIZE = { columns: 160, rows: 36 };

function report(direction: "up" | "down", at: ScreenCell): string {
  return `\x1b[<${direction === "up" ? 64 : 65};${at.column + 1};${at.row + 1}M`;
}

// Every tick in one terminal chunk, so the root reads them as one batch.
function* burst(
  page: ReplPage,
  direction: "up" | "down",
  at: ScreenCell,
  ticks: number,
): Operation<void> {
  const before = page.screen().index;
  page.repl.terminal.feed(report(direction, at).repeat(ticks));
  yield* page.until(`write after ${ticks} ${direction} ticks`, (one) => one.index > before);
  yield* sleep(60);
}

// One acknowledged tick at a time.
function* ticked(
  page: ReplPage,
  direction: "up" | "down",
  at: ScreenCell,
  ticks: number,
): Operation<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    const before = page.screen().index;
    yield* page.wheel(direction, at);
    yield* page.until(`write after tick ${tick}`, (one) => one.index > before);
    yield* sleep(30);
  }
  yield* sleep(30);
}

function chatRows(page: ReplPage): number[] {
  const shown: number[] = [];
  for (const row of paneLines(page.screen())) {
    for (const match of row.matchAll(/Chat row (\d+)/g)) {
      shown.push(Number(match[1]));
    }
  }
  return shown;
}

// The generated TAIL lines the Sidekick chat shows, right of the Draft pane.
function tailLines(reading: ScreenReading): string[] {
  return paneLines(reading).flatMap(
    (row) => row.slice(row.lastIndexOf("│") + 1).match(/TAIL-(?:LINE|END)-\d+/g) ?? [],
  );
}

// A labelled turn row left of the Sidekick pane.
function transcriptCell(page: ReplPage): ScreenCell {
  const rows = page.screen().rows;
  for (let row = rows.length - 1; row >= 0; row -= 1) {
    const column = rows[row].indexOf("turn-");
    const pane = rows[row].indexOf("│");
    if (column >= 0 && (pane < 0 || column < pane)) {
      return { column, row };
    }
  }
  throw new Error(`no Transcript turn row: ${page.describe()}`);
}

function consecutive(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, at) => from + at);
}

function* typed(page: ReplPage, text: string): Operation<void> {
  yield* page.type(text);
  yield* page.until(`typed ${text}`, (one) => one.shows(text));
}

describe("wheel bursts in one input chunk", () => {
  beforeEach(journalBeforeEach(OWNER));
  it("overflowing History keeps its launcher through resize and keyboard access", function* () {
    const page = yield* useReplPage({ size: SIZE });
    yield* generateTypingHistory(page, 120, 1);
    for (const size of [SIZE, { columns: 120, rows: 30 }, { columns: 72, rows: 20 }]) {
      if (size !== SIZE) {
        yield* page.resize(size);
      }
      expect(page.screen().found("[History]")).toBe(1);
      expect(page.screen().shows("[exit]")).toBe(true);
      yield* page.press("[History]");
      yield* page.until("History opens", (one) => one.shows("in 120 "));
      expect(page.screen().shows("in 120 ")).toBe(true);
      yield* page.key("Escape");
      yield* page.until("History closes", (one) => !one.shows("in 120 "));
      yield* page.until("History focus restored", (one) => one.shows("> [History]"));
      for (let stop = 0; stop < 30 && !page.screen().shows("> [History]"); stop++) {
        yield* page.key("Tab");
        yield* sleep(30);
      }
      expect(page.screen().shows("> [History]")).toBe(true);
      yield* page.key("Enter");
      yield* page.until("keyboard History opens", (one) => one.shows("in 120 "));
      yield* page.key("Escape");
      yield* page.until("keyboard History closes", (one) => !one.shows("in 120 "));
    }
  });

  it("History batches reach the sequential endpoint and return to newest", function* () {
    const page = yield* useReplPage({ size: SIZE });
    yield* generateTypingHistory(page, 30, 1);
    yield* page.press("[History]");
    yield* page.until("History", (one) => one.shows("[close]"));
    yield* page.key("Tab");
    yield* page.until("History actions own focus", (one) => one.shows("> [close]"));
    const cell = page.screen().locate("in 30 ");
    const positions = () =>
      page
        .screen()
        .rows.flatMap((row) =>
          [...row.matchAll(/(?:^|\s)in +(\d+)(?=\s|$)/g)].map((match) => match[1]),
        );
    const newest = positions();
    yield* burst(page, "down", cell, 4);
    const older = positions();
    expect(older).not.toEqual(newest);
    yield* ticked(page, "up", cell, 4);
    expect(positions()).toEqual(newest);
    yield* ticked(page, "down", cell, 4);
    expect(positions()).toEqual(older);
    yield* burst(page, "up", cell, 100);
    expect(positions()).toEqual(newest);
  });

  it("Sidekick chat reaches the sequential endpoint and keeps follow", function* () {
    const page = yield* useReplPage({ size: SIZE });
    yield* intoComposer(page);
    const rows = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, at) => `Chat row ${from + at}`).join("\n");
    page.repl.fake.script({
      deltas: [`<Output>${rows(0, 120)}`, `\n${rows(120, 130)}`, `\n${rows(130, 140)}</Output>`],
      holdsEachPiece: true,
    });
    yield* typed(page, "read this");
    yield* page.key("Enter");
    yield* page.repl.fake.streamingTurns(1);
    yield* page.until("live row 119", (one) => one.shows("Chat row 119"));
    yield* sleep(60);
    yield* typed(page, "message-kept");
    const cell = page.screen().locate("Chat row 119");
    const tail = page.screen().rows;
    const visible = chatRows(page);
    const start = visible[0];
    expect(visible).toEqual(consecutive(start, visible.length));

    yield* burst(page, "up", cell, 10);
    const moved = chatRows(page);
    expect(moved).toEqual(consecutive(start - 30, moved.length));
    const burstEnd = page.screen().rows;

    yield* ticked(page, "down", cell, 10);
    expect(page.screen().rows).toEqual(tail);
    yield* ticked(page, "up", cell, 10);
    expect(page.screen().rows).toEqual(burstEnd);

    // Overrunning the tail lands on the exact last page and resumes following.
    yield* burst(page, "down", cell, 20);
    expect(page.screen().rows).toEqual(tail);
    page.repl.fake.releaseDeltas();
    yield* page.until("following resumed", (one) => one.shows("Chat row 129"));
    yield* sleep(60);
    const followed = chatRows(page);
    expect(followed.at(-1)).toBe(129);

    // Leaving the tail by a burst stops following.
    const reading = page.screen().locate("Chat row 129");
    yield* burst(page, "up", reading, 10);
    const held = chatRows(page);
    expect(held).toEqual(consecutive(followed[0] - 30, held.length));
    page.repl.fake.releaseDeltas();
    yield* page.until("turn completed", (one) => !one.shows("[stop]"));
    yield* sleep(60);
    expect(chatRows(page)).toEqual(held);
    expect(page.screen().shows("message-kept")).toBe(true);
    page.repl.terminal.feed("!");
    yield* page.until("retained Message caret", (one) => one.shows("message-kept!"));
  });

  it("a tick that clears a staged refusal moves the next one within the freed capacity", function* () {
    // Each dotted segment is one probed path segment, so each stays within a file name.
    const name = ["Unknown", "Missing", "Absent"].map((at) => at + "Component".repeat(27));
    const request = `<${name.join(".")} />`;
    const refusal = "! this entry cannot run here: Cannot resolve component:";
    const cell = { column: 140, row: 13 };

    function* endpoints(move: typeof burst) {
      return yield* scoped(function* () {
        const page = yield* useReplPage({ size: SIZE });
        yield* generateTypingHistory(page, 2, 80);
        // The name alone wraps the staged refusal past the searched paths, which
        // vary by platform, so clearing it frees more rows than one tick moves.
        yield* intoDraft(page);
        yield* page.type(request);
        const drafted = yield* page.until("the unknown component in Draft", (one) =>
          draftHolds(one, "/>"),
        );
        const before = tailLines(drafted);
        yield* page.press("Send", { onRow: "✎ draft" });
        const refused = yield* page.until("the staged refusal", (one) => one.shows(refusal));
        const start = tailLines(refused);
        expect(start.length + 2).toBeLessThan(before.length);

        yield* move(page, "up", cell, 2);
        expect(page.screen().shows(refusal)).toBe(false);
        const end = tailLines(page.screen());
        expect(end.length).toBeGreaterThan(start.length);
        expect(end[0]).not.toBe(start[0]);
        return { start, end };
      });
    }

    expect(yield* endpoints(burst)).toEqual(yield* endpoints(ticked));
  });

  it("Transcript reaches the sequential endpoint and leaves the chat alone", function* () {
    const page = yield* useReplPage({ size: SIZE });
    yield* intoComposer(page);
    for (let at = 0; at < 18; at += 1) {
      const label = `turn-${String(at).padStart(2, "0")}`;
      page.repl.fake.script({
        reply: `<Output>Reply witness ${at}\nsecond ${at}\nthird ${at}</Output>`,
      });
      yield* typed(page, label);
      yield* page.key("Enter");
      yield* page.until(
        `turn ${at} completed`,
        (one) => one.shows(`third ${at}`) && !one.shows("[stop]"),
      );
    }
    yield* page.key("Tab");
    yield* page.until("History focused", (one) => one.shows("> [History]"));
    yield* page.key("Tab");
    yield* page.until("Transcript selector focused", (one) => one.shows("> All sessions"));
    yield* sleep(60);
    const cell = transcriptCell(page);
    const chat = paneLines(page.screen());
    const top = page.screen().rows;

    yield* burst(page, "down", cell, 10);
    const burstEnd = page.screen().rows;
    expect(burstEnd).not.toEqual(top);
    expect(paneLines(page.screen())).toEqual(chat);

    yield* ticked(page, "up", cell, 10);
    expect(page.screen().rows).toEqual(top);
    yield* ticked(page, "down", cell, 10);
    expect(page.screen().rows).toEqual(burstEnd);
    expect(paneLines(page.screen())).toEqual(chat);

    // Overrunning the top lands on the exact first page.
    yield* burst(page, "up", cell, 20);
    expect(page.screen().rows).toEqual(top);
    expect(paneLines(page.screen())).toEqual(chat);
    expect(page.screen().shows("> All sessions")).toBe(true);
  });
});
