/**
 * Tier PLA — which scopes a Plan writer frame grants a read to.
 *
 * The integration rows live in the Plan suites: a request crossing the shared
 * Files chain, a restriction denying it, the writer frame refusing everything
 * ambient. What those cannot show cheaply is the *shape* of the grant — a
 * sibling created while a projection is open, a nested frame's grant offered to
 * an outer frame's guard, a grant asked about after it closed. Each of those is
 * one scope relationship, and this drives them directly.
 *
 * Driving the mechanism rather than a document is the point. The guard asks one
 * question — "is the scope asking inside a live projection of my frame?" — and
 * every way of answering it wrongly is a way of handing an unaudited fragment,
 * or the writer frame itself, a read it was not given.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { scoped, spawn, withResolvers } from "effection";

import { createPlanAccess } from "../src/plan-access.ts";
import type { PlanWriterAccess } from "../src/plan-access.ts";

describe("Tier PLA — the read grant inside a Plan writer frame", () => {
  it("PLA1: a writer frame grants nothing until a projection opens", function* () {
    const access = createPlanAccess();
    yield* scoped(function* () {
      const writer = yield* access.openWriter();

      // The frame's own scope, and a child of it: neither is a projection.
      expect(yield* writer.reading()).toBe(false);
      yield* scoped(function* () {
        expect(yield* writer.reading()).toBe(false);
      });
    });
  });

  it("PLA2: a projection grants its own scope and everything created under it", function* () {
    const access = createPlanAccess();
    yield* scoped(function* () {
      const writer = yield* access.openWriter();

      const close = yield* scoped(function* () {
        const held = yield* access.openInformation();
        expect(yield* writer.reading()).toBe(true);
        // A child created after the grant opened — which is what the engine's
        // hosted content, and everything the fragment runs, actually are.
        yield* scoped(function* () {
          expect(yield* writer.reading()).toBe(true);
          // And a child of that child, because a fragment nests.
          yield* scoped(function* () {
            expect(yield* writer.reading()).toBe(true);
          });
        });
        return held;
      });

      // Revoked, and the answer is no from the frame again. The projection's
      // own scope has ended too, so this is the frame asking.
      close();
      expect(yield* writer.reading()).toBe(false);
    });
  });

  it("PLA3: a sibling created while a projection is open is granted nothing", function* () {
    const access = createPlanAccess();
    const opened = withResolvers<void>();
    const observed: boolean[] = [];

    yield* scoped(function* () {
      const writer = yield* access.openWriter();

      // The concurrent writer sibling: a task of the frame's own, running
      // while the projection below is suspended mid-read.
      const sibling = yield* spawn(function* () {
        yield* opened.operation;
        observed.push(yield* writer.reading());
      });

      yield* scoped(function* () {
        yield* access.openInformation();
        expect(yield* writer.reading()).toBe(true);
        // Opened, and held open: the sibling asks while this is live rather
        // than after it settled, which is the only ordering that could be
        // mistaken for a grant.
        opened.resolve();
        yield* sibling;
      });
    });

    // The sibling inherited the writer record — it is in the frame — and no
    // read grant, because its parent held none when it was created.
    expect(observed).toEqual([false]);
  });

  it("PLA4: one frame's projection does not satisfy another frame's guard", function* () {
    const access = createPlanAccess();
    yield* scoped(function* () {
      const outer = yield* access.openWriter();

      yield* scoped(function* () {
        // A second writer frame, nested inside the first. Its projection is
        // perfectly good — for it.
        const inner = yield* access.openWriter();
        yield* scoped(function* () {
          yield* access.openInformation();
          expect(yield* inner.reading()).toBe(true);
          // The outer frame's guard is asked about the same scope and answers
          // no: a grant belongs to the frame that opened it, and a nested
          // conversation cannot read on an enclosing one's behalf.
          expect(yield* outer.reading()).toBe(false);
        });
      });
    });
  });

  it("PLA5: a retained guard answers no once its frame has ended", function* () {
    const access = createPlanAccess();
    let retained: PlanWriterAccess | undefined;
    let granted: boolean | undefined;

    yield* scoped(function* () {
      yield* scoped(function* () {
        retained = yield* access.openWriter();
        const close = yield* access.openInformation();
        expect(yield* retained.reading()).toBe(true);
        close();
      });
      // The frame is gone. Whatever held its guard is holding something that
      // answers for a conversation that has ended.
      granted = retained === undefined ? undefined : yield* retained.reading();
    });

    expect(granted).toBe(false);
  });

  it("PLA6: an information phase outside any frame of this declaration grants nothing", function* () {
    const access = createPlanAccess();
    yield* scoped(function* () {
      // No writer frame was opened, so there is no record to bind a grant to.
      // The projection runs under whatever the enclosing scope permits, which
      // is the honest answer: there is no frame here to refuse it.
      const close = yield* access.openInformation();
      close();
      // Nothing to assert about a guard, because there is no guard. What this
      // row establishes is that opening the phase is not itself a grant: a
      // frame opened afterwards sees no projection.
      const writer = yield* access.openWriter();
      expect(yield* writer.reading()).toBe(false);
    });
  });
});
