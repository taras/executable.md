/**
 * Can middleware around an XMD-owned execution Api hold a live subtree?
 *
 * #841's first slice asks one question, and these cases are chosen so that the
 * answer cannot come from the fixture cooperating. The unrelated sibling runs the
 * *same* mediated loop as the target's children with the decoration absent, so
 * "the target stopped" is measured against a control that did not. Every step is
 * numbered, so a continuation released twice would show up as a duplicate in the
 * history. Every wait is for an announced advance, never for an interval.
 *
 * The last case is the one that matters most: a descendant that advances in
 * ordinary Effection without invoking the Api. It is not a contrived escape — it
 * is what any component does between two journaled steps — and the gate can
 * never report `paused` while it is live. That case failing is the finding, not
 * a defect in the fixture.
 */

import { describe as suite, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { race, sleep } from "effection";
import type { Operation } from "effection";

import { advanceOf, startFixture } from "../repl-pause/fixture.ts";
import { advanceOf as advanceOfXmd, isolated, startXmdFixture } from "../repl-pause/xmd-fixture.ts";

/**
 * A promise settled from outside Effection, standing in for a subprocess or a
 * provider request. Built by hand rather than with `Promise.withResolvers`,
 * which the oldest runtime in the matrix does not have.
 */
function deferred(): { promise: Promise<string>; settle: (v: string) => void } {
  let settle: (value: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * Give an operation a bound so a wedged handshake reports instead of hanging.
 *
 * Nothing asserts on the bound: a case that depends on which branch won would be
 * an elapsed-time assumption. It exists so that "never settles" is a returned
 * value the negative control can name.
 */
function* bounded<T>(operation: Operation<T>, label: string): Operation<T | string> {
  return yield* race([
    operation,
    (function* () {
      yield* sleep(250);
      return `unsettled:${label}`;
    })(),
  ]);
}

suite("REPL pause — the XMD execution Api as a pause seam", () => {
  it("dispatches every target descendant through the middleware installed on the target, and nothing outside it", function* () {
    const fixture = yield* startFixture({ childB: "mediated" });
    const advancing = yield* fixture.advances;

    yield* advanceOf(advancing, "childA");
    yield* advanceOf(advancing, "childB");
    yield* advanceOf(advancing, "entry");

    const seen = fixture.gate.inspect();

    // The entry task and both nested children — one and two levels below the
    // scope the decoration was installed on.
    expect(seen.live.length).toBe(3);
    expect(seen.mediated.length).toBe(3);
    expect(seen.live.join(" ")).toContain("childA");
    expect(seen.live.join(" ")).toContain("childB");

    // The sibling has been running the identical mediated loop the whole time.
    expect(fixture.journal.headOf("sibling")).toBeGreaterThan(0);
    expect(seen.strangers).toEqual([]);
  });

  it("enters pausing at once, and reaches paused only once every live descendant is held", function* () {
    const fixture = yield* startFixture({ childB: "mediated" });
    const advancing = yield* fixture.advances;
    yield* advanceOf(advancing, "childA");

    expect(fixture.gate.state).toBe("running");

    fixture.gate.request();

    // Synchronous with the request: no continuation has run in between.
    expect(fixture.gate.state).toBe("pausing");
    const requested = fixture.gate.inspect();
    expect(requested.state).toBe("pausing");
    expect(requested.held).toEqual([]);
    expect(requested.unaccounted.length).toBe(3);

    const report = yield* bounded(fixture.gate.reached(), "reached");

    expect(fixture.gate.state).toBe("paused");
    const settled = fixture.gate.inspect();
    expect(settled.unaccounted).toEqual([]);
    expect(settled.held.length).toBe(3);
    expect(report).toEqual({
      held: settled.held,
      targetHead: settled.targetHead,
    });

    fixture.gate.release();
  });

  it("holds the target's progress and history while the unrelated sibling advances and the controller stays usable", function* () {
    const fixture = yield* startFixture({ childB: "mediated" });
    const advancing = yield* fixture.advances;
    yield* advanceOf(advancing, "childA");

    fixture.gate.request();
    yield* bounded(fixture.gate.reached(), "reached");
    expect(fixture.gate.state).toBe("paused");

    const atPause = fixture.gate.inspect();

    // The decoration was installed on the target scope, and what it is holding
    // two levels down is an ordinary advance, not a creation.
    expect(atPause.held.join(" ")).toMatch(/childA\)@stepp?e?d?:childA#/);

    const targetRecords = fixture.journal.snapshot().filter((record) => record.owner !== "sibling");
    const siblingAtPause = fixture.journal.headOf("sibling");

    // Both sides of the comparison are measured across the same interval, and
    // the interval is defined by the sibling's own announced advances.
    for (let advance = 0; advance < 5; advance += 1) {
      yield* advanceOf(advancing, "sibling");
    }

    const afterPause = fixture.gate.inspect();

    expect(afterPause.state).toBe("paused");
    expect(afterPause.targetHead).toBe(atPause.targetHead);
    expect(afterPause.held).toEqual(atPause.held);
    expect(afterPause.unaccounted).toEqual([]);
    expect(fixture.journal.snapshot().filter((record) => record.owner !== "sibling")).toEqual(
      targetRecords,
    );

    expect(fixture.journal.headOf("sibling")).toBeGreaterThan(siblingAtPause);

    fixture.gate.release();
  });

  it("releases the same held continuations exactly once, and repeats no completed work", function* () {
    const fixture = yield* startFixture({ childB: "mediated" });
    const advancing = yield* fixture.advances;
    yield* advanceOf(advancing, "childA");

    fixture.gate.request();
    yield* bounded(fixture.gate.reached(), "reached");

    const held = fixture.gate.inspect().held;
    const before = fixture.journal.snapshot();
    const releasesBefore = fixture.gate.releases;

    // Without this, a gate that held nothing at all would satisfy every
    // assertion below by releasing nothing exactly zero times.
    expect(fixture.gate.state).toBe("paused");
    expect(held.length).toBe(3);

    fixture.gate.release();

    expect(fixture.gate.state).toBe("running");
    expect(fixture.gate.releases - releasesBefore).toBe(3);
    expect(fixture.gate.doubleReleases).toBe(0);

    yield* advanceOf(advancing, "childA");
    yield* advanceOf(advancing, "childB");
    yield* advanceOf(advancing, "entry");

    const after = fixture.journal.snapshot();

    // The released continuations carried on from where they were held.
    expect(after.length).toBeGreaterThan(before.length);

    // Nothing before the pause was rewritten or appended again, and no label
    // occurs twice — a replayed or respawned continuation would do both.
    expect(after.slice(0, before.length)).toEqual(before);
    const labels = after.map((record) => `${record.owner}:${record.label}`);
    expect(new Set(labels).size).toBe(labels.length);
    expect(fixture.gate.doubleReleases).toBe(0);
  });

  it("keeps a mediated external operation's continuation held after the external work has completed", function* () {
    const pending = deferred();
    const fixture = yield* startFixture({
      childB: "mediated",
      pending: pending.promise,
    });
    const advancing = yield* fixture.advances;
    yield* advanceOf(advancing, "childB");

    // Child A is inside the external operation, so it is live and unheld: the
    // pause cannot settle while external work is in flight.
    fixture.gate.request();
    expect(fixture.gate.inspect().unaccounted.length).toBe(3);
    expect(fixture.pastExternal()).toBe(0);

    // The external system completes while the subtree is being paused. Nothing
    // about the gate reached it, and its continuation must still be held.
    pending.settle("done");

    yield* bounded(fixture.gate.reached(), "reached");
    expect(fixture.gate.state).toBe("paused");

    const settled = fixture.gate.inspect();
    expect(settled.held.join(" ")).toContain("returned:await");
    expect(fixture.pastExternal()).toBe(0);

    // The record the external operation produced was journaled while `pausing`,
    // before the subtree was held — the head is fixed from `paused`, not before.
    expect(fixture.journal.labelsOf("childA")).toEqual(["await=done"]);

    fixture.gate.release();
    yield* advanceOf(advancing, "childA");
    expect(fixture.pastExternal()).toBe(1);
  });

  it("never settles a pause while an unmediated descendant is live, and names it", function* () {
    const fixture = yield* startFixture({ childB: "raw" });
    const advancing = yield* fixture.advances;
    yield* advanceOf(advancing, "childA");
    yield* advanceOf(advancing, "childB");

    const running = fixture.gate.inspect();
    expect(running.live.length).toBe(3);

    // Child B *is* dispatched through the middleware — once, when it is forked.
    // Being mediated at creation is not the same as being pausable: every
    // advance after that is ordinary Effection, and the journal shows it
    // never comes back to the boundary.
    expect(running.mediated.length).toBe(3);
    expect(fixture.journal.headOf("childB")).toBe(0);
    expect(fixture.journal.headOf("childA")).toBeGreaterThan(0);

    fixture.gate.request();

    const outcome = yield* bounded(fixture.gate.reached(), "reached");

    expect(outcome).toBe("unsettled:reached");
    expect(fixture.gate.state).toBe("pausing");

    const stuck = fixture.gate.inspect();
    expect(stuck.held.length).toBe(2);
    expect(stuck.unaccounted.length).toBe(1);
    expect(stuck.unaccounted.join(" ")).toContain("childB");

    // And it is not merely unheld — it is still advancing while the two
    // mediated descendants are held.
    const advanced = yield* advanceOf(advancing, "childB");
    expect(advanced.count).toBeGreaterThan(1);
    expect(fixture.gate.inspect().state).toBe("pausing");

    fixture.gate.release();
  });
});

/**
 * Slice 2 — the REPL-owned design, over the surfaces that already exist.
 *
 * Slice 1 asked what middleware around *an* Api can do. These cases ask the
 * question that decides the design: are XMD's existing execution, component and
 * REPL-owned expansion surfaces enough for a REPL to pause one real document
 * execution, with no new core pause API?
 *
 * The answer is in the last three cases, and it is a boundary rather than a
 * failure. Pass-through is exact, the document really does come to rest at a
 * boundary, its journal really is fixed, and Continue really does release the
 * same continuation once. What the REPL cannot do is *certify* it: a real
 * execution keeps engine-owned scopes alive that never re-enter any surface a
 * REPL can reach, so the fail-closed controller stays in `pausing` and names
 * them. It never reports `paused`, which is why nothing here asserts that it
 * does — an assertion satisfied by a state the design never reaches would prove
 * nothing at all.
 */

const advanceOfExecution = advanceOfXmd;

suite("REPL pause — the existing XMD surfaces", () => {
  it("installs before the execution and delegates immediately while playing", function* () {
    const control = yield* isolated(function* () {
      const fixture = yield* startXmdFixture({ withoutMiddleware: true });
      expect(fixture.gate).toBe(undefined);
      const output = yield* fixture.execution;
      return { output: String(output), journal: yield* fixture.journalKinds() };
    });

    const instrumented = yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const output = yield* fixture.execution;
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("the instrumented run must have a gate");
      }
      return {
        output: String(output),
        journal: yield* fixture.journalKinds(),
        surfaces: [...new Set(gate.crossings.map((c) => c.surface))].toSorted(),
        held: gate.inspect().held,
        state: gate.state,
        releases: gate.releases,
      };
    });

    // Pass-through is exact: same ordered application trace, same outcome.
    expect(instrumented.output).toBe(control.output);
    expect(instrumented.journal).toEqual(control.journal);

    // Observation is present, across every surface the document actually used.
    expect(instrumented.surfaces).toEqual([
      "applyBoundModifiers",
      "applyModifiers",
      "codeBlock",
      "content",
      "document",
      "expand",
      "importComponent",
      "replCheckpoint",
    ]);

    // Nothing waited and no gate was retained.
    expect(instrumented.held).toEqual([]);
    expect(instrumented.state).toBe("playing");
    expect(instrumented.releases).toBe(0);
  });

  it("enters pausing synchronously and lets work already inside reach its next boundary", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* fixture.advances;

      // Pause only once a component body is demonstrably running ordinary
      // Effection, so this is work already in flight and not work not yet begun.
      yield* advanceOfExecution(advancing, "slow");
      const stepsAtRequest = fixture.slowSteps();
      expect(stepsAtRequest).toBeGreaterThan(0);

      expect(gate.state).toBe("playing");
      gate.request();
      expect(gate.state).toBe("pausing");

      yield* bounded(gate.reached(), "reached");

      // The call already inside finished, and the walk stopped at the next
      // existing boundary rather than being cut short inside the component.
      expect(fixture.slowSteps()).toBeGreaterThan(stepsAtRequest);
      const resting = gate.inspect();
      expect(resting.held.length).toBeGreaterThan(0);
      expect(resting.held.join(" ")).toMatch(/importComponent|applyModifiers|expand/);

      gate.release();
      yield* fixture.execution;
    });
  });

  it("fixes the target's journal while it rests, and the unrelated sibling keeps advancing", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* fixture.advances;
      yield* advanceOfExecution(advancing, "slow");

      gate.request();
      yield* bounded(gate.reached(), "reached");

      const journalAtRest = yield* fixture.journalKinds();
      const heldAtRest = gate.inspect().held;
      expect(heldAtRest.length).toBeGreaterThan(0);

      // The interval is defined by the sibling's own announced advances, so both
      // sides of the comparison are measured across the same stretch of time.
      for (let advance = 0; advance < 20; advance += 1) {
        yield* advanceOfExecution(advancing, "sibling");
      }

      expect(yield* fixture.journalKinds()).toEqual(journalAtRest);
      expect(gate.inspect().held).toEqual(heldAtRest);

      gate.release();
      yield* fixture.execution;
    });
  });

  it("never reports paused for a real execution, and names the scopes it cannot account for", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* fixture.advances;
      yield* advanceOfExecution(advancing, "slow");

      gate.request();
      const outcome = yield* bounded(gate.reached(), "reached");

      // This is the finding. The controller is fail-closed, so it refuses to
      // certify a subtree it cannot fully account for.
      expect(outcome).toBe("unsettled:reached");
      expect(gate.state).toBe("pausing");

      const seen = gate.inspect();
      expect(seen.unaccounted.length).toBeGreaterThan(0);
      // Most live descendants of a real execution are engine-owned and never
      // re-enter any surface a REPL can reach.
      expect(seen.crossed.length).toBeLessThan(seen.live.length);
      expect(seen.held.length).toBeLessThan(seen.live.length);

      gate.release();
      yield* fixture.execution;
    });
  });

  it("releases the retained continuation exactly once and completes without replaying", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* fixture.advances;
      yield* advanceOfExecution(advancing, "slow");

      gate.request();
      yield* bounded(gate.reached(), "reached");

      const held = gate.inspect().held;
      const journalAtRest = yield* fixture.journalKinds();
      // Without this the assertions below would be satisfied by a controller
      // that held nothing and released nothing.
      expect(held.length).toBeGreaterThan(0);

      gate.release();
      expect(gate.state).toBe("playing");
      expect(gate.releases).toBe(held.length);
      expect(gate.doubleReleases).toBe(0);

      const output = yield* fixture.execution;
      const journal = yield* fixture.journalKinds();

      // The released continuation carried on from where it was held: the run
      // reached its expected result, the records written before the hold are
      // still the same records, and nothing was written twice.
      expect(String(output)).toContain("Hello from declared Markdown.");
      expect(String(output)).toContain("Projected content the component asks for.");
      expect(journal.slice(0, journalAtRest.length)).toEqual(journalAtRest);
      expect(journal.length).toBeGreaterThan(journalAtRest.length);
      expect(journal.at(-1)).toBe("close");
      expect(gate.doubleReleases).toBe(0);
    });
  });

  it("keeps the controller pausing while a legitimate descendant bypasses every controlled surface", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({ bypass: true });
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* fixture.advances;

      // The bypassing child is a spawned descendant of a component body. It asks
      // the engine for nothing, which is what any component does between two
      // boundaries — not a contrived escape.
      yield* advanceOfExecution(advancing, "bypass");
      const stepsAtRequest = fixture.bypassSteps();

      gate.request();
      const outcome = yield* bounded(gate.reached(), "reached");

      expect(outcome).toBe("unsettled:reached");
      expect(gate.state).toBe("pausing");
      expect(gate.inspect().unaccounted.length).toBeGreaterThan(0);

      // And it is not merely unaccounted for — it is still advancing.
      yield* advanceOfExecution(advancing, "bypass");
      expect(fixture.bypassSteps()).toBeGreaterThan(stepsAtRequest);
      expect(gate.state).toBe("pausing");

      gate.release();
      yield* fixture.execution;
    });
  });

  it("leaves ordinary execution behind when the REPL middleware is removed", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({ withoutMiddleware: true });

      // No controller, so no pause status, no retained gate and no accounting.
      expect(fixture.gate).toBe(undefined);

      const output = yield* fixture.execution;
      expect(String(output)).toContain("Hello from declared Markdown.");
      const journal = yield* fixture.journalKinds();
      expect(journal.at(-1)).toBe("close");
    });
  });
});
