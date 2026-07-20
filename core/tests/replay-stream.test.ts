import { describe, it } from "@effectionx/bdd/node";
import { expect } from "@effectionx/bdd/expect";
import { scoped, spawn } from "effection";
import type { Operation, Subscription } from "effection";
import { createReplayStream } from "../src/replay-stream.ts";

function* drain(
  subscription: Subscription<string, string>,
): Operation<{ chunks: string[]; close: string }> {
  const chunks: string[] = [];
  let next = yield* subscription.next();
  while (!next.done) {
    chunks.push(next.value);
    next = yield* subscription.next();
  }
  return { chunks, close: next.value };
}

describe("createReplayStream", () => {
  it("replays chunks emitted before the subscription", function* () {
    const stream = createReplayStream<string, string>();
    yield* stream.send("a");
    yield* stream.send("b");
    yield* stream.close("ab");

    const result = yield* scoped(function* () {
      return yield* drain(yield* stream);
    });
    expect(result).toEqual({ chunks: ["a", "b"], close: "ab" });
  });

  it("delivers an event sent at the replay/live boundary exactly once", function* () {
    const stream = createReplayStream<string, string>();
    yield* stream.send("before");

    const result = yield* scoped(function* () {
      const subscription = yield* stream;
      // The subscription is attached; a send after attach but before the
      // first next() must arrive exactly once, after the replayed history.
      yield* stream.send("boundary");
      yield* stream.close("done");
      return yield* drain(subscription);
    });
    expect(result).toEqual({ chunks: ["before", "boundary"], close: "done" });
  });

  it("gives multiple subscribers the full sequence each", function* () {
    const stream = createReplayStream<string, string>();
    yield* stream.send("x");

    const [first, second] = yield* scoped(function* () {
      const one = yield* stream;
      const two = yield* stream;
      yield* stream.send("y");
      yield* stream.close("xy");
      return [yield* drain(one), yield* drain(two)];
    });
    expect(first).toEqual({ chunks: ["x", "y"], close: "xy" });
    expect(second).toEqual({ chunks: ["x", "y"], close: "xy" });
  });

  it("serves the close value to a subscriber that arrives after close", function* () {
    const stream = createReplayStream<string, string>();
    yield* stream.send("only");
    yield* stream.close("only");

    const result = yield* scoped(function* () {
      return yield* drain(yield* stream);
    });
    expect(result).toEqual({ chunks: ["only"], close: "only" });
  });

  it("live subscribers receive concurrent sends", function* () {
    const stream = createReplayStream<string, string>();

    const result = yield* scoped(function* () {
      const consumer = yield* spawn(function* () {
        return yield* drain(yield* stream);
      });
      yield* stream.send("one");
      yield* stream.send("two");
      yield* stream.close("onetwo");
      return yield* consumer;
    });
    expect(result).toEqual({ chunks: ["one", "two"], close: "onetwo" });
  });

  it("ignores events after close", function* () {
    const stream = createReplayStream<string, string>();
    yield* stream.close("final");
    yield* stream.send("late");
    yield* stream.close("later");

    const result = yield* scoped(function* () {
      return yield* drain(yield* stream);
    });
    expect(result).toEqual({ chunks: [], close: "final" });
  });
});
