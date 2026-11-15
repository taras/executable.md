import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep } from "effection";
import type { Operation } from "effection";
import { useReplPage } from "./support/repl-page.ts";
import type { ReplPage, ScreenCell } from "./support/repl-page.ts";
import { intoComposer, paneLines } from "./support/screen-journeys.ts";

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
    yield* page.until("History focused", (one) => one.shows("> [history]"));
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
