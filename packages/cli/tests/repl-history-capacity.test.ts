/**
 * History opens over a long retained history without exhausting measurement (#1220).
 *
 * Every History row is a control padded with spaces to the drawer's width, and
 * each one used to reach the engine as one text: its distinct label and its
 * long run of blanks were measured as one string of empty words, a fresh one
 * per ordinal. Sixty settled entries at a tall window filled the engine's
 * measured-word storage before the drawer could be drawn, so opening History
 * refused instead of showing it. The padding now reaches the engine as its own
 * text beside the label, and identical blanks share one measurement.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped } from "effection";
import type { Operation } from "effection";

import {
  initialState,
  NO_AGENT,
  reduceRepl,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import type { ReplState, ReplView } from "../src/repl/application.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { resolveWheel } from "../src/repl/renderer.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { journalModel } from "./fixtures/repl/journals.ts";
import { usePresenter } from "./fixtures/repl/presentation.ts";
import type { Observed, Presenter } from "./fixtures/repl/presentation.ts";

const TALL: ReplTerminalSize = { columns: 316, rows: 120 };
const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };
const LIVE = {
  output: "",
  question: undefined,
  expansion: "playing",
  pausable: false,
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
} as const;

/** Sixty settled plain-text entries: one hundred and twenty positions. */
function largeHistory(): Operation<ReplModel> {
  return journalModel(Array.from({ length: 60 }, (_, at) => `Public history sample ${at + 1}.\n`));
}

function viewOf(
  state: ReplState,
  model: ReplModel,
  size: ReplTerminalSize,
  focused?: string,
): ReplView {
  const view = viewFor(state, model, LIVE, size, focused, navigationOf(model.checkpoints, "live"));
  if (!view.ok) {
    throw view.error;
  }
  return withWorkspace(view.value, workspaceOf(model));
}

/** Press the frame's own `[History]` control and reduce what it asked for. */
function* pressHistory(
  presenter: Presenter,
  observed: Observed,
  state: ReplState,
  model: ReplModel,
): Operation<ReplState> {
  const bounds = observed.boundsOf("footer:history");
  if (bounds === undefined) {
    throw new Error("this frame drew no [History] control");
  }
  const dispatched = yield* presenter.tree.dispatch({
    kind: "pointer",
    target: observed.committed.rendered.map.at(bounds.x, bounds.y) ?? "",
    frame: observed.committed.rendered.tree,
  });
  if (!dispatched.ok || dispatched.value.outcome !== "action") {
    throw new Error("the [History] control asked for nothing");
  }
  const opened = reduceRepl(state, dispatched.value.action, model, LIVE).state;
  return reduceRepl(opened, { kind: "history-positions" }, model, LIVE).state;
}

function markers(observed: Observed): readonly string[] {
  return observed.keys.filter((key) => key.startsWith("drawer:marker:"));
}

describe("History over a long retained history", () => {
  it("H1: opens from its control at 316x120 with every admitted row placed", function* () {
    const model = yield* largeHistory();
    expect(model.checkpoints.length).toBe(120);
    const presenter = yield* usePresenter(TALL);
    const closed = initialState("public-history-capacity");
    const first = yield* presenter.commit(viewOf(closed, model, TALL));
    expect(first.keys.filter((key) => key === "footer:history")).toHaveLength(1);
    expect(first.boundsOf("footer:history")?.x).toBe(0);
    const opened = yield* pressHistory(presenter, first, closed, model);
    expect(opened.route.drawers.map((one) => one.kind)).toEqual(["history"]);

    const drawn = yield* presenter.commit(viewOf(opened, model, TALL));
    const again = yield* presenter.commit(viewOf(opened, model, TALL));
    const admitted = markers(drawn);
    expect(admitted.length).toBeGreaterThan(20);
    expect(markers(again)).toEqual(admitted);
    // Newest first, with the journal positions unchanged.
    expect(admitted).toEqual(
      [...model.checkpoints]
        .reverse()
        .slice(0, admitted.length)
        .map((one) => `drawer:marker:${one.marker}`),
    );
    // One column, one row each, one under the other, each as wide as the next.
    const bounds = admitted.map((key) => drawn.boundsOf(key));
    const placed = bounds.flatMap((one) => (one === undefined ? [] : [one]));
    expect(placed.length).toBe(admitted.length);
    expect(new Set(placed.map((one) => `${one.x}:${one.width}:${one.height}`)).size).toBe(1);
    expect(placed[0]?.height).toBe(1);
    for (const [at, one] of placed.entries()) {
      expect(one.y).toBe((placed[0]?.y ?? 0) + at);
    }
    const label = presenter.grid.textIn(placed[0] ?? { x: 0, y: 0, width: 0, height: 0 })[0] ?? "";
    expect(label.trimEnd()).toContain("120 · Entry outcome recorded");
    const original = model.checkpoints.map((one) => one.marker);
    for (const [index, kind] of ["key", "pointer"].entries()) {
      const key = admitted[index];
      const bounds = drawn.boundsOf(key);
      if (bounds === undefined) {
        throw new Error("History row is absent");
      }
      const current = yield* presenter.commit(viewOf(opened, model, TALL, key));
      const result = yield* presenter.tree.dispatch(
        kind === "key"
          ? { kind: "key", key: "Enter" }
          : {
              kind: "pointer",
              target: current.committed.rendered.map.at(bounds.x, bounds.y) ?? "",
              frame: current.committed.rendered.tree,
            },
      );
      if (!result.ok || result.value.outcome !== "action") {
        throw new Error("History row selected nothing");
      }
      const selected = reduceRepl(opened, result.value.action, model, LIVE).state;
      expect(selected.route.at).toBe(original[original.length - 1 - index]);
    }
    expect(model.checkpoints.map((one) => one.marker)).toEqual(original);
    expect(presenter.renderer.engines()).toEqual({ measuring: 1, drawing: 1 });
  });

  it("wheel reaches both ends without selecting and activates the scrolled row", function* () {
    const model = yield* largeHistory();
    const presenter = yield* usePresenter(NARROW);
    let state = initialState("wheel-history");
    const first = yield* presenter.commit(viewOf(state, model, NARROW));
    state = yield* pressHistory(presenter, first, state, model);
    let shown = yield* presenter.commit(viewOf(state, model, NARROW));
    const start = markers(shown);
    for (const direction of ["down", "up"] as const) {
      for (let tick = 0; tick < 60; tick++) {
        const scroll = shown.committed.rendered.map.scrolls.find(
          (one) => one.id === "box:drawer:viewport",
        );
        if (scroll === undefined) {
          throw new Error("History viewport is absent");
        }
        const event = resolveWheel(
          shown.committed.rendered,
          {
            column: scroll.bounds.x,
            row: scroll.bounds.y,
          },
          direction,
        );
        if (event === undefined) {
          throw new Error("History wheel did not resolve");
        }
        const result = yield* presenter.tree.dispatch(event);
        if (!result.ok || result.value.outcome !== "action") {
          throw new Error("History wheel asked for nothing");
        }
        state = reduceRepl(
          state,
          result.value.action,
          model,
          LIVE,
          shown.committed.admission,
        ).state;
        expect(state.route.at).toBeUndefined();
        shown = yield* presenter.commit(viewOf(state, model, NARROW));
      }
      if (direction === "down") {
        expect(markers(shown)).toContain(`drawer:marker:${model.checkpoints[0].marker}`);
        const key = `drawer:marker:${model.checkpoints[0].marker}`;
        const bounds = shown.boundsOf(key);
        if (bounds === undefined) {
          throw new Error("oldest row is absent");
        }
        const picked = yield* presenter.tree.dispatch({
          kind: "pointer",
          target: shown.committed.rendered.map.at(bounds.x, bounds.y) ?? "",
          frame: shown.committed.rendered.tree,
        });
        if (!picked.ok || picked.value.outcome !== "action") {
          throw new Error("oldest row selected nothing");
        }
        expect(
          reduceRepl(state, picked.value.action, model, LIVE, shown.committed.admission).state.route
            .at,
        ).toBe(model.checkpoints[0].marker);
      } else {
        expect(markers(shown)).toEqual(start);
      }
    }
  });

  it("H4: a padded row keeps its label, blanks and surface, and restores fresh", function* () {
    const model = yield* largeHistory();
    const closed = initialState("public-history-capacity");
    const opened = Object.freeze({
      ...closed,
      historyPositions: true,
      route: Object.freeze({
        ...closed.route,
        drawers: Object.freeze([Object.freeze({ kind: "history" as const })]),
      }),
    });
    const whole = (presenter: Presenter): readonly string[] =>
      presenter.grid.styledIn({
        x: 0,
        y: 0,
        width: TALL.columns,
        height: TALL.rows,
      });

    const incremental = yield* scoped(function* () {
      const presenter = yield* usePresenter(TALL);
      yield* presenter.commit(viewOf(closed, model, TALL));
      const drawn = yield* presenter.commit(viewOf(opened, model, TALL));
      const [first, second] = markers(drawn);
      if (first === undefined || second === undefined) {
        throw new Error("History admitted fewer than two rows");
      }
      // Focus moves onto the second row and back to the first.
      yield* presenter.commit(viewOf(opened, model, TALL, second));
      const focused = yield* presenter.commit(viewOf(opened, model, TALL, first));
      const row = focused.boundsOf(second);
      if (row === undefined) {
        throw new Error("the second History row was not placed");
      }
      // The label, then blank cells to the row's edge, all on the row's surface.
      const cells = presenter.grid.textIn(row)[0] ?? "";
      expect(cells.length).toBe(row.width);
      expect(cells.trimEnd().length).toBeLessThan(row.width - 20);
      expect(cells.slice(cells.trimEnd().length).trim()).toBe("");
      const surface = presenter.grid.styleAt(row.x, row.y).background;
      expect(surface).toBeDefined();
      for (let x = row.x; x < row.x + row.width; x += 1) {
        expect([x, presenter.grid.styleAt(x, row.y).background]).toEqual([x, surface]);
      }
      // Closed, reopened, taken narrow and brought back.
      yield* presenter.commit(viewOf(closed, model, TALL));
      yield* presenter.commit(viewOf(opened, model, TALL));
      presenter.resize(NARROW);
      yield* presenter.commit(viewOf(opened, model, NARROW));
      presenter.resize(TALL);
      const last = yield* presenter.commit(viewOf(opened, model, TALL, first));
      expect(presenter.renderer.engines()).toEqual({
        measuring: 1,
        drawing: 1,
      });
      return { cells: whole(presenter), keys: last.keys.slice().sort() };
    });

    const fresh = yield* scoped(function* () {
      const presenter = yield* usePresenter(TALL);
      const drawn = yield* presenter.commit(viewOf(opened, model, TALL));
      const last = yield* presenter.commit(viewOf(opened, model, TALL, markers(drawn)[0]));
      return { cells: whole(presenter), keys: last.keys.slice().sort() };
    });

    expect(incremental.cells).toEqual(fresh.cells);
    expect(incremental.keys).toEqual(fresh.keys);
  });
});
