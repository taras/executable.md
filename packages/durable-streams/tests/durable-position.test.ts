/**
 * Tier DP — the coordinate a coroutine reaches in its own durable history.
 *
 * A position exists so that an operation with no name of its own can still be
 * the same operation next time. Everything asserted here is that sameness: the
 * index a coroutine reaches at one point in a procedure is the index it reaches
 * there on replay, on a live suffix continuing past retained history, and
 * inside a child that counts its own.
 *
 * The discriminating observation is a *live suffix after a replayed prefix*. A
 * position taken from replay's own cursor is right for the prefix and stops
 * moving for the suffix, so a suite that only replayed a whole history would
 * pass against a position that cannot do its job.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import {
  type DurableEvent,
  durableCall,
  durablePosition,
  type DurablePosition,
  durableRun,
  type Workflow,
  durableAll,
  InMemoryStream,
} from "../mod.ts";

function* effect(name: string): Operation<string> {
  return yield* durableCall(name, function* () {
    return name;
  });
}

/** Every position one run observed, in the order it observed them. */
function* observed(
  stream: InMemoryStream,
  body: (record: (position: DurablePosition) => void) => Operation<void>,
): Operation<DurablePosition[]> {
  const positions: DurablePosition[] = [];
  yield* durableRun(
    function* () {
      return yield* body((position) => {
        positions.push(position);
      });
    },
    { stream },
  );
  return positions;
}

describe("Tier DP — durable coroutine position", () => {
  it("DP1: counts the yields this coroutine has settled", function* () {
    const stream = new InMemoryStream();

    const positions = yield* observed(stream, (record) =>
      (function* () {
        record(yield* durablePosition());
        yield* effect("first");
        record(yield* durablePosition());
        yield* effect("second");
        record(yield* durablePosition());
      })(),
    );

    expect(positions.map((position) => position.index)).toEqual([0, 1, 2]);
    expect(new Set(positions.map((position) => position.coroutineId)).size).toBe(1);
  });

  it("DP2: a replayed prefix and its live suffix agree on every position", function* () {
    const first = new InMemoryStream();

    const live = yield* observed(first, (record) =>
      (function* () {
        yield* effect("first");
        record(yield* durablePosition());
        yield* effect("second");
        record(yield* durablePosition());
        yield* effect("third");
        record(yield* durablePosition());
      })(),
    );

    // The same procedure against retained history that stops part-way: the
    // first two effects replay and the third runs live. This is the case a
    // position taken from replay's cursor gets wrong — the cursor stops
    // advancing where retained history ends, so the live suffix would repeat
    // an index the prefix already used.
    const retained: DurableEvent[] = (yield* first.readAll()).filter(
      (event) => event.type !== "close",
    );
    const partial = new InMemoryStream(
      retained.filter((event) => {
        const description = Reflect.get(Object(event), "description");
        return Reflect.get(Object(description), "name") !== "third";
      }),
    );

    const resumed = yield* observed(partial, (record) =>
      (function* () {
        yield* effect("first");
        record(yield* durablePosition());
        yield* effect("second");
        record(yield* durablePosition());
        yield* effect("third");
        record(yield* durablePosition());
      })(),
    );

    expect(live.map((position) => position.index)).toEqual([1, 2, 3]);
    expect(resumed).toEqual(live);
  });

  it("DP3: sequential positions in one coroutine are distinct", function* () {
    const stream = new InMemoryStream();

    const positions = yield* observed(stream, (record) =>
      (function* () {
        record(yield* durablePosition());
        yield* effect("between");
        record(yield* durablePosition());
      })(),
    );

    const [before, after] = positions;
    expect(before?.index).not.toBe(after?.index);
  });

  it("DP4: a child coroutine counts its own", function* () {
    const stream = new InMemoryStream();

    const positions = yield* observed(stream, (record) =>
      (function* () {
        yield* effect("parent-first");
        record(yield* durablePosition());

        // Observed from inside the child's own durable effects. A `Workflow`
        // generator may only yield durable effects, so a plain operation like
        // `durablePosition()` is delegated where operations run: the executor.
        yield* durableAll([
          function* (): Workflow<string> {
            yield* durableCall("child-start", function* () {
              record(yield* durablePosition());
              return "started";
            });
            yield* durableCall("child-effect", function* () {
              return "worked";
            });
            yield* durableCall("child-later", function* () {
              record(yield* durablePosition());
              return "later";
            });
            return "child";
          },
        ]);
      })(),
    );

    const [parent, childStart, childNext] = positions;

    // The parent has settled one yield. The child has settled none of its own
    // when it starts, and two by the time it looks again — its own count, not a
    // continuation of its parent's.
    expect(parent?.index).toBe(1);
    expect(childStart?.index).toBe(0);
    expect(childNext?.index).toBe(2);

    // And the coordinate that separates the parent's index 1 from the child's
    // is the coroutine, which is why a position is a pair.
    expect(childStart?.coroutineId).not.toBe(parent?.coroutineId);
    expect(childNext?.coroutineId).toBe(childStart?.coroutineId);
  });
});
