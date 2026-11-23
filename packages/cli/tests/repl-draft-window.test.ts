import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useReplPage } from "./support/repl-page.ts";
import { generateTypingDraft } from "./support/typing-history.ts";

import { draftWindowFrom } from "../src/repl/program.ts";

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
