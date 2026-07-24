/**
 * Tier SQ — serial queue tests (packages/acp/src/serial-queue.ts):
 * FIFO ordering, and that an active holder failing or halting still
 * advances the queue for both `slot()` and `withSlot()`.
 */
import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, sleep, spawn } from "effection";
import { useSerialQueues } from "../src/serial-queue.ts";

describe("Tier SQ — serial queues", () => {
  it("SQ1: slots for one key are granted FIFO", function* () {
    yield* scoped(function* () {
      const queues = yield* useSerialQueues();
      const order: string[] = [];
      const hold = (label: string, ms: number) =>
        spawn(() =>
          scoped(function* () {
            yield* queues.slot("k");
            order.push(`${label}-start`);
            yield* sleep(ms);
            order.push(`${label}-end`);
          }),
        );
      const a = yield* hold("a", 15);
      yield* sleep(1);
      const b = yield* hold("b", 1);
      yield* a;
      yield* b;
      expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    });
  });

  it("SQ2: a slot() holder that throws still advances the queue", function* () {
    yield* scoped(function* () {
      const queues = yield* useSerialQueues();
      let ran = false;
      // The holder's scope exits (throwing), running the resource's
      // finally which releases the slot.
      try {
        yield* scoped(function* () {
          yield* queues.slot("k");
          throw new Error("holder failed");
        });
      } catch {
        // expected
      }
      yield* scoped(function* () {
        yield* queues.slot("k");
        ran = true;
      });
      expect(ran).toBe(true);
    });
  });

  it("SQ3: a slot() holder that halts still advances the queue", function* () {
    yield* scoped(function* () {
      const queues = yield* useSerialQueues();
      let ran = false;
      const held = yield* spawn(() =>
        scoped(function* () {
          yield* queues.slot("k");
          yield* sleep(10_000);
        }),
      );
      yield* sleep(5);
      yield* held.halt();
      const next = yield* spawn(() =>
        scoped(function* () {
          yield* queues.slot("k");
          ran = true;
        }),
      );
      yield* next;
      expect(ran).toBe(true);
    });
  });

  it("SQ4: a withSlot() holder failing or halting still advances the queue", function* () {
    yield* scoped(function* () {
      const queues = yield* useSerialQueues();
      const seen: string[] = [];

      let failed = false;
      try {
        yield* queues.withSlot("k", function* () {
          throw new Error("boom");
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);

      // The queue is not poisoned by the failed holder.
      const held = yield* spawn(() =>
        queues.withSlot("k", function* () {
          seen.push("held");
          yield* sleep(10_000);
        }),
      );
      yield* sleep(5);
      yield* held.halt();

      yield* queues.withSlot("k", function* () {
        seen.push("after");
        yield* sleep(0);
      });
      expect(seen).toEqual(["held", "after"]);
    });
  });
});
