/**
 * The representative lifecycle trace for #841's first slice.
 *
 *     deno task repl:pause
 *
 * Two traces are printed, because the finding is a boundary rather than a
 * capability. The first follows a subtree whose every advance is an invocation
 * of the XMD execution Api: it reaches `paused`, holds its history, and releases
 * each continuation once. The second changes one thing — a child that advances in
 * ordinary Effection — and the same controller can never report `paused` at all.
 *
 * Every row is read from the gate at the moment the phase ends, and every phase
 * boundary is an announced advance rather than an elapsed interval. Where a
 * number depends on how many times a loop got to run, the row reports the
 * relation the contract cares about ("fixed", "advanced") instead, so the trace
 * is the same on every machine.
 */

import { main, race, scoped, sleep } from "effection";
import type { Operation } from "effection";

import { advanceOf, startFixture } from "./fixture.ts";
import type { Fixture } from "./fixture.ts";

interface Row {
  readonly phase: string;
  readonly state: string;
  readonly live: number;
  readonly held: number;
  readonly unaccounted: string;
  readonly history: string;
  readonly sibling: string;
  readonly resumes: string;
}

function render(rows: readonly Row[]): string[] {
  const columns: Array<[string, (row: Row) => string]> = [
    ["phase", (row) => row.phase],
    ["controller", (row) => row.state],
    ["live", (row) => String(row.live)],
    ["held", (row) => String(row.held)],
    ["live & unheld", (row) => row.unaccounted],
    ["target history", (row) => row.history],
    ["sibling", (row) => row.sibling],
    ["resumes", (row) => row.resumes],
  ];

  const widths = columns.map(([heading, read]) =>
    Math.max(heading.length, ...rows.map((row) => read(row).length)),
  );

  const line = (cells: string[]) =>
    cells
      .map((cell, at) => cell.padEnd(widths[at]))
      .join("  ")
      .trimEnd();

  return [
    line(columns.map(([heading]) => heading)),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => line(columns.map(([, read]) => read(row)))),
  ];
}

/** Wait for the handshake, but report rather than hang if it cannot settle. */
function* settleOrReport(fixture: Fixture): Operation<boolean> {
  const outcome = yield* race([
    (function* () {
      yield* fixture.gate.reached();
      return true;
    })(),
    (function* () {
      yield* sleep(250);
      return false;
    })(),
  ]);
  return outcome;
}

function* traceMediated(): Operation<string[]> {
  const fixture = yield* startFixture({ childB: "mediated" });
  const advancing = yield* fixture.advances;
  const rows: Row[] = [];

  yield* advanceOf(advancing, "childA");
  yield* advanceOf(advancing, "childB");
  yield* advanceOf(advancing, "entry");

  const running = fixture.gate.inspect();
  const siblingAtStart = fixture.journal.headOf("sibling");
  rows.push({
    phase: "1 every execution advancing",
    state: running.state,
    live: running.live.length,
    held: running.held.length,
    unaccounted: `${running.unaccounted.length}`,
    history: `${running.targetHead}`,
    sibling: `${siblingAtStart}`,
    resumes: `${fixture.gate.releases}`,
  });

  fixture.gate.request();
  const requested = fixture.gate.inspect();
  rows.push({
    phase: "2 pause requested",
    state: requested.state,
    live: requested.live.length,
    held: requested.held.length,
    unaccounted: `${requested.unaccounted.length} still advancing`,
    history: `${requested.targetHead}`,
    sibling: `${fixture.journal.headOf("sibling")}`,
    resumes: `${fixture.gate.releases}`,
  });

  const settled = yield* settleOrReport(fixture);
  const paused = fixture.gate.inspect();
  rows.push({
    phase: "3 every descendant held",
    state: settled ? paused.state : `${paused.state} (unsettled)`,
    live: paused.live.length,
    held: paused.held.length,
    unaccounted: `${paused.unaccounted.length}`,
    history: `${paused.targetHead}`,
    sibling: `${fixture.journal.headOf("sibling")}`,
    resumes: `${fixture.gate.releases}`,
  });

  const heldAt = paused.held;
  const headAt = paused.targetHead;
  const siblingAt = fixture.journal.headOf("sibling");
  for (let advance = 0; advance < 5; advance += 1) {
    yield* advanceOf(advancing, "sibling");
  }
  const during = fixture.gate.inspect();
  rows.push({
    phase: "4 five sibling advances later",
    state: during.state,
    live: during.live.length,
    held: during.held.length,
    unaccounted: `${during.unaccounted.length}`,
    history: during.targetHead === headAt ? "fixed" : "MOVED",
    sibling: fixture.journal.headOf("sibling") > siblingAt ? "advanced" : "STALLED",
    resumes: `${fixture.gate.releases}`,
  });

  const sameContinuations = during.held.join("|") === heldAt.join("|") ? "same" : "CHANGED";

  fixture.gate.release();
  const released = fixture.gate.inspect();
  rows.push({
    phase: "5 continue",
    state: released.state,
    live: released.live.length,
    held: released.held.length,
    unaccounted: `${released.unaccounted.length}`,
    history: `${released.targetHead}`,
    sibling: `${fixture.journal.headOf("sibling")}`,
    resumes: `${fixture.gate.releases} (${fixture.gate.doubleReleases} twice)`,
  });

  yield* advanceOf(advancing, "childA");
  yield* advanceOf(advancing, "childB");
  yield* advanceOf(advancing, "entry");
  const after = fixture.gate.inspect();
  rows.push({
    phase: "6 every execution advancing",
    state: after.state,
    live: after.live.length,
    held: after.held.length,
    unaccounted: `${after.unaccounted.length}`,
    history: after.targetHead > headAt ? "advanced" : "STALLED",
    sibling: "advanced",
    resumes: `${fixture.gate.releases}`,
  });

  const labels = fixture.journal.snapshot().map((record) => `${record.owner}:${record.label}`);

  return [
    "Trace A — every advance mediated by the XMD execution Api",
    "",
    ...render(rows),
    "",
    `held continuations at pause : ${heldAt.join(", ")}`,
    `the same ones five sibling advances later : ${sameContinuations}`,
    `history duplicated any label after continue : ${
      new Set(labels).size === labels.length ? "no" : "YES"
    }`,
  ];
}

function* traceUnmediated(): Operation<string[]> {
  const fixture = yield* startFixture({ childB: "raw" });
  const advancing = yield* fixture.advances;
  const rows: Row[] = [];

  yield* advanceOf(advancing, "childA");
  yield* advanceOf(advancing, "childB");

  fixture.gate.request();
  const requested = fixture.gate.inspect();
  rows.push({
    phase: "1 pause requested",
    state: requested.state,
    live: requested.live.length,
    held: requested.held.length,
    unaccounted: `${requested.unaccounted.length}`,
    history: `${requested.targetHead}`,
    sibling: `${fixture.journal.headOf("sibling")}`,
    resumes: `${fixture.gate.releases}`,
  });

  const settled = yield* settleOrReport(fixture);
  const stuck = fixture.gate.inspect();
  rows.push({
    phase: "2 handshake given up on",
    state: settled ? stuck.state : `${stuck.state} (never settles)`,
    live: stuck.live.length,
    held: stuck.held.length,
    unaccounted: stuck.unaccounted.join(", "),
    history: `${stuck.targetHead}`,
    sibling: `${fixture.journal.headOf("sibling")}`,
    resumes: `${fixture.gate.releases}`,
  });

  const before = yield* advanceOf(advancing, "childB");
  const after = yield* advanceOf(advancing, "childB");
  const moving = fixture.gate.inspect();
  rows.push({
    phase: "3 child B advances twice more",
    state: moving.state,
    live: moving.live.length,
    held: moving.held.length,
    unaccounted: moving.unaccounted.join(", "),
    history: `${moving.targetHead}`,
    sibling: `${fixture.journal.headOf("sibling")}`,
    resumes: `${fixture.gate.releases}`,
  });

  fixture.gate.release();

  return [
    "Trace B — one descendant advancing in ordinary Effection",
    "",
    ...render(rows),
    "",
    `child B advanced ${before.count} -> ${after.count} while the controller was pausing`,
    `child B journal records : ${fixture.journal.headOf("childB")}`,
    "",
    "Child B is dispatched through the middleware exactly once, when it is forked.",
    "Being mediated at creation is not being pausable: every advance after that is",
    "raw Effection, so the gate never holds it and `paused` is never reported. The",
    "controller fails closed — it does not mistake an unheld descendant for a",
    "suspended one — but it also cannot pause the subtree.",
  ];
}

await main(function* () {
  // Each trace gets its own scope. The executions of the first one are live
  // until it ends, and they append to whichever journal the session context
  // holds — so running them in one scope would let trace A write trace B's
  // history.
  const mediated = yield* scoped(traceMediated);
  const unmediated = yield* scoped(traceUnmediated);

  for (const line of [...mediated, "", "", ...unmediated]) {
    console.log(line);
  }
});
