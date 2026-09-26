/**
 * The expansion-pause evidence, printed.
 *
 *     deno task repl:pause:xmd
 *
 * Five sections, in the order the claim is built.
 *
 * 1. **Coverage.** Which existing surfaces a real representative XMD execution
 *    crosses, and which of them bracket a walk rather than sit inside one —
 *    measured by running the document, not read off the Api declarations.
 * 2. **Playing pass-through.** The same document with and without the REPL
 *    decoration, compared on output and on the journal.
 * 3. **EXPANSION PAUSED.** What the controller reports when Pause arrives while
 *    a component body is running ordinary Effection, and what the document and
 *    the runtime each do across a long hold.
 * 4. **Background recording.** The Journal head advancing past a fixed expansion
 *    pause point, and not being replayed on Continue.
 * 5. **Controls.** Concurrent region walks, and no middleware at all.
 */

import { main, race, scoped, sleep } from "effection";
import type { Operation } from "effection";

import { advanceOf, runSiblingExecution, startXmdFixture } from "./xmd-fixture.ts";

function say(line: string) {
  console.log(line);
}

function heading(line: string) {
  console.log(`\n${line}\n${"-".repeat(line.length)}`);
}

function* bounded<T>(op: Operation<T>, ms: number): Operation<T | "timeout"> {
  return yield* race([
    op,
    (function* () {
      yield* sleep(ms);
      return "timeout" as const;
    })(),
  ]);
}

/** A promise settled from outside Effection. */
function deferred(): { promise: Promise<string>; settle: (v: string) => void } {
  let settle: (value: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function* coverage(): Operation<void> {
  const control = yield* scoped(function* () {
    const fixture = yield* startXmdFixture({ withoutMiddleware: true });
    const output = yield* fixture.execution;
    return {
      output: String(output),
      journal: (yield* fixture.journalKinds()).join(" "),
    };
  });

  yield* scoped(function* () {
    const fixture = yield* startXmdFixture({});
    const output = yield* fixture.execution;
    const gate = fixture.gate;
    if (!gate) {
      return;
    }

    heading("1. coverage — the existing surfaces a real execution crosses");
    const bySurface = new Map<string, { count: number; kind: string }>();
    for (const crossing of gate.crossings) {
      const entry = bySurface.get(crossing.surface) ?? { count: 0, kind: crossing.kind };
      entry.count += 1;
      bySurface.set(crossing.surface, entry);
    }
    say(`${"surface".padEnd(22)} ${"crossings".padEnd(10)} role`);
    say(`${"-".repeat(22)} ${"-".repeat(10)} ${"-".repeat(34)}`);
    for (const [surface, entry] of [...bySurface].toSorted()) {
      say(
        `${surface.padEnd(22)} ${String(entry.count).padEnd(10)} ${
          entry.kind === "walk" ? "brackets one expansion walk" : "step gate inside a walk"
        }`,
      );
    }
    const walkKinds = [
      ...new Set(gate.crossings.filter((c) => c.kind === "walk").map((c) => c.surface)),
    ].toSorted();
    say("");
    say(`walk brackets seen : ${walkKinds.join(", ")}`);
    say(`distinct walks      : ${new Set(gate.crossings.map((c) => c.walk)).size}`);

    heading("2. playing pass-through");
    say(`output identical to the no-middleware control : ${String(output) === control.output}`);
    say(
      `journal identical                             : ${
        (yield* fixture.journalKinds()).join(" ") === control.journal
      }`,
    );
    say(`walks left active                             : ${gate.inspect().walks.length}`);
    say(`continuations held                            : ${gate.inspect().held.length}`);
    say(`controller state                              : ${gate.state}`);
  });
}

function* expansionPaused(): Operation<void> {
  yield* scoped(function* () {
    heading("3. EXPANSION PAUSED — a real execution");
    const external = deferred();
    const fixture = yield* startXmdFixture({ background: external.promise });
    const gate = fixture.gate;
    if (!gate) {
      return;
    }
    const advancing = yield* fixture.advances;

    // Pause while a component body is running ordinary Effection, so this is
    // work already in flight rather than work not yet begun.
    yield* advanceOf(advancing, "slow");

    gate.request();
    say(`state the moment Pause is requested : ${gate.state}`);
    const requested = gate.inspect();
    say(`active walks                        : ${requested.walks.length}`);
    say(`walks still advancing               : ${requested.advancing.length}`);

    const settled = yield* bounded(gate.reached(), 800);
    const resting = gate.inspect();
    say(
      `reached()                           : ${
        settled === "timeout" ? "NEVER SETTLED" : "EXPANSION PAUSED"
      }`,
    );
    say(`state                               : ${resting.state}`);
    say(`active walks                        : ${resting.walks.join(" | ")}`);
    say(`held continuations                  : ${resting.held.join(", ")}`);
    say(`live Effection scopes (diagnostic)  : ${resting.liveScopes}`);

    const journalAtRest = yield* fixture.journalKinds();
    const fanoutAtRest = fixture.fanoutSteps();
    const laterAtRest = fixture.laterRan();
    const heldAtRest = resting.held.join("|");

    // A long hold, measured by an unrelated sibling's own announced advances on a
    // FRESH subscription. The signal buffers from the moment a subscription is
    // taken, so reusing the earlier one would drain a backlog in no time at all
    // and the interval would measure nothing.
    const interval = yield* fixture.advances;
    for (let advance = 0; advance < 30; advance += 1) {
      yield* advanceOf(interval, "sibling");
    }

    say("");
    say(
      `across 30 sibling advances: expansion ${
        fixture.laterRan() === laterAtRest ? "STOPPED" : "ADVANCED"
      }, holds ${heldAtRest === gate.inspect().held.join("|") ? "unchanged" : "MOVED"}`,
    );
    say(
      `ordinary Effection children of a component: ${fanoutAtRest} -> ${fixture.fanoutSteps()} ` +
        `(${fixture.fanoutSteps() > fanoutAtRest ? "still running" : "stopped"})`,
    );
    say(`state after that interval           : ${gate.state}`);

    heading("4. background recording while expansion is paused");
    const beforeExternal = (yield* fixture.journalKinds()).length;
    say(`journal records before external work completes : ${beforeExternal}`);

    // The external system completes while expansion is paused. Its durable
    // outcome is appended normally.
    external.settle("external-done");
    yield* advanceOf(interval, "recorded");

    const afterExternal = yield* fixture.journalKinds();
    say(`journal records after it recorded              : ${afterExternal.length}`);
    say(`the appended record                           : ${afterExternal.at(-1)}`);
    say(
      `expansion pause point                         : ${
        fixture.laterRan() === laterAtRest ? "still fixed" : "MOVED"
      }`,
    );
    say(`controller state                              : ${gate.state}`);
    say("");
    say("This is the distinction the mode name carries: EXPANSION PAUSED, not paused at head.");

    const appendsBeforeContinue = fixture.appendCount();
    gate.release();
    const finished = yield* bounded(fixture.execution, 6000);
    const final = yield* fixture.journalKinds();
    say("");
    say(
      `after Continue: ${
        finished === "timeout" ? "TIMEOUT" : "completed"
      }, released ${gate.releases}, twice ${gate.doubleReleases}`,
    );
    say(
      `the background record appears exactly once    : ${
        final.filter((kind) => kind === "yield:background").length === 1
      }`,
    );
    say(
      `records written before the hold unchanged     : ${
        final.slice(0, journalAtRest.length).join(" ") === journalAtRest.join(" ")
      }`,
    );
    say(`appends before Continue ${appendsBeforeContinue}, after ${fixture.appendCount()}`);
    say(`terminal record                               : ${final.at(-1)}`);
  });
}

function* controls(): Operation<void> {
  yield* scoped(function* () {
    heading("5a. concurrent expansion walks");
    const fixture = yield* startXmdFixture({ concurrentRegions: true });
    const gate = fixture.gate;
    if (!gate) {
      return;
    }
    const advancing = yield* fixture.advances;
    // Pause while both regions are still expanding, not after they finished.
    yield* advanceOf(advancing, "region");
    gate.request();
    yield* bounded(gate.reached(), 800);
    const resting = gate.inspect();
    say(`state         : ${resting.state}`);
    say(`active walks  : ${resting.walks.length}`);
    for (const walk of resting.walks) {
      say(`              ${walk}`);
    }
    say(`still advancing: ${resting.advancing.length}`);
    gate.release();
    yield* bounded(fixture.execution, 6000);
  });

  yield* scoped(function* () {
    heading("5b. a sibling execution, run while the target is paused");
    const fixture = yield* startXmdFixture({});
    const gate = fixture.gate;
    if (!gate) {
      return;
    }
    const advancing = yield* fixture.advances;
    yield* advanceOf(advancing, "slow");
    gate.request();
    yield* bounded(gate.reached(), 800);
    say(`target state: ${gate.state}`);

    const sibling = yield* bounded(runSiblingExecution(), 6000);
    if (sibling !== "timeout") {
      say(`sibling completed  : ${sibling.output.includes("Hello from declared Markdown.")}`);
      say(`sibling journal    : ${sibling.journal.join(" ")}`);
    }
    say(`target still       : ${gate.state}`);
    gate.release();
    yield* bounded(fixture.execution, 6000);
  });

  yield* scoped(function* () {
    heading("5c. control — no REPL middleware at all");
    const fixture = yield* startXmdFixture({ withoutMiddleware: true });
    say(`controller present : ${fixture.gate !== undefined}`);
    const outcome = yield* bounded(fixture.execution, 6000);
    say(`outcome            : ${outcome === "timeout" ? "TIMEOUT" : "completed"}`);
    say(`terminal record    : ${(yield* fixture.journalKinds()).at(-1)}`);
  });
}

await main(function* () {
  yield* coverage();
  yield* expansionPaused();
  yield* controls();
  say("");
});
