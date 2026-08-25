import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { suspend } from "effection";
import type { Operation } from "effection";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  type DurableEvent,
  EarlyReturnDivergenceError,
  InMemoryStream,
  ReplayGuard,
  SOURCE_POSITION_FIELD,
  StaleInputError,
  TerminalDivergenceError,
  type Workflow,
  durableAll,
  durableCall,
  durableRun,
  ephemeral,
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

  it("names the first unreached retained yield when a completed child is removed", function* () {
    const retained = yield* recordCompletedChild();
    const stream = new InMemoryStream(retained);
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
    if (!(failure instanceof EarlyReturnDivergenceError)) {
      throw new Error("expected early-return divergence");
    }
    expect(failure.message).toContain('first unreached entry is call("child-step")');
  });

  it("a removed completed child with no yields names its retained Close", function* () {
    const golden = new InMemoryStream();
    yield* durableRun(
      function* (): Workflow<string> {
        const [value] = yield* durableAll([
          // deno-lint-ignore require-yield
          function* (): Workflow<string> {
            return "empty";
          },
        ]);
        return value;
      },
      { stream: golden },
    );
    const retained = golden.snapshot().filter((event) => event.coroutineId !== "root");
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
    if (!(failure instanceof EarlyReturnDivergenceError)) {
      throw new Error("expected early-return divergence");
    }
    expect(failure.message).toContain(
      "first unreached entry is the Close of coroutine root.0",
    );
    // No fabricated effect or source: the Close is named as itself.
    expect(failure.message).not.toContain(" at ");
    expectUnchanged(stream, before);
  });

  it("child cancellation finalization names the first unreached retained entry", function* () {
    const events: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root.0",
        description: { type: "call", name: "child-first" },
        result: { status: "ok", value: "first" },
      },
      {
        type: "yield",
        coroutineId: "root.0",
        description: {
          type: "call",
          name: "child-second",
          [SOURCE_POSITION_FIELD]: { path: "docs/Plan.md", offset: 88, line: 12, column: 1 },
        },
        result: { status: "ok", value: "second" },
      },
    ];
    const stream = new InMemoryStream(events);
    const sibling = new Error("sibling failed");
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          const [value] = yield* durableAll<string>([
            function* (): Workflow<string> {
              yield* durableCall("child-first", () => Promise.resolve("first"));
              yield* ephemeral(suspend());
              return "unreachable";
            },
            // deno-lint-ignore require-yield
            function* (): Workflow<string> {
              throw sibling;
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
    expect(failure.message).toContain("cancelled before retained history was exhausted");
    expect(failure.message).toContain(
      'first unreached entry is call("child-second") at docs/Plan.md:12:1',
    );
    // The retained prefix is unchanged: no Close was appended over the
    // unconsumed history of the cancelled child, and none for the root.
    expect(
      stream
        .snapshot()
        .filter((event) => event.type === "close")
        .map((event) => event.coroutineId),
    ).toEqual(["root.1"]);
    expect(stream.snapshot().filter((event) => event.type === "yield")).toEqual(events);
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
