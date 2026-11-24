import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { useReplPage } from "./support/repl-page.ts";
import { draftHighlighter } from "../src/repl/draft-highlighting.ts";
import { pasteDraft } from "./support/screen-journeys.ts";

describe("experimental draft boundary styling", () => {
  it("styles mounted cells by fence context and updates after editing the opener", function* () {
    const page = yield* useReplPage({ size: { columns: 160, rows: 36 } });
    const source = '<Output />\n~~~text\n<Output />\n~~~\n<Output value="unfinished';
    const classify = draftHighlighter(source);
    let offset = 0;
    for (const line of source.split("\n")) {
      expect(
        classify(line, offset)
          .map((run) => run.text)
          .join(""),
      ).toBe(line);
      offset += line.length + 1;
    }
    yield* pasteDraft(page, source);
    const styles = () => {
      const rows = page.screen().rows;
      const tags = rows.flatMap((text, row) => {
        const column = text.indexOf("<Output");
        return column < 0 ? [] : [{ row, column }];
      });
      return tags.map(
        ({ row, column }) => page.repl.terminal.screen?.styleAt(column + 1, row).foreground,
      );
    };
    yield* page.until("three rendered tags", () => styles().length === 3);
    const before = styles();
    expect(before[0]).not.toBe(before[1]);
    expect(before[0]).toBe(before[2]);
    const last = page.screen().locate("value=");
    expect(page.repl.terminal.screen?.styleAt(last.column, last.row).foreground).not.toBe(
      before[1],
    );
    for (const key of [
      "ArrowUp",
      "ArrowUp",
      "ArrowUp",
      "Home",
      "ArrowRight",
      "Backspace",
    ] as const) {
      const prior = page.screen().index;
      yield* page.key(key);
      yield* page.until(`frame after ${key}`, (one) => one.index > prior);
    }
    yield* page.until("downstream tag recolored", () => styles()[1] === before[0]);
    expect(page.screen().shows("~~text")).toBe(true);
  });
});
