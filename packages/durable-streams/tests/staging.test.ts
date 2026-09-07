import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, scoped, sleep, spawn, suspend, withResolvers } from "effection";
import type { DurableStage, DurableStageFactory } from "../mod.ts";
import {
  durableCall,
  createDurableStage,
  DurableContext,
  durableRun,
  InMemoryStream,
  StaleInputError,
} from "../mod.ts";

describe("staged child ownership", () => {
  it("revokes transferred children after caller cancellation and delayed cleanup", function* () {
    const started = withResolvers<void>();
    let held: DurableStage | undefined;
    let cleaned = false;
    const stream = new InMemoryStream();
    const task = yield* spawn(function* () {
      yield* durableRun(
        function* () {
          held = yield* createDurableStage();
          yield* held.run(function* () {
            yield* ensure(function* () {
              yield* sleep(5);
              cleaned = true;
            });
            started.resolve();
            yield* suspend();
          });
          return null;
        },
        { stream },
      );
    });
    yield* started.operation;
    yield* task.halt();
    expect(cleaned).toBe(true);
    expect(stream.snapshot()).toEqual([]);
    let failure: unknown;
    try {
      yield* held!.children.create({ type: "call", name: "expired" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StaleInputError);
  });

  it("does not lend an expired root's factory to a new execution", function* () {
    let held: DurableStageFactory | undefined;
    yield* durableRun(
      function* () {
        return null;
      },
      {
        stream: new InMemoryStream(),
        staging(factory) {
          held = factory;
        },
      },
    );
    yield* durableRun(
      function* () {
        let failure: unknown;
        try {
          yield* held!.create({ type: "call", name: "foreign" });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(StaleInputError);
        return null;
      },
      { stream: new InMemoryStream() },
    );
  });
  it("publishes child reads only after delayed teardown and before its closed result", function* () {
    const stream = new InMemoryStream();
    const order: string[] = [];
    yield* durableRun(
      function* () {
        const stage = yield* createDurableStage();
        const value = yield* stage.run(function* () {
          yield* ensure(function* () {
            yield* sleep(1);
            order.push("cleanup");
            expect(stream.snapshot()).toEqual([]);
          });
          return yield* durableCall("one", function* () {
            return "private value";
          });
        });
        expect(order).toEqual(["cleanup"]);
        expect(stream.snapshot()).toEqual([]);
        yield* stage.finish({ value }, true);
        expect(stream.snapshot().map((event) => [event.type, event.coroutineId])).toEqual([
          ["yield", "root.0"],
          ["close", "root.0"],
        ]);
        return value;
      },
      { stream },
    );
  });

  it("discards refused values rather than treating provisional settlement as a durable append", function* () {
    const stream = new InMemoryStream();
    yield* durableRun(
      function* () {
        const stage = yield* createDurableStage();
        yield* stage.run(function* () {
          yield* durableCall("one", function* () {
            return "must not escape";
          });
        });
        yield* stage.finish({ refusal: "budget" }, false);
        return null;
      },
      { stream },
    );
    expect(stream.snapshot().filter((event) => event.type === "yield")).toEqual([]);
    expect(JSON.stringify(stream.snapshot())).not.toContain("must not escape");
  });

  it("replays an accepted partial flush at the child cursor without exposing a closed answer", function* () {
    const stream = new InMemoryStream([
      {
        type: "yield",
        coroutineId: "root.0",
        description: { type: "call", name: "one" },
        result: { status: "ok", value: "historical" },
      },
    ]);
    let reads = 0;
    yield* durableRun(
      function* () {
        const stage = yield* createDurableStage();
        expect(stage.retained).toBeUndefined();
        const value = yield* stage.run(function* () {
          return yield* durableCall("one", function* () {
            reads += 1;
            return "live";
          });
        });
        expect(value).toBe("historical");
        yield* stage.finish({ value }, true);
        return null;
      },
      { stream },
    );
    expect(reads).toBe(0);
    expect(stream.snapshot().filter((event) => event.type === "yield")).toHaveLength(1);
  });

  it("refuses a copied context and a second transfer, instead of accepting a caller supplied owner", function* () {
    yield* durableRun(
      function* () {
        const context = yield* DurableContext.get();
        expect(context).toBeDefined();
        yield* scoped(function* () {
          if (context === undefined) {
            throw new Error("missing context");
          }
          yield* DurableContext.set({ ...context });
          let failure: unknown;
          try {
            yield* createDurableStage();
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(StaleInputError);
        });
        const stage = yield* createDurableStage();
        yield* stage.run(function* () {
          return null;
        });
        let failure: unknown;
        try {
          yield* stage.run(function* () {
            throw new Error("second body ran");
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(StaleInputError);
        yield* stage.finish(null, true);
        return null;
      },
      { stream: new InMemoryStream() },
    );
  });
});
