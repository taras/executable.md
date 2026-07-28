/**
 * Tier RS — route slot tests (packages/test-agent/src/route-slot.ts): the
 * slot is exclusive and granted in arrival order, and a holder that fails or
 * halts still advances the queue rather than stranding the route.
 */
import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep, spawn } from "effection";
import { useRouteSlot } from "../src/route-slot.ts";

describe("Tier RS — route slot", () => {
  it("RS1: holders run one at a time, in arrival order", function* () {
    const slot = yield* useRouteSlot();
    const order: string[] = [];
    const hold = (label: string, ms: number) =>
      spawn(() =>
        slot.withSlot(function* () {
          order.push(`${label}-start`);
          yield* sleep(ms);
          order.push(`${label}-end`);
        }),
      );

    const first = yield* hold("a", 15);
    yield* sleep(1);
    const second = yield* hold("b", 1);
    yield* first;
    yield* second;

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("RS2: a holder that throws releases the slot", function* () {
    const slot = yield* useRouteSlot();
    let failed = false;
    try {
      yield* slot.withSlot(function* () {
        throw new Error("boom");
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    let ran = false;
    yield* slot.withSlot(function* () {
      ran = true;
      yield* sleep(0);
    });
    expect(ran).toBe(true);
  });

  it("RS3: a halted holder releases the slot", function* () {
    const slot = yield* useRouteSlot();
    const seen: string[] = [];

    const held = yield* spawn(() =>
      slot.withSlot(function* () {
        seen.push("held");
        yield* sleep(10_000);
      }),
    );
    yield* sleep(5);
    yield* held.halt();

    yield* slot.withSlot(function* () {
      seen.push("after");
      yield* sleep(0);
    });
    expect(seen).toEqual(["held", "after"]);
  });

  it("RS4: the holder's operation runs in the caller's scope", function* () {
    // The route pin must not own what the operation acquires: a turn started
    // under the slot outlives the critical section.
    const slot = yield* useRouteSlot();
    let torn = false;
    const acquired = yield* slot.withSlot(function* () {
      yield* spawn(function* () {
        try {
          yield* sleep(10_000);
        } finally {
          torn = true;
        }
      });
      return "turn";
    });
    expect(acquired).toBe("turn");
    expect(torn).toBe(false);
  });
});
