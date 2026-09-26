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
import {
  advanceOf as advanceOfXmd,
  isolated,
  runSiblingExecution,
  startXmdFixture,
} from "../repl-pause/xmd-fixture.ts";
import type { XmdFixture } from "../repl-pause/xmd-fixture.ts";

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

/** How a task settled, as a string, so a terminal outcome can be compared. */
function* settlement(task: Operation<unknown>): Operation<string> {
  try {
    const value = yield* task;
    return `ok:${String(value).slice(0, 24)}`;
  } catch (error) {
    return `threw:${error instanceof Error ? error.message : String(error)}`;
  }
}

const advanceOfExecution = advanceOfXmd;

/**
 * A fresh advance subscription.
 *
 * The advance signal buffers everything since the moment a subscription is taken,
 * so an interval measured on an old subscription drains a backlog instantly and
 * measures no time at all. Every interval below starts from a new one.
 */
function freshAdvances(fixture: XmdFixture) {
  return fixture.advances;
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
 * EXPANSION PAUSED — pausing XMD expansion over the surfaces XMD already has.
 *
 * The obligation set is **expansion walks**, not Effection scopes. Effection is
 * the runtime and it keeps running: tasks stay live, timers fire, external work
 * finishes, and background work records what it produced. What these cases prove
 * is that the *expansion* of one execution subtree stops, that the controller can
 * say so, and that the durable Journal is free to move past the fixed expansion
 * pause point while it is stopped.
 *
 * `paused` here means exactly: every active expansion walk in the selected
 * subtree is held at an expansion boundary or has settled. It does not mean the
 * runtime is quiescent, that external systems are frozen, or that the History
 * head is stationary.
 *
 * Every interval is measured on a **fresh** advance subscription, because the
 * signal buffers from the moment a subscription is taken — an interval measured
 * on an older one drains a backlog and measures nothing.
 */

suite("REPL pause — EXPANSION PAUSED over existing XMD surfaces", () => {
  it("1+15. is transparent while playing, and every expansion path crosses a controlled boundary", function* () {
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
        throw new Error("expected a gate");
      }
      return {
        output: String(output),
        journal: yield* fixture.journalKinds(),
        surfaces: [...new Set(gate.crossings.map((c) => c.surface))].toSorted(),
        brackets: [
          ...new Set(gate.crossings.filter((c) => c.kind === "walk").map((c) => c.surface)),
        ].toSorted(),
        walks: gate.inspect().walks,
        held: gate.inspect().held,
        state: gate.state,
        releases: gate.releases,
      };
    });

    // Transparent: same behaviour and the same recorded outcomes.
    expect(instrumented.output).toBe(control.output);
    expect(instrumented.journal).toEqual(control.journal);

    // The boundary inventory. Every expansion path the document exercises crosses
    // one of these, including document output — which is what covers prose.
    expect(instrumented.surfaces).toEqual([
      "applyBoundModifiers",
      "applyModifiers",
      "codeBlock",
      "content",
      "document",
      "expand",
      "importComponent",
      "output",
      "region",
      "replCheckpoint",
      "retain",
    ]);
    // Four of them bracket a walk; the rest are step gates inside one.
    expect(instrumented.brackets).toEqual(["content", "document", "expand", "region"]);

    // Nothing waited and nothing was retained.
    expect(instrumented.walks).toEqual([]);
    expect(instrumented.held).toEqual([]);
    expect(instrumented.state).toBe("playing");
    expect(instrumented.releases).toBe(0);
  });

  it("2+4+7. reaches EXPANSION PAUSED on a real execution while ordinary Effection work keeps running", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* freshAdvances(fixture);

      // Pause while a component body is running ordinary Effection, and after a
      // component has already spawned ordinary children of its own.
      yield* advanceOfExecution(advancing, "slow");
      expect(fixture.fanoutSteps()).toBeGreaterThan(0);

      expect(gate.state).toBe("playing");
      gate.request();
      expect(gate.state).toBe("pausing");

      const report = yield* bounded(gate.reached(), "reached");

      // The real execution reaches it. This is the corrected claim.
      expect(gate.state).toBe("paused");
      const resting = gate.inspect();
      expect(resting.advancing).toEqual([]);
      expect(resting.held.length).toBeGreaterThan(0);
      expect(report).toEqual(resting);

      // The runtime is demonstrably busy, and that is not a pause obligation.
      expect(resting.liveScopes).toBeGreaterThan(5);

      const laterAtRest = fixture.laterRan();
      const fanoutAtRest = fixture.fanoutSteps();
      const heldAtRest = resting.held.join("|");
      expect(laterAtRest).toBe(0);

      // A real interval, on a fresh subscription.
      const interval = yield* freshAdvances(fixture);
      for (let advance = 0; advance < 20; advance += 1) {
        yield* advanceOfExecution(interval, "sibling");
      }

      // Expansion is stopped: the next element has still not expanded, and the
      // same continuation is still held in the same place.
      expect(fixture.laterRan()).toBe(laterAtRest);
      expect(gate.inspect().held.join("|")).toBe(heldAtRest);
      expect(gate.state).toBe("paused");

      // And ordinary Effection descendants of a component carried on throughout.
      expect(fixture.fanoutSteps()).toBeGreaterThan(fanoutAtRest);

      gate.release();
      yield* fixture.execution;
      expect(fixture.laterRan()).toBe(1);
    });
  });

  it("5+6+7+8. records external work durably while paused, keeps expansion stopped, and replays nothing", function* () {
    yield* isolated(function* () {
      const external = deferred();
      const fixture = yield* startXmdFixture({ background: external.promise });
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* freshAdvances(fixture);
      yield* advanceOfExecution(advancing, "slow");

      gate.request();
      yield* bounded(gate.reached(), "reached");
      expect(gate.state).toBe("paused");

      const journalAtRest = yield* fixture.journalKinds();
      const laterAtRest = fixture.laterRan();
      const heldAtRest = gate.inspect().held.join("|");

      // The external system completes while expansion is paused. Nothing the
      // controller did reached it.
      const interval = yield* freshAdvances(fixture);
      external.settle("external-done");
      yield* advanceOfExecution(interval, "recorded");

      const journalAfter = yield* fixture.journalKinds();

      // Its durable outcome is appended normally: the Journal head moved.
      expect(journalAfter.length).toBe(journalAtRest.length + 1);
      expect(journalAfter.at(-1)).toBe("yield:background");

      // The expansion pause point did not move with it.
      expect(gate.state).toBe("paused");
      expect(fixture.laterRan()).toBe(laterAtRest);
      expect(gate.inspect().held.join("|")).toBe(heldAtRest);

      const appendsAtRelease = fixture.appendCount();
      gate.release();
      yield* fixture.execution;

      const final = yield* fixture.journalKinds();

      // Continue did not replay the already-recorded background outcome. Counted
      // at append time, so a duplicate landing at any moment is caught.
      expect(fixture.appendsOf("yield:background")).toBe(1);
      expect(final.filter((kind) => kind === "yield:background").length).toBe(1);
      expect(final.slice(0, journalAfter.length)).toEqual(journalAfter);
      expect(fixture.appendCount()).toBeGreaterThan(appendsAtRelease);
      expect(fixture.laterRan()).toBe(1);
    });
  });

  it("9. accounts for every concurrent expansion walk before reporting paused", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({ concurrentRegions: true });
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* freshAdvances(fixture);

      // Pause while both regions are genuinely mid-expansion.
      yield* advanceOfExecution(advancing, "region");

      gate.request();
      yield* bounded(gate.reached(), "reached");

      expect(gate.state).toBe("paused");
      const resting = gate.inspect();

      // Two concurrent region walks, each holding its own continuation, plus the
      // two walks delegating to them. Every one accounted for.
      expect(resting.advancing).toEqual([]);
      const regionWalks = resting.walks.filter((walk) => walk.includes(":region("));
      expect(regionWalks.length).toBe(2);
      for (const walk of regionWalks) {
        expect(walk).toContain("held@");
      }
      expect(resting.walks.join(" ")).toContain("delegating->");

      gate.release();
      yield* fixture.execution;
    });
  });

  it("3. does not report paused while a targeted expansion walk can still expand", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({ concurrentRegions: true });
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* freshAdvances(fixture);

      // Pause while both region walks are genuinely mid-expansion.
      yield* advanceOfExecution(advancing, "region");

      gate.request();

      // Synchronously with the request, before any continuation has run: targeted
      // walks can still expand, and the controller has not claimed otherwise.
      expect(gate.state).toBe("pausing");
      const requested = gate.inspect();
      expect(requested.advancing.length).toBeGreaterThan(0);
      expect(requested.advancing.join(" ")).toContain("advancing");
      expect(requested.held).toEqual([]);

      // It settles only once nothing is advancing any more. That is the rule, and
      // these two observations together are what the rule says.
      yield* bounded(gate.reached(), "reached");
      expect(gate.state).toBe("paused");
      expect(gate.inspect().advancing).toEqual([]);
      expect(gate.inspect().held.length).toBeGreaterThan(0);

      gate.release();
      yield* fixture.execution;
    });
  });

  it("10. leaves an execution outside the selected subtree running and recording", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* freshAdvances(fixture);
      yield* advanceOfExecution(advancing, "slow");

      gate.request();
      yield* bounded(gate.reached(), "reached");
      expect(gate.state).toBe("paused");
      const heldAtRest = gate.inspect().held.join("|");

      // A whole separate execution expands and records while the target is held.
      const sibling = yield* bounded(runSiblingExecution(), "sibling");
      if (typeof sibling === "string") {
        throw new Error(`the sibling execution did not finish: ${sibling}`);
      }
      expect(sibling.output).toContain("Hello from declared Markdown.");
      expect(sibling.journal.at(-1)).toBe("close");
      expect(sibling.journal).toContain("yield:exec");

      // And the target is exactly where it was.
      expect(gate.state).toBe("paused");
      expect(gate.inspect().held.join("|")).toBe(heldAtRest);
      expect(fixture.laterRan()).toBe(0);

      gate.release();
      yield* fixture.execution;
    });
  });

  it("11. releases every held expansion continuation exactly once", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({ concurrentRegions: true });
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* freshAdvances(fixture);
      yield* advanceOfExecution(advancing, "region");

      gate.request();
      yield* bounded(gate.reached(), "reached");

      const held = gate.inspect().held;
      // Without this the assertions below would be satisfied by a controller that
      // held nothing and released nothing.
      expect(gate.state).toBe("paused");
      expect(held.length).toBeGreaterThan(1);
      const releasesBefore = gate.releases;

      gate.release();

      expect(gate.state).toBe("playing");
      expect(gate.releases - releasesBefore).toBe(held.length);
      expect(gate.doubleReleases).toBe(0);

      const output = yield* fixture.execution;
      expect(String(output)).toContain("Hello from declared Markdown.");
      expect(gate.doubleReleases).toBe(0);
      expect(gate.inspect().held).toEqual([]);
    });
  });

  it("12. propagates an expansion failure to the owner", function* () {
    let captured: XmdFixture | undefined;
    const observed = { state: "", held: 0 };

    const escaped = yield* settlement(
      isolated(function* () {
        const fixture = yield* startXmdFixture({ failing: true });
        captured = fixture;
        const gate = fixture.gate;
        if (!gate) {
          throw new Error("expected a gate");
        }
        const advancing = yield* freshAdvances(fixture);
        yield* advanceOfExecution(advancing, "slow");

        gate.request();
        yield* bounded(gate.reached(), "reached");
        observed.state = gate.state;
        observed.held = gate.inspect().held.length;

        // Releasing is where the failure resumes and reaches the owner. This
        // scope is torn down by it, so nothing after this line runs.
        gate.release();
        yield* bounded(settlement(fixture.execution), "execution");
        return "survived";
      }),
    );

    expect(observed.state).toBe("paused");
    expect(observed.held).toBeGreaterThan(0);

    // The failure reaches the owner rather than being swallowed or deferred by
    // the pause machinery.
    expect(escaped).toContain("threw:");
    expect(escaped).toContain("Slow failed while the controller was coordinating");
    expect(captured?.lifecycle()).toEqual(["acquired:held", "released:held"]);
  });

  it("13. unwinds held expansion continuations on interruption without releasing them", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* freshAdvances(fixture);
      yield* advanceOfExecution(advancing, "slow");

      gate.request();
      yield* bounded(gate.reached(), "reached");
      expect(gate.state).toBe("paused");
      expect(gate.inspect().held.length).toBeGreaterThan(0);
      expect(fixture.lifecycle()).toEqual(["acquired:held"]);

      const journalAtHold = yield* fixture.journalKinds();

      yield* bounded(fixture.execution.halt(), "halt");

      const outcome = yield* bounded(settlement(fixture.execution), "settle");
      expect(outcome).toBe("threw:halted");

      // Unwound, not released into ordinary execution: the gate released nothing.
      expect(gate.releases).toBe(0);
      expect(fixture.laterRan()).toBe(0);
      expect(yield* fixture.journalKinds()).toEqual(journalAtHold);

      // And what the document owned came back.
      expect(fixture.lifecycle()).toEqual(["acquired:held", "released:held"]);
    });
  });

  it("14. unwinds holds and retained resources on owner shutdown, without reporting success", function* () {
    yield* isolated(function* () {
      const fixture = yield* startXmdFixture({});
      const gate = fixture.gate;
      if (!gate) {
        throw new Error("expected a gate");
      }
      const advancing = yield* freshAdvances(fixture);
      yield* advanceOfExecution(advancing, "slow");

      gate.request();
      yield* bounded(gate.reached(), "reached");
      expect(gate.state).toBe("paused");
      expect(gate.inspect().held.length).toBeGreaterThan(0);

      yield* bounded(fixture.shutdown(), "shutdown");

      const outcome = yield* bounded(settlement(fixture.execution), "settle");
      expect(outcome).toBe("threw:halted");
      expect(gate.releases).toBe(0);
      expect(fixture.laterRan()).toBe(0);
      expect(fixture.lifecycle()).toEqual(["acquired:held", "released:held"]);
    });
  });
});
