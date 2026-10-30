import { describe, it } from "@executablemd/test-support/bdd";
import { collect, inlineSource, useTempFileCompiler } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { InMemoryStream } from "@executablemd/durable-streams";
import type { DurableEvent } from "@executablemd/durable-streams";
import type { Operation } from "effection";

import { entryInitialBindings, projectRepl } from "../src/repl/model.ts";
import type { ReplModel } from "../src/repl/model.ts";
import { EntrySegmentStream } from "../src/repl/entries.ts";
import { navigationOf } from "../src/repl/navigation.ts";
import { NO_LIFECYCLE } from "../src/repl/lifecycle.ts";
import {
  DRAWER_WINDOW,
  initialState,
  NO_AGENT,
  READING_WINDOW,
  reduceRepl,
  viewFor,
  withWorkspace,
  workspaceOf,
} from "../src/repl/application.ts";
import type { ReplLive, ReplView } from "../src/repl/application.ts";
import type { ReplTerminalSize } from "../src/repl/terminal.ts";
import { usePresenter, windowOf } from "./fixtures/repl/presentation.ts";

const WIDE: ReplTerminalSize = { columns: 160, rows: 36 };
const NARROW: ReplTerminalSize = { columns: 72, rows: 20 };
const IDLE: ReplLive = Object.freeze({
  output: "",
  question: undefined,
  expansion: "playing" as const,
  pausable: false,
  running: false,
  agent: NO_AGENT,
  lifecycle: NO_LIFECYCLE,
});

function projected(events: readonly DurableEvent[]): ReplModel {
  const result = projectRepl(events);
  if (!result.ok) { throw result.error; }
  return result.value;
}

function* journalModel(sources: readonly string[]): Operation<ReplModel> {
  yield* useTempFileCompiler();
  const physical = new InMemoryStream();
  for (const source of sources) {
    const settled = yield* physical.readAll();
    const execution = yield* executeInstalled(
      { ...inlineSource(source), stream: new EntrySegmentStream(physical) },
      [],
      { initialBindings: settled.length === 0 ? {} : entryInitialBindings(projected(settled)) },
    );
    yield* collect(execution);
  }
  return projected(yield* physical.readAll());
}

function viewOf(model: ReplModel, size: ReplTerminalSize, options: { state?: ReturnType<typeof initialState>; focused?: string } = {}): ReplView {
  const view = viewFor(
    options.state ?? initialState("reference"),
    model,
    IDLE,
    size,
    options.focused,
    navigationOf(model.checkpoints, "live"),
  );
  if (!view.ok) { throw view.error; }
  return withWorkspace(view.value, workspaceOf(model));
}

describe("probe", () => {
  it("prints keys", function* () {
    const model = yield* journalModel([
      "# Entry 1\n\nThe 1 th reading of this history.\n",
      "# Entry 2\n\nThe 2 th reading of this history.\n",
      "# Entry 3\n\nThe 3 th reading of this history.\n",
    ]);
    const presenter = yield* usePresenter(NARROW);
    yield* presenter.commit(viewOf(model, NARROW));
    const node = presenter.tree.focused();
    const focused = node === undefined ? undefined : presenter.tree.keyOf(node);
    const closed = viewOf(model, NARROW, { focused });
    yield* presenter.commit(closed);
    const opened = reduceRepl(closed.state, { kind: "open-catalog" }, model, IDLE).state;
    const observed = yield* presenter.commit(viewOf(model, NARROW, { state: opened, focused }));
    console.log("ENTRY KEYS", observed.keys.filter((k) => k.startsWith("entry:")));
    console.log("ALL KEYS", observed.keys.join(" "));
    console.log("DRAWER WINDOW", JSON.stringify(windowOf(observed.committed.admission, DRAWER_WINDOW)));
    console.log("ROWS", JSON.stringify(presenter.grid.rows(), null, 0));
    console.log("REGION IDS", observed.committed.manifest.regions.map((r) => `${r.region}=${r.id}`).join(" "));
    console.log("VIEWPORTS", observed.committed.manifest.viewports.map((v) => `${v.window}=${v.id}`).join(" "));
    console.log("box:identity", JSON.stringify(observed.regionOf("box:identity")), "box:body", JSON.stringify(observed.regionOf("box:body")));
    console.log("CELLS", [...observed.cells.entries()].slice(0, 12).map(([k, v]) => `${k}=>${JSON.stringify(v)}`).join(" | "));
    console.log("footer:history bounds", JSON.stringify(observed.boundsOf("footer:history")));
    const wide = yield* usePresenter(WIDE);
    const w = yield* wide.commit(viewOf(model, WIDE));
    console.log("WIDE profile", w.committed.manifest.profile, "reading window", JSON.stringify(windowOf(w.committed.admission, READING_WINDOW)));
    console.log("WIDE entries heading cell", JSON.stringify(w.cells.get("entries:heading")), "hist", JSON.stringify(w.cells.get("footer:history")));
  });
});
