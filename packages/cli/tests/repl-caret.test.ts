import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { boundaries, caretFor, eraseAt, insertAt, moveCaret } from "../src/repl/caret.ts";

describe("REPL caret editing", () => {
  it("inserts and erases whole graphemes at the caret without changing surrounding whitespace", function* () {
    const value = " a\u0301👩‍👩‍👧‍👦界 \n";
    const left = moveCaret(caretFor(value, undefined), "ArrowLeft", []);
    expect(left.offset).toBe(value.length - 1);
    const middle = { value, offset: boundaries(value)[2] };
    const inserted = insertAt(middle, "X\nY");
    expect(inserted.value).toBe(" a\u0301X\nY👩‍👩‍👧‍👦界 \n");
    expect(eraseAt({ value, offset: boundaries(value)[3] }).value).toBe(" a\u0301界 \n");
    expect(eraseAt({ value, offset: 0 }).value).toBe(value);
  });

  it("moves across measured rows at a preferred visual column and resets on horizontal movement", function* () {
    const rows = [
      {
        stops: [
          { offset: 0, column: 0 },
          { offset: 1, column: 2 },
          { offset: 2, column: 3 },
        ],
      },
      {
        stops: [
          { offset: 3, column: 0 },
          { offset: 4, column: 1 },
        ],
      },
      {
        stops: [
          { offset: 5, column: 0 },
          { offset: 6, column: 1 },
          { offset: 7, column: 2 },
          { offset: 8, column: 3 },
        ],
      },
    ];
    const start = { value: "界a\nx\nxyz", offset: 2 };
    const down = moveCaret(start, "ArrowDown", rows);
    expect(down).toEqual({ value: start.value, offset: 4, column: 3 });
    expect(moveCaret(down, "ArrowDown", rows).offset).toBe(8);
    expect(moveCaret(down, "ArrowLeft", rows).column).toBeUndefined();
    expect(moveCaret(start, "Home", rows).offset).toBe(0);
    expect(moveCaret({ ...start, offset: 0 }, "ArrowUp", rows).offset).toBe(0);
    expect(moveCaret({ ...start, offset: 5 }, "End", rows).offset).toBe(8);
  });

  it("preserves a value's caret and starts replaced values at their end", function* () {
    const held = { value: "old", offset: 1, column: 2 };
    expect(caretFor("old", held)).toEqual(held);
    expect(caretFor("new", held)).toEqual({ value: "new", offset: 3 });
    expect(caretFor("a\u0301b", { value: "a\u0301b", offset: 1 }).offset).toBe(0);
    const joined = insertAt({ value: "a", offset: 1 }, "\u0301");
    expect(eraseAt(joined)).toEqual({ value: "", offset: 0 });
  });
});
