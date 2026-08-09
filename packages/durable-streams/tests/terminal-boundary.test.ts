import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import type { Operation } from "effection";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  type DurableEvent,
  EarlyReturnDivergenceError,
  InMemoryStream,
  ReplayGuard,
  StaleInputError,
  TerminalDivergenceError,
  type Workflow,
  durableAll,
  durableCall,
  durableRun,
  serializeDurableEvent,
} from "../mod.ts";

function expectUnchanged(stream: InMemoryStream, before: DurableEvent[]): void {
  const after = stream.snapshot();
  expect(after).toEqual(before);
  expect(after.map(serializeDurableEvent).join("")).toBe(
    before.map(serializeDurableEvent).join(""),
  );
}

function* recordCompletedChild(): Operation<DurableEvent[]> {
  const stream = new InMemoryStream();
  yield* durableRun(
    function* (): Workflow<string> {
      const [value] = yield* durableAll([
        function* () {
          return yield* durableCall("child-step", () => Promise.resolve("recorded"));
        },
      ]);
      return value;
    },
    { stream },
  );
  return stream.snapshot().filter((event) => event.coroutineId !== "root");
}

function* replayCompletedChild(stream: InMemoryStream): Operation<string> {
  return yield* durableRun(
    function* (): Workflow<string> {
      const [value] = yield* durableAll([
        function* () {
          return yield* durableCall("child-step", () => Promise.resolve("not-executed"));
        },
      ]);
      return value;
    },
    { stream },
  );
}

function* recordTwoStepChild(): Operation<DurableEvent[]> {
  const stream = new InMemoryStream();
  yield* durableRun(
    function* (): Workflow<string> {
      const [value] = yield* durableAll([
        function* () {
          yield* durableCall("child-first", () => Promise.resolve("first"));
          return yield* durableCall("child-second", () => Promise.resolve("second"));
        },
      ]);
      return value;
    },
    { stream },
  );
  return stream.snapshot().filter((event) => event.type === "yield");
}

describe("durable terminal boundary", () => {
  it("claiming a completed child aligns its retained descendants", function* () {
    const golden = new InMemoryStream();
    let executions = 0;
    const nestedWorkflow = function* (): Workflow<string> {
      const [outer] = yield* durableAll([
        function* () {
          const [inner] = yield* durableAll([
            function* () {
              return yield* durableCall("nested-step", () => {
                executions++;
                return Promise.resolve("recorded");
              });
            },
          ]);
          return inner;
        },
      ]);
      return outer;
    };

    yield* durableRun(nestedWorkflow, { stream: golden });
    const retained = golden.snapshot().filter((event) => event.coroutineId !== "root");
    const replay = new InMemoryStream(retained);

    expect(yield* durableRun(nestedWorkflow, { stream: replay })).toBe("recorded");
    expect(executions).toBe(1);
    expect(replay.snapshot().at(-1)?.coroutineId).toBe("root");
  });

  it("rejects a normal root return that abandons a completed child", function* () {
    const retained = yield* recordCompletedChild();
    const stream = new InMemoryStream(retained);
    const before = stream.snapshot();
    let failure: unknown;

    try {
      yield* durableRun(
        // deno-lint-ignore require-yield
        function* (): Workflow<string> {
          return "child-removed";
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(EarlyReturnDivergenceError);
    expectUnchanged(stream, before);

    const compatible = new InMemoryStream(retained);
    expect(yield* replayCompletedChild(compatible)).toBe("recorded");
    expect(compatible.snapshot().at(-1)?.coroutineId).toBe("root");
  });

  it("rejects a root error that abandons a completed child", function* () {
    const retained = yield* recordCompletedChild();
    const stream = new InMemoryStream(retained);
    const before = stream.snapshot();
    const workflowFailure = new Error("current root failed");
    let failure: unknown;

    try {
      yield* durableRun(
        // deno-lint-ignore require-yield
        function* (): Workflow<string> {
          throw workflowFailure;
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TerminalDivergenceError);
    if (!(failure instanceof TerminalDivergenceError)) {
      throw new Error("expected terminal divergence");
    }
    expect(failure.cause).toBe(workflowFailure);
    expectUnchanged(stream, before);
  });

  it("does not close a child or root over stale child history", function* () {
    const completed = yield* recordCompletedChild();
    const retained = completed.filter((event) => event.type === "yield");
    const stream = new InMemoryStream(retained);
    const before = stream.snapshot();
    const stale = new StaleInputError("child input changed");

    yield* ReplayGuard.around({
      *check([event], next) {
        return yield* next(event);
      },
      decide() {
        return { outcome: "error", error: stale };
      },
    });

    let failure: unknown;
    try {
      yield* replayCompletedChild(stream);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(stale);
    expectUnchanged(stream, before);
  });

  it("does not close a child or root over divergent child history", function* () {
    const completed = yield* recordCompletedChild();
    const retained = completed.filter((event) => event.type === "yield");
    const stream = new InMemoryStream(retained);
    const before = stream.snapshot();
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          const [value] = yield* durableAll([
            function* () {
              return yield* durableCall("changed-child-step", () =>
                Promise.resolve("not-executed"),
              );
            },
          ]);
          return value;
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(DivergenceError);
    expectUnchanged(stream, before);
  });

  it("checks child alignment before a successful child Close", function* () {
    const retained = yield* recordTwoStepChild();
    const stream = new InMemoryStream(retained);
    const before = stream.snapshot();
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          const [value] = yield* durableAll([
            function* () {
              yield* durableCall("child-first", () => Promise.resolve("not-executed"));
              return "child-finished-early";
            },
          ]);
          return value;
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(EarlyReturnDivergenceError);
    expectUnchanged(stream, before);
  });

  it("checks child alignment before a failed child Close", function* () {
    const retained = yield* recordTwoStepChild();
    const stream = new InMemoryStream(retained);
    const before = stream.snapshot();
    const childFailure = new Error("child failed early");
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          const [value] = yield* durableAll([
            function* (): Workflow<string> {
              yield* durableCall("child-first", () => Promise.resolve("not-executed"));
              throw childFailure;
            },
          ]);
          return value;
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TerminalDivergenceError);
    if (!(failure instanceof TerminalDivergenceError)) {
      throw new Error("expected terminal divergence");
    }
    expect(failure.cause).toBe(childFailure);
    expectUnchanged(stream, before);
  });

  it("does not serialize continue-past-close as a document outcome", function* () {
    const stream = new InMemoryStream();
    const divergence = new ContinuePastCloseDivergenceError("root.0", 1);
    let failure: unknown;

    try {
      yield* durableRun(
        // deno-lint-ignore require-yield
        function* (): Workflow<string> {
          throw divergence;
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(divergence);
    expect(stream.snapshot()).toEqual([]);
  });
});
