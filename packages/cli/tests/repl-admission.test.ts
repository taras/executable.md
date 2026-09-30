/**
 * Admission consumes a subscription its caller already created.
 *
 * The session's provisional-to-admitted transition hangs on a `Signal`, and a
 * Signal drops whatever it sends while no subscription is active. These rows
 * hold the ordering that makes the announcement survive.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createSignal, sleep, spawn } from "effection";
import { filter } from "@effectionx/stream-helpers";
import { consumeAdmissions } from "../src/repl/admission.ts";

describe("AD — admission survives an announcement made before the consumer runs", () => {
  it("AD1: a value announced before the consumer begins is still admitted", function* () {
    const changes = createSignal<number, never>();
    let admitted = 0;

    // The caller subscribes first, exactly as the session does before it
    // spawns the document that can announce.
    // Filtered before subscribing, exactly as the session composes it, so the
    // drain itself stays generic.
    const subscription = yield* filter(function* (value: number) {
      return value > 0;
    })(changes);
    // Announced while the consumer does not exist yet, let alone read.
    changes.send(1);

    yield* spawn(
      consumeAdmissions(subscription, () => {
        admitted += 1;
      }),
    );
    // One turn is all it takes to reach what was already queued for this
    // active subscription.
    yield* sleep(0);

    expect(admitted).toBe(1);

    // And a value the filter rejects never reaches the drain at all.
    changes.send(0);
    yield* sleep(0);
    expect(admitted).toBe(1);
  });

  it("AD2: the shape AD1 replaced drops that value — the control for AD1", function* () {
    const changes = createSignal<number, never>();
    let admitted = 0;

    // A consumer that subscribes as its first act, which is what `spawn()`
    // makes a turn too late.
    yield* spawn(function* () {
      const subscription = yield* changes;
      let next = yield* subscription.next();
      while (!next.done) {
        admitted += 1;
        next = yield* subscription.next();
      }
    });
    changes.send(1);
    yield* sleep(0);

    // Dropped. This is why `consumeAdmissions` takes a subscription and not a
    // stream: the losing shape cannot be written through that signature.
    expect(admitted).toBe(0);
  });
});
