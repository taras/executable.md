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
