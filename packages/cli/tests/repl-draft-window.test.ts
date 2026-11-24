import { sleep } from "effection";
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useReplPage } from "./support/repl-page.ts";
import { generateTypingDraft } from "./support/typing-history.ts";

import { draftWindowFrom, followDraftWindow } from "../src/repl/program.ts";

describe("draft window", () => {
  it("keeps the caret visible while retaining the window", function* () {
    for (const [count, length, active, remembered, expected] of [
      [10, 100, 20, undefined, 20],
      [10, 100, 25, 20, 20],
      [10, 100, 23, 20, 20],
      [10, 100, 19, 20, 19],
      [10, 100, 30, 20, 21],
      [10, 5, 3, undefined, 0],
      [10, 25, 24, 50, 15],
    ]) {
      expect(draftWindowFrom(count!, length!, active!, remembered)).toBe(expected);
    }
  });
  it("scrolls the focused draft without moving its caret", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    yield* generateTypingDraft(page, 120);
    const prior = page.screen().index;
    yield* page.key("ArrowLeft");
    yield* page.until("left caret frame", (one) => one.index > prior);
    const first = () =>
      Number(
        page
          .screen()
          .rows.find((row) => row.includes("DRAFT-"))
          ?.match(/DRAFT-[A-Z]+-(\d+)/)?.[1],
      );
    const before = first();
    yield* page.wheel("up", { row: 10, column: 60 });
    yield* page.until("three earlier draft rows", () => first() === before - 3);
    yield* page.wheel("up", { row: 10, column: 60 });
    yield* page.until("six earlier draft rows", () => first() === before - 6);
    yield* page.resize({ columns: 200, rows: 30 });
    expect(first()).toBe(before - 6);
    yield* page.key("ArrowRight");
    yield* page.until("the caret row returns", (one) => one.shows("DRAFT-END-119"));
  });
  it("keeps the rendered end caret visible when the focused draft shrinks", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    yield* generateTypingDraft(page, 120);
    yield* page.resize({ columns: 200, rows: 30 });
    let carets = 0;
    for (let row = 0; row < 30; row++) {
      for (let column = 0; column < 200; column++) {
        if (page.repl.terminal.screen?.styleAt(column, row).background === 8377320) {
          carets++;
        }
      }
    }
    expect(carets).toBe(1);
    expect(page.screen().shows("DRAFT-END-119")).toBe(true);
  });
  it("applies every draft wheel notch in a burst with one paint and clamps", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    yield* generateTypingDraft(page, 120);
    const first = () =>
      Number(
        page
          .screen()
          .rows.find((row) => row.includes("DRAFT-"))
          ?.match(/DRAFT-[A-Z]+-(\d+)/)?.[1],
      );
    const bottom = first();
    for (const [direction, notches, expected] of [
      ["up", 4, bottom - 12],
      ["down", 2, bottom - 6],
      ["down", 50, bottom],
      ["up", 50, 0],
    ] satisfies readonly (readonly ["up" | "down", number, number])[]) {
      const painted = page.repl.terminal.drawn;
      const reading = page.screen().index;
      page.repl.terminal.feed(`\x1b[<${direction === "up" ? 64 : 65};61;11M`.repeat(notches));
      yield* page.until("the burst paint", (one) => one.index > reading);
      expect(first()).toBe(expected);
      expect(page.repl.terminal.drawn - painted).toBe(1);
    }
  });
  it("renders the caret after moving down through a retained draft window", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    const draft = [
      "hello this is a test",
      "",
      "",
      "does this work",
      ...Array.from({ length: 90 }, (_, index) =>
        index % 9 === 0 ? "" : `${index} ${"DRAFT-row ".repeat(24)}`,
      ),
    ].join("\n");
    yield* generateTypingDraft(page, 90, draft);
    yield* sleep(40);
    for (let at = 0; at < 110; at++) {
      yield* page.key("ArrowUp");
      yield* sleep(20);
    }
    const carets = () => {
      let count = 0;
      for (let row = 0; row < 52; row++) {
        for (let column = 0; column < 200; column++) {
          if (page.repl.terminal.screen?.styleAt(column, row).background === 8377320) {
            count++;
          }
        }
      }
      return count;
    };
    expect(carets()).toBe(1);
    for (let at = 0; at < 4; at++) {
      yield* page.key("ArrowDown");
      yield* sleep(20);
      expect(carets()).toBe(1);
    }
  });
  it("retains a manually scrolled window until following resumes", function* () {
    expect(
      followDraftWindow(
        10,
        120,
        119,
        { manual: true, from: 90, draft: "held", caret: 119 },
        "held",
        119,
      ),
    ).toBe(90);
    expect(
      followDraftWindow(
        10,
        120,
        119,
        { manual: true, from: 90, draft: "held", caret: 118 },
        "held",
        119,
      ),
    ).toBe(110);
    expect(
      followDraftWindow(10, 5, 4, { manual: true, from: 90, draft: "short", caret: 4 }, "short", 4),
    ).toBe(0);
  });
  it("keeps the first visible line when the caret moves down inside it", function* () {
    const page = yield* useReplPage({ size: { columns: 200, rows: 52 } });
    yield* generateTypingDraft(page, 120);
    for (let at = 0; at < 60; at++) {
      const before = page.screen().index;
      yield* page.key("ArrowUp");
      yield* page.until("the up frame", (one) => one.index > before);
    }
    const first = () =>
      page
        .screen()
        .rows.find((row) => row.includes("DRAFT-"))
        ?.match(/DRAFT-[A-Z]+-\d+/)?.[0];
    const held = first();
    expect(held).toBeDefined();
    const before = page.screen().index;
    yield* page.key("ArrowDown");
    yield* page.until("the down frame", (one) => one.index > before);
    expect(first()).toBe(held);
  });
});
