/**
 * Slice 2's evidence, printed: the coverage inventory and the lifecycle trace.
 *
 *     deno task repl:pause:xmd
 *
 * Four sections, in the order the finding is built.
 *
 * 1. **Coverage.** Which existing surfaces a real representative XMD execution
 *    actually crosses, how often, and in whose scope — measured by running the
 *    document, not read off the Api declarations.
 * 2. **Playing pass-through.** The same document with and without the REPL
 *    decoration, compared on output and on the journal.
 * 3. **Pause.** What the fail-closed controller sees when Pause arrives while a
 *    component body is running ordinary Effection, and what the document does
 *    across a long hold measured by a sibling's own advances.
 * 4. **Controls.** The bypassing descendant, and no middleware at all.
 *
 * Where a number depends on how many times a loop got to run, the row reports
 * the relation the contract cares about ("fixed", "advanced") instead.
 */

import { main, race, scoped, sleep } from "effection";
import type { Operation } from "effection";

import { advanceOf, startXmdFixture } from "./xmd-fixture.ts";
import type { XmdFixture } from "./xmd-fixture.ts";

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

/** Section 1 + 2: what the execution crosses, and that it is unchanged. */
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

    heading("1. coverage — which existing surfaces a real execution crosses");

    const bySurface = new Map<string, { count: number; scopes: Set<string> }>();
    for (const crossing of gate.crossings) {
      const entry = bySurface.get(crossing.surface) ?? { count: 0, scopes: new Set<string>() };
      entry.count += 1;
      entry.scopes.add(crossing.scope);
      bySurface.set(crossing.surface, entry);
    }

    say(`${"surface".padEnd(22)} ${"crossings".padEnd(10)} ${"scopes".padEnd(8)} kind`);
    say(`${"-".repeat(22)} ${"-".repeat(10)} ${"-".repeat(8)} ${"-".repeat(28)}`);
    for (const [surface, entry] of [...bySurface].toSorted()) {
      const kind =
        surface === "expand" || surface === "replCheckpoint"
          ? "REPL-owned handler"
          : "contextual Api middleware";
      say(
        `${surface.padEnd(22)} ${String(entry.count).padEnd(10)} ${String(entry.scopes.size).padEnd(
          8,
        )} ${kind}`,
      );
    }
    say("");
    say("Every one of these can hold a continuation, because each is an operation the");
    say("REPL wraps. api.Scope is used for accounting only and appears in no row here.");

    heading("2. playing pass-through");
    say(`output identical to the no-middleware control : ${String(output) === control.output}`);
    say(
      `journal identical                             : ${
        (yield* fixture.journalKinds()).join(" ") === control.journal
      }`,
    );
    say(`calls waiting at the end                      : ${gate.inspect().held.length}`);
    say(`pause gates retained                          : ${gate.releases}`);
    say(`controller state                              : ${gate.state}`);
  });
}

/** Section 3 + 4: the pause lifecycle, and the controls. */
function* lifecycle(label: string, bypass: boolean): Operation<void> {
  yield* scoped(function* () {
    heading(label);
    const fixture: XmdFixture = yield* startXmdFixture({ bypass });
    const gate = fixture.gate;
    if (!gate) {
      return;
    }
    const advancing = yield* fixture.advances;

    // Pause only once the descendant whose body runs ordinary Effection is
    // demonstrably live, so this is work already in flight.
    yield* advanceOf(advancing, bypass ? "bypass" : "slow");
    const stepsAtRequest = bypass ? fixture.bypassSteps() : fixture.slowSteps();
    const journalAtRequest = (yield* fixture.journalKinds()).length;

    gate.request();
    say(`state the moment Pause is requested : ${gate.state}`);

    const settled = yield* bounded(gate.reached(), 400);
    const resting = gate.inspect();

    say(
      `reached()                           : ${settled === "timeout" ? "NEVER SETTLES" : "paused"}`,
    );
    say(`state                               : ${resting.state}`);
    say(`live descendant scopes              : ${resting.live.length}`);
    say(
      `held at a controlled boundary       : ${resting.held.length}  [${resting.held.join(", ")}]`,
    );
    say(
      `live and unheld                     : ${resting.unaccounted.length}  [${resting.unaccounted.join(
        ", ",
      )}]`,
    );
    say(
      `ever crossed a controlled surface   : ${resting.crossed.length}  [${resting.crossed.join(
        ", ",
      )}]`,
    );
    say(`still inside an operation           : [${resting.inFlight.join(", ")}]`);

    const stepsAtRest = bypass ? fixture.bypassSteps() : fixture.slowSteps();
    say(
      `work already inside                 : ${stepsAtRequest} -> ${stepsAtRest} (${
        stepsAtRest > stepsAtRequest ? "finished or reached its next boundary" : "unchanged"
      })`,
    );

    // A long hold, measured by the sibling's own announced advances.
    const journalAtRest = yield* fixture.journalKinds();
    const heldAtRest = resting.held.join("|");
    for (let advance = 0; advance < 30; advance += 1) {
      yield* advanceOf(advancing, "sibling");
    }
    const journalAfter = yield* fixture.journalKinds();
    say(
      `across 30 sibling advances          : journal ${
        journalAfter.length === journalAtRest.length ? "fixed" : "MOVED"
      }, held ${heldAtRest === gate.inspect().held.join("|") ? "unchanged" : "MOVED"}`,
    );
    say(`sibling                             : advanced (that interval is its own)`);
    say(`journal records                     : ${journalAtRequest} -> ${journalAfter.length}`);

    gate.release();
    const finished = yield* bounded(fixture.execution, 6000);
    const final = yield* fixture.journalKinds();
    say(
      `after Continue                      : ${
        finished === "timeout" ? "TIMEOUT" : "completed"
      }, released ${gate.releases}, twice ${gate.doubleReleases}`,
    );
    say(
      `records before the hold unchanged   : ${
        final.slice(0, journalAtRest.length).join(" ") === journalAtRest.join(" ")
      }`,
    );
    say(`terminal record                     : ${final.at(-1)}`);
  });
}

function* noMiddleware(): Operation<void> {
  yield* scoped(function* () {
    heading("4b. control — no REPL middleware at all");
    const fixture = yield* startXmdFixture({ withoutMiddleware: true });
    say(`controller present                  : ${fixture.gate !== undefined}`);
    const outcome = yield* bounded(fixture.execution, 6000);
    say(`outcome                             : ${outcome === "timeout" ? "TIMEOUT" : "completed"}`);
    const journal = yield* fixture.journalKinds();
    say(`terminal record                     : ${journal.at(-1)}`);
    say(`pause status, retained gate, accounting: none — there is no controller`);
  });
}

await main(function* () {
  yield* coverage();
  yield* lifecycle("3. pause — ordinary document", false);
  yield* lifecycle("4a. control — a descendant that bypasses every surface", true);
  yield* noMiddleware();
  say("");
});
