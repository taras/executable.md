import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { sleep, until, withResolvers, type Operation } from "effection";
import {
  ContinuePastCloseDivergenceError,
  DivergenceError,
  type DurableEvent,
  DurablePersistenceError,
  type DurableStream,
  InMemoryStream,
  ReplayGuard,
  StaleInputError,
  TerminalDivergenceError,
  type Workflow,
  durableAction,
  durableAll,
  durableCall,
  durableRun,
  ephemeral,
  guardDurableStream,
  serializeDurableEvent,
} from "../mod.ts";

function eventBytes(events: DurableEvent[]): string {
  return events.map(serializeDurableEvent).join("");
}

class FailOnceStream implements DurableStream {
  readonly inner: InMemoryStream;
  appendAttempts = 0;
  private failed = false;

  constructor(
    readonly failure: Error,
    events: DurableEvent[] = [],
  ) {
    this.inner = new InMemoryStream(events);
  }

  *readAll(): Operation<DurableEvent[]> {
    return yield* this.inner.readAll();
  }

  *append(event: DurableEvent): Operation<void> {
    this.appendAttempts++;
    if (!this.failed) {
      this.failed = true;
      throw this.failure;
    }
    yield* this.inner.append(event);
  }

  snapshot(): DurableEvent[] {
    return this.inner.snapshot();
  }
}

class BlockingFailureStream implements DurableStream {
  readonly firstAppendStarted = withResolvers<void>();
  readonly releaseFirstAppend = withResolvers<void>();
  readonly inner = new InMemoryStream();
  readonly attempts: DurableEvent[] = [];

  constructor(readonly failure: Error) {}

  *readAll(): Operation<DurableEvent[]> {
    return yield* this.inner.readAll();
  }

  *append(event: DurableEvent): Operation<void> {
    this.attempts.push(structuredClone(event));
    if (this.attempts.length === 1) {
      this.firstAppendStarted.resolve();
      yield* this.releaseFirstAppend.operation;
      throw this.failure;
    }
    yield* this.inner.append(event);
  }

  snapshot(): DurableEvent[] {
    return this.inner.snapshot();
  }
}

function durabilityClassErrors(): Error[] {
  const description = { type: "call", name: "classified-error" };
  return [
    new StaleInputError("classified stale input"),
    new DivergenceError("root", 0, description, description),
    new TerminalDivergenceError("root", 0, 1),
    new ContinuePastCloseDivergenceError("root", 0),
    new DurablePersistenceError("yield", new Error("classified persistence failure")),
  ];
}

function* assertReusedPolicyErrorClassification(guard: typeof guardDurableStream): Operation<void> {
  const sharedFailure = new Error("reused policy and adapter failure");
  const backend = new FailOnceStream(sharedFailure);
  let blockedExecutions = 0;
  let laterExecutions = 0;
  let policyCaught: unknown;
  let persistenceCaught: unknown;
  let failure: unknown;
  const stream = guard(
    backend,
    // deno-lint-ignore require-yield
    function* (event) {
      if (event.type === "yield" && event.description.name === "blocked") {
        throw sharedFailure;
      }
    },
  );

  try {
    yield* durableRun(
      function* (): Workflow<string> {
        try {
          yield* durableCall("blocked", () => {
            blockedExecutions++;
            return Promise.resolve("blocked");
          });
        } catch (error) {
          policyCaught = error;
        }
        try {
          yield* durableCall("later", () => {
            laterExecutions++;
            return Promise.resolve("completed");
          });
        } catch (error) {
          persistenceCaught = error;
        }
        return "must-not-close";
      },
      { stream },
    );
  } catch (error) {
    failure = error;
  }

  expect(blockedExecutions).toBe(1);
  expect(laterExecutions).toBe(1);
  expect(policyCaught).toBe(sharedFailure);
  expect(persistenceCaught).toBe(failure);
  expect(failure).toBeInstanceOf(DurablePersistenceError);
  if (!(failure instanceof DurablePersistenceError)) {
    throw new Error("expected durable persistence failure");
  }
  expect(failure.cause).toBe(sharedFailure);
  expect(backend.appendAttempts).toBe(1);
  expect(backend.snapshot()).toEqual([]);
}

describe("durable fail-stop boundary", () => {
  it("classifies unmarked adapter failures by source", function* () {
    for (const adapterFailure of durabilityClassErrors()) {
      const stream = new FailOnceStream(adapterFailure);
      let firstExecutions = 0;
      let laterExecutions = 0;
      let firstCaught: unknown;
      let laterCaught: unknown;
      let failure: unknown;

      try {
        yield* durableRun(
          function* (): Workflow<string> {
            try {
              yield* durableCall("adapter-error", () => {
                firstExecutions++;
                return Promise.resolve("completed");
              });
            } catch (error) {
              firstCaught = error;
            }
            try {
              yield* durableCall("later", () => {
                laterExecutions++;
                return Promise.resolve("must-not-run");
              });
            } catch (error) {
              laterCaught = error;
            }
            return "must-not-close";
          },
          { stream },
        );
      } catch (error) {
        failure = error;
      }

      expect(firstExecutions).toBe(1);
      expect(laterExecutions).toBe(0);
      expect(stream.appendAttempts).toBe(1);
      expect(stream.snapshot()).toEqual([]);
      expect(firstCaught).toBe(failure);
      expect(laterCaught).toBe(failure);
      expect(failure).toBeInstanceOf(DurablePersistenceError);
      if (!(failure instanceof DurablePersistenceError)) {
        throw new Error("expected durable persistence failure");
      }
      expect(failure).not.toBe(adapterFailure);
      expect(failure.cause).toBe(adapterFailure);
    }
  });

  it("keeps marked policy failures non-poisoning regardless of class", function* () {
    for (const policyFailure of durabilityClassErrors()) {
      const backend = new InMemoryStream();
      let blockedExecutions = 0;
      let laterExecutions = 0;
      let caught: unknown;
      const stream = guardDurableStream(
        backend,
        // deno-lint-ignore require-yield
        function* (event) {
          if (event.type === "yield" && event.description.name === "blocked") {
            throw policyFailure;
          }
        },
      );

      const result = yield* durableRun(
        function* (): Workflow<string> {
          try {
            yield* durableCall("blocked", () => {
              blockedExecutions++;
              return Promise.resolve("blocked");
            });
          } catch (error) {
            caught = error;
          }
          return yield* durableCall("later", () => {
            laterExecutions++;
            return Promise.resolve("completed");
          });
        },
        { stream },
      );

      expect(result).toBe("completed");
      expect(caught).toBe(policyFailure);
      expect(blockedExecutions).toBe(1);
      expect(laterExecutions).toBe(1);
      expect(backend.appendCount).toBe(2);
      expect(
        backend
          .snapshot()
          .map((event) =>
            event.type === "yield"
              ? `yield:${event.description.name}`
              : `close:${event.coroutineId}`,
          ),
      ).toEqual(["yield:later", "close:root"]);
    }
  });

  it("classifies a reused policy error by each append occurrence", function* () {
    yield* assertReusedPolicyErrorClassification(guardDurableStream);
  });

  it("shares append occurrence classification across loaded copies", function* () {
    const loadedCopySpecifier = "../guard.ts" + "?loaded-copy=fail-stop";
    const loadGuardCopy: () => Promise<typeof import("../guard.ts")> = () =>
      import(loadedCopySpecifier);
    const loadedCopy = yield* until(loadGuardCopy());

    expect(loadedCopy.guardDurableStream).not.toBe(guardDurableStream);
    yield* assertReusedPolicyErrorClassification(loadedCopy.guardDurableStream);
  });

  it("fences a later callback executor after a caught persistence failure", function* () {
    const adapterFailure = new Error("first append failed");
    const stream = new FailOnceStream(adapterFailure);
    let firstExecutions = 0;
    let laterExecutions = 0;
    let caught: unknown;
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          try {
            yield* durableCall("poison", () => {
              firstExecutions++;
              return Promise.resolve("completed");
            });
          } catch (error) {
            caught = error;
          }
          return yield* durableAction("later", (resolve) => {
            laterExecutions++;
            resolve("must-not-run");
            return () => {};
          });
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(firstExecutions).toBe(1);
    expect(laterExecutions).toBe(0);
    expect(stream.appendAttempts).toBe(1);
    expect(stream.snapshot()).toEqual([]);
    expect(caught).toBe(failure);
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    if (!(failure instanceof DurablePersistenceError)) {
      throw new Error("expected durable persistence failure");
    }
    expect(failure.cause).toBe(adapterFailure);
  });

  it("fences replay consumption and live execution after a caught divergence", function* () {
    const retained: DurableEvent[] = [
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "first" },
        result: { status: "ok", value: "one" },
      },
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "call", name: "second" },
        result: { status: "ok", value: "two" },
      },
    ];
    const stream = new InMemoryStream(retained);
    const before = eventBytes(stream.snapshot());
    let replayDecisions = 0;
    let laterExecutions = 0;
    let caught: unknown;
    let failure: unknown;

    yield* ReplayGuard.around({
      *check([event], next) {
        return yield* next(event);
      },
      decide([event], next) {
        replayDecisions++;
        return next(event);
      },
    });

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          try {
            yield* durableCall("changed", () => {
              laterExecutions++;
              return Promise.resolve("must-not-run");
            });
          } catch (error) {
            caught = error;
          }
          yield* durableCall("first", () => {
            laterExecutions++;
            return Promise.resolve("must-not-run");
          });
          yield* durableCall("second", () => {
            laterExecutions++;
            return Promise.resolve("must-not-run");
          });
          return yield* durableCall("live", () => {
            laterExecutions++;
            return Promise.resolve("must-not-run");
          });
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(caught).toBeInstanceOf(DivergenceError);
    expect(failure).toBe(caught);
    expect(replayDecisions).toBe(0);
    expect(laterExecutions).toBe(0);
    expect(stream.appendCount).toBe(0);
    expect(eventBytes(stream.snapshot())).toBe(before);
  });

  it("shares the first durability failure across child and sibling entry", function* () {
    const adapterFailure = new Error("child append failed");
    const stream = new FailOnceStream(adapterFailure);
    const failureActive = withResolvers<void>();
    const siblingObserved = withResolvers<void>();
    let poisonExecutions = 0;
    let siblingExecutions = 0;
    let childCaught: unknown;
    let siblingCaught: unknown;
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          yield* durableAll([
            function* () {
              try {
                yield* durableCall("child-poison", () => {
                  poisonExecutions++;
                  return Promise.resolve("completed");
                });
              } catch (error) {
                childCaught = error;
                failureActive.resolve();
              }
              yield* ephemeral(siblingObserved.operation);
              return "caught";
            },
            function* () {
              yield* ephemeral(failureActive.operation);
              try {
                yield* durableCall("sibling-later", () => {
                  siblingExecutions++;
                  return Promise.resolve("must-not-run");
                });
              } catch (error) {
                siblingCaught = error;
              }
              siblingObserved.resolve();
              return "caught";
            },
          ]);
          return "must-not-close";
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(poisonExecutions).toBe(1);
    expect(siblingExecutions).toBe(0);
    expect(stream.appendAttempts).toBe(1);
    expect(stream.snapshot()).toEqual([]);
    expect(childCaught).toBe(failure);
    expect(siblingCaught).toBe(failure);
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    if (!(failure instanceof DurablePersistenceError)) {
      throw new Error("expected durable persistence failure");
    }
    expect(failure.cause).toBe(adapterFailure);
  });

  it("fences an append queued behind the append that activates failure", function* () {
    const adapterFailure = new Error("blocked append failed");
    const stream = new BlockingFailureStream(adapterFailure);
    const secondExecuted = withResolvers<void>();
    const secondObserved = withResolvers<void>();
    let firstExecutions = 0;
    let secondExecutions = 0;
    let firstCaught: unknown;
    let secondCaught: unknown;
    let failure: unknown;

    try {
      yield* durableRun(
        function* (): Workflow<string> {
          yield* durableAll([
            function* () {
              try {
                yield* durableCall("first-append", () => {
                  firstExecutions++;
                  return Promise.resolve("first");
                });
              } catch (error) {
                firstCaught = error;
              }
              yield* ephemeral(secondObserved.operation);
              return "caught";
            },
            function* () {
              yield* ephemeral(stream.firstAppendStarted.operation);
              try {
                yield* durableCall("queued-append", () => {
                  secondExecutions++;
                  secondExecuted.resolve();
                  return Promise.resolve("second");
                });
              } catch (error) {
                secondCaught = error;
              }
              secondObserved.resolve();
              return "caught";
            },
            function* () {
              yield* ephemeral(secondExecuted.operation);
              yield* ephemeral(sleep(0));
              stream.releaseFirstAppend.resolve();
              return "released";
            },
          ]);
          return "must-not-close";
        },
        { stream },
      );
    } catch (error) {
      failure = error;
    }

    expect(firstExecutions).toBe(1);
    expect(secondExecutions).toBe(1);
    expect(stream.attempts).toHaveLength(1);
    expect(stream.snapshot()).toEqual([]);
    expect(firstCaught).toBe(failure);
    expect(secondCaught).toBe(failure);
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    if (!(failure instanceof DurablePersistenceError)) {
      throw new Error("expected durable persistence failure");
    }
    expect(failure.cause).toBe(adapterFailure);
  });

  it("keeps a caught guard-policy rejection non-poisoning", function* () {
    const backend = new InMemoryStream();
    const rejection = new Error("policy rejected first yield");
    let blockedExecutions = 0;
    let laterExecutions = 0;
    let caught: unknown;
    const stream = guardDurableStream(
      backend,
      // deno-lint-ignore require-yield
      function* (event) {
        if (event.type === "yield" && event.description.name === "blocked") {
          throw rejection;
        }
      },
    );

    const result = yield* durableRun(
      function* (): Workflow<string> {
        try {
          yield* durableCall("blocked", () => {
            blockedExecutions++;
            return Promise.resolve("blocked");
          });
        } catch (error) {
          caught = error;
        }
        return yield* durableCall("later", () => {
          laterExecutions++;
          return Promise.resolve("completed");
        });
      },
      { stream },
    );

    expect(result).toBe("completed");
    expect(caught).toBe(rejection);
    expect(blockedExecutions).toBe(1);
    expect(laterExecutions).toBe(1);
    expect(backend.appendCount).toBe(2);
    expect(
      backend
        .snapshot()
        .map((event) =>
          event.type === "yield" ? `yield:${event.description.name}` : `close:${event.coroutineId}`,
        ),
    ).toEqual(["yield:later", "close:root"]);
  });
});
