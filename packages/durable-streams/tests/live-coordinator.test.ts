import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { type Operation, spawn, suspend, withResolvers } from "effection";
import {
  createDurableOperation,
  type ActivateDurabilityFailure,
  claimDurablePublicationIdentity,
  durableAction,
  durableCall,
  durableRun,
  DurablePersistenceError,
  InMemoryStream,
  type DurableEvent,
  type DurablePublicationIdentity,
  type DurableStream,
  type Json,
  type LiveDurableOperationCoordinator,
  type Result,
  type Workflow,
} from "../mod.ts";

function yields(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield");
}

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

function* coordinatedStep<T extends Json>(
  name: string,
  execute: () => Operation<T>,
  coordinator?: LiveDurableOperationCoordinator,
): Workflow<void> {
  yield createDurableOperation({ type: "coordinated", name }, execute, { coordinator });
}

describe("Tier DLC — live durable-operation coordination", () => {
  it("DLC1: default live success executes and publishes once before resumption", function* () {
    const timeline: string[] = [];
    const stream = new InMemoryStream();
    stream.onAppend = (event) => {
      if (event.type === "yield") {
        timeline.push("publish");
      }
    };

    function* workflow(): Workflow<string> {
      yield* coordinatedStep("success", function* () {
        timeline.push("execute");
        return "value";
      });
      timeline.push("resume");
      return "done";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("done");
    expect(timeline).toEqual(["execute", "publish", "resume"]);
    expect(yields(stream.snapshot())).toHaveLength(1);
  });

  it("DLC2: execution failure publishes the existing failed Result once", function* () {
    const stream = new InMemoryStream();
    let executions = 0;

    function* workflow(): Workflow<void> {
      yield* coordinatedStep("failure", function* () {
        executions += 1;
        throw new TypeError("operation failed");
      });
    }

    const failure = yield* raised(durableRun(workflow, { stream }));
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("the durable failure was not restored as an Error");
    }
    expect(failure.name).toBe("TypeError");
    expect(executions).toBe(1);
    const recorded = yields(stream.snapshot());
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      type: "yield",
      coroutineId: "root",
      description: { type: "coordinated", name: "failure" },
      result: {
        status: "err",
        error: expect.objectContaining({ name: "TypeError", message: "operation failed" }),
      },
    });
  });

  it("DLC3: publication failure reaches the caller and is never republished", function* () {
    const publicationFailure = new Error("publication failed");
    const accepted: DurableEvent[] = [];
    let appendAttempts = 0;
    let resumed = false;
    const stream: DurableStream = {
      // deno-lint-ignore require-yield
      *readAll(): Operation<DurableEvent[]> {
        return [...accepted];
      },
      // deno-lint-ignore require-yield
      *append(event): Operation<void> {
        appendAttempts += 1;
        throw publicationFailure;
      },
    };

    function* workflow(): Workflow<void> {
      yield* coordinatedStep("publish-failure", function* () {
        return "executed";
      });
      resumed = true;
    }

    const failure = yield* raised(durableRun(workflow, { stream }));
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    if (!(failure instanceof DurablePersistenceError)) {
      throw new Error("expected coordinated publication to fail durably");
    }
    expect(failure.cause).toBe(publicationFailure);
    expect(appendAttempts).toBe(1);
    expect(accepted).toEqual([]);
    expect(resumed).toBe(false);
  });

  it("DLC4: active fail-stop state prevents later coordination and execution", function* () {
    const publicationFailure = new Error("first publication failed");
    let appendAttempts = 0;
    const stream: DurableStream = {
      // deno-lint-ignore require-yield
      *readAll(): Operation<DurableEvent[]> {
        return [];
      },
      // deno-lint-ignore require-yield
      *append(): Operation<void> {
        appendAttempts += 1;
        throw publicationFailure;
      },
    };
    let firstExecutions = 0;
    let laterExecutions = 0;
    let coordinations = 0;
    let caught: unknown;
    const coordinator: LiveDurableOperationCoordinator = {
      *run<T extends Json>(
        execute: () => Operation<T>,
        publish: (result: Result) => Operation<void>,
      ): Operation<Result> {
        coordinations += 1;
        const value = yield* execute();
        const result: Result = { status: "ok", value };
        yield* publish(result);
        return result;
      },
    };

    function* workflow(): Workflow<void> {
      try {
        yield* coordinatedStep("poison", function* () {
          firstExecutions += 1;
          return "first";
        });
      } catch (error) {
        caught = error;
      }
      yield* coordinatedStep(
        "blocked",
        function* () {
          laterExecutions += 1;
          return "not reached";
        },
        coordinator,
      );
    }

    const failure = yield* raised(durableRun(workflow, { stream }));
    expect(failure).toBe(caught);
    expect(failure).toBeInstanceOf(DurablePersistenceError);
    if (!(failure instanceof DurablePersistenceError)) {
      throw new Error("expected the first durability failure to remain active");
    }
    expect(failure.cause).toBe(publicationFailure);
    expect(firstExecutions).toBe(1);
    expect(laterExecutions).toBe(0);
    expect(coordinations).toBe(0);
    expect(appendAttempts).toBe(1);
  });

  it("DLC5: complete replay bypasses coordinator, execution, publication and append", function* () {
    const stream = new InMemoryStream([
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "coordinated", name: "replayed" },
        result: { status: "ok", value: "stored" },
      },
      { type: "close", coroutineId: "root", result: { status: "ok", value: "done" } },
    ]);
    let executions = 0;
    let coordinations = 0;
    const coordinator: LiveDurableOperationCoordinator = {
      *run<T extends Json>(
        execute: () => Operation<T>,
        publish: (result: Result) => Operation<void>,
      ): Operation<Result> {
        coordinations += 1;
        const result: Result = { status: "ok", value: yield* execute() };
        yield* publish(result);
        return result;
      },
    };

    function* workflow(): Workflow<string> {
      yield* coordinatedStep(
        "replayed",
        function* () {
          executions += 1;
          return "live";
        },
        coordinator,
      );
      return "done";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("done");
    expect({ executions, coordinations, appends: stream.appendCount }).toEqual({
      executions: 0,
      coordinations: 0,
      appends: 0,
    });
  });

  it("DLC6: partial replay coordinates only the live suffix", function* () {
    const stream = new InMemoryStream([
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "coordinated", name: "first" },
        result: { status: "ok", value: "stored" },
      },
    ]);
    const executed: string[] = [];
    let coordinations = 0;
    const coordinator: LiveDurableOperationCoordinator = {
      *run<T extends Json>(
        execute: () => Operation<T>,
        publish: (result: Result) => Operation<void>,
      ): Operation<Result> {
        coordinations += 1;
        const result: Result = { status: "ok", value: yield* execute() };
        yield* publish(result);
        return result;
      },
    };

    function* workflow(): Workflow<string> {
      yield* coordinatedStep(
        "first",
        function* () {
          executed.push("first");
          return "live-first";
        },
        coordinator,
      );
      yield* coordinatedStep(
        "second",
        function* () {
          executed.push("second");
          return "live-second";
        },
        coordinator,
      );
      return "done";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("done");
    expect(executed).toEqual(["second"]);
    expect(coordinations).toBe(1);
    expect(yields(stream.snapshot())).toHaveLength(2);
  });

  it("DLC7: cancellation during execution or publication produces no late Yield", function* () {
    const executionStream = new InMemoryStream();
    const executionStarted = withResolvers<void>();
    function* executionWorkflow(): Workflow<void> {
      yield* coordinatedStep("cancel-execute", function* () {
        executionStarted.resolve();
        yield* suspend();
        return null;
      });
    }
    const executionTask = yield* spawn(() =>
      durableRun(executionWorkflow, {
        stream: executionStream,
      }),
    );
    yield* executionStarted.operation;
    yield* executionTask.halt();
    expect(yields(executionStream.snapshot())).toEqual([]);

    const publicationStarted = withResolvers<void>();
    let publicationAttempts = 0;
    const publicationStream: DurableStream = {
      // deno-lint-ignore require-yield
      *readAll(): Operation<DurableEvent[]> {
        return [];
      },
      *append(event): Operation<void> {
        if (event.type === "yield") {
          publicationAttempts += 1;
          publicationStarted.resolve();
          yield* suspend();
        }
      },
    };
    function* publicationWorkflow(): Workflow<void> {
      yield* coordinatedStep("cancel-publish", function* () {
        return "ready";
      });
    }
    const publicationTask = yield* spawn(() =>
      durableRun(publicationWorkflow, { stream: publicationStream }),
    );
    yield* publicationStarted.operation;
    yield* publicationTask.halt();
    expect(publicationAttempts).toBe(1);
    expect(yield* publicationStream.readAll()).toEqual([]);
  });

  it("DLC8: an explicit coordinator affects only its selected operation", function* () {
    const stream = new InMemoryStream();
    const identity = claimDurablePublicationIdentity(stream);
    let coordinated = 0;
    let ordinary = 0;
    const coordinator: LiveDurableOperationCoordinator = {
      *run<T extends Json>(
        execute: () => Operation<T>,
        publish: (result: Result) => Operation<void>,
        _activateFailure: ActivateDurabilityFailure,
        publicationIdentity: DurablePublicationIdentity | undefined,
      ): Operation<Result> {
        expect(publicationIdentity).toBe(identity);
        expect(Reflect.get(publicationIdentity ?? {}, "append")).toBe(undefined);
        expect(Reflect.get(publicationIdentity ?? {}, "readAll")).toBe(undefined);
        coordinated += 1;
        const result: Result = { status: "ok", value: yield* execute() };
        yield* publish(result);
        return result;
      },
    };

    function* workflow(): Workflow<string> {
      yield* coordinatedStep(
        "selected",
        function* () {
          return "selected";
        },
        coordinator,
      );
      yield* durableCall("ordinary", function* () {
        ordinary += 1;
        return "ordinary";
      });
      return "done";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("done");
    expect({ coordinated, ordinary }).toEqual({ coordinated: 1, ordinary: 1 });
  });

  it("DLC9: callback-based durable effects retain their existing path", function* () {
    const stream = new InMemoryStream();
    let executions = 0;
    function* workflow(): Workflow<string> {
      yield* durableAction("callback", (resolve) => {
        executions += 1;
        resolve("callback-value");
        return () => {};
      });
      return "done";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("done");
    expect(executions).toBe(1);
    expect(yields(stream.snapshot())).toHaveLength(1);
  });

  it("DLC14: a coordinator activates one infrastructure failure by identity", function* () {
    const infrastructureFailure = new Error("coordinated infrastructure failed");
    const stream = new InMemoryStream();
    let caught: unknown;
    let laterExecutions = 0;
    const coordinator: LiveDurableOperationCoordinator = {
      *run<T extends Json>(
        execute: () => Operation<T>,
        _publish: (result: Result) => Operation<void>,
        activateFailure: ActivateDurabilityFailure,
      ): Operation<Result> {
        try {
          yield* execute();
        } catch (error) {
          throw activateFailure(error);
        }
        throw new Error("the infrastructure proof unexpectedly completed");
      },
    };

    function* workflow(): Workflow<void> {
      try {
        yield* coordinatedStep(
          "infrastructure",
          function* () {
            throw infrastructureFailure;
          },
          coordinator,
        );
      } catch (error) {
        caught = error;
      }
      yield* durableCall("fenced", function* () {
        laterExecutions += 1;
        return null;
      });
    }

    const escaped = yield* raised(durableRun(workflow, { stream }));
    expect(escaped).toBe(infrastructureFailure);
    expect(caught).toBe(infrastructureFailure);
    expect(laterExecutions).toBe(0);
    expect(stream.appendCount).toBe(0);
  });
});
