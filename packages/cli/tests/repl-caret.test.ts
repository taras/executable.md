import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { boundaries, caretFor, eraseAt, insertAt, moveCaret } from "../src/repl/caret.ts";
import { createPlainFitStore, fitEditor } from "../src/repl/fitting.ts";
import { useReplRenderer } from "../src/repl/renderer.ts";
import { useCountingRenderer } from "./fixtures/repl/presentation.ts";
import { usePresenter } from "./fixtures/repl/presentation.ts";
import { journalModel } from "./fixtures/repl/journals.ts";
import {
  initialState,
  NO_AGENT,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import { fields, readDescription } from "../src/repl/description.ts";
import { prepareFrame } from "../src/repl/program.ts";

describe("REPL caret editing", () => {
  it("retains the destination row at shared fitted wrap boundaries", function* () {
    const size = { columns: 160, rows: 36 };
    const renderer = yield* useReplRenderer(size);
    const fitted = yield* fitEditor(renderer, size, { value: "abcdef", offset: 6 }, 4, true);
    if (!fitted.ok) {
      throw fitted.error;
    }
    expect(fitted.value.display.map((row) => row.text)).toEqual(["abc", "def "]);
    const up = moveCaret(fitted.value.caret, "ArrowUp", fitted.value.rows);
    const shown = yield* fitEditor(renderer, size, up, 4, true);
    if (!shown.ok) {
      throw shown.error;
    }
    expect(shown.value.active).toBe(0);
    expect(shown.value.display[0].runs).toContainEqual({ text: " ", token: "caret" });
    expect(moveCaret(up, "ArrowUp", shown.value.rows)).toEqual(up);
    expect(moveCaret(up, "ArrowDown", shown.value.rows).offset).toBe(6);
    expect(moveCaret(up, "ArrowLeft", shown.value.rows).backward).toBeUndefined();
  });

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
    expect(down).toEqual({ value: start.value, offset: 4, column: 3, backward: true });
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

  it("reuses measured editor rows without retaining offsets, styling or obsolete geometry", function* () {
    const size = { columns: 160, rows: 36 };
    const renderer = yield* useCountingRenderer(size);
    const store = createPlainFitStore();
    const value = "a\u0301界👩‍👩‍👧‍👦\nkept row\nlast row";
    const start = { value, offset: value.length };
    const first = yield* fitEditor(renderer, size, start, 9, true, store);
    if (!first.ok) {
      throw first.error;
    }
    renderer.reset();
    const moved = moveCaret(start, "ArrowUp", first.value.rows);
    const warm = yield* fitEditor(renderer, size, moved, 9, false, store);
    if (!warm.ok) {
      throw warm.error;
    }
    expect(renderer.measures()).toBe(0);
    const cold = yield* fitEditor(renderer, size, moved, 9, false);
    if (!cold.ok) {
      throw cold.error;
    }
    expect(warm.value).toEqual(cold.value);
    const changed = { value: "longer first line\nkept row\nlast row", offset: 23 };
    renderer.reset();
    const edited = yield* fitEditor(renderer, size, changed, 9, true, store);
    if (!edited.ok) {
      throw edited.error;
    }
    const reused = renderer.measures();
    renderer.reset();
    const unfitted = yield* fitEditor(renderer, size, changed, 9, true);
    if (!unfitted.ok) {
      throw unfitted.error;
    }
    expect(edited.value).toEqual(unfitted.value);
    expect(reused).toBeLessThan(renderer.measures());
    for (const next of [
      { size, room: 5 },
      { size: { columns: 120, rows: 30 }, room: 5 },
    ]) {
      const resized = yield* fitEditor(renderer, next.size, changed, next.room, true, store);
      const fresh = yield* fitEditor(renderer, next.size, changed, next.room, true);
      if (!resized.ok || !fresh.ok) {
        throw new Error("resized editor did not fit");
      }
      expect(resized.value).toEqual(fresh.value);
    }
    const replaced = yield* fitEditor(renderer, size, { value: "new", offset: 3 }, 9, true, store);
    if (!replaced.ok) {
      throw replaced.error;
    }
    expect(store.heldCaret("kept row", 0, 8, size)).toBeUndefined();
  });

  it("dispatches from bounded field geometry using global offsets in a long value", function* () {
    const size = { columns: 160, rows: 36 };
    const model = yield* journalModel([]);
    const draft = "a\u0301界👩‍👩‍👧‍👦 kept\n".repeat(40);
    const state = {
      ...initialState("bounded-editor"),
      draft,
      draftCaret: { value: draft, offset: draft.length / 2 },
    };
    const resolved = viewFor(
      state,
      model,
      {
        output: "",
        question: undefined,
        expansion: "playing",
        pausable: false,
        running: false,
        agent: NO_AGENT,
        lifecycle: NO_LIFECYCLE,
      },
      size,
    );
    if (!resolved.ok) {
      throw resolved.error;
    }
    const view = withWorkspace(resolved.value, workspaceOf(model));
    const presenter = yield* usePresenter(size);
    const prepared = yield* prepareFrame(presenter.renderer, view);
    if (!prepared.ok) {
      throw prepared.error;
    }
    const editor = prepared.value.context.editors?.get("footer:input");
    if (editor === undefined) {
      throw new Error("Draft editor is missing");
    }
    expect(editor.rows.length).toBeGreaterThan(3);
    const pending = [...prepared.value.presentation.descriptions];
    let found = false;
    while (pending.length > 0) {
      const description = pending.pop();
      if (description === undefined) {
        break;
      }
      const read = readDescription(description);
      if (read.key === "footer:input") {
        expect(fields(read.input)?.["caretRows"]).toEqual(
          editor.rows.slice(editor.active - 1, editor.active + 2),
        );
        found = true;
      }
      pending.push(...read.children);
    }
    expect(found).toBe(true);
    yield* presenter.commit(view);
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"] as const) {
      const dispatched = yield* presenter.tree.dispatch({ kind: "key", key });
      if (!dispatched.ok) {
        throw dispatched.error;
      }
      if (dispatched.value.outcome !== "action" || dispatched.value.action.kind !== "move-caret") {
        throw new Error("Draft did not claim caret movement");
      }
      expect(dispatched.value.action.caret).toEqual(moveCaret(editor.caret, key, editor.rows));
    }
  });
});
