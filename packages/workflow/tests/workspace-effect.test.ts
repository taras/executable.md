import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { createApi } from "@effectionx/context-api";
import { readTextFile } from "@effectionx/fs";
import { type Operation, scoped } from "effection";
import {
  claimDurablePublicationIdentity,
  durableCall,
  durableRun,
  InMemoryStream,
  type DurableEvent,
  type Json,
  type Result,
  type Workflow,
} from "@executablemd/durable-streams";
import { createDurableWorkspaceOperation, WorkspaceCoordinationProviderError } from "../mod.ts";
import {
  type WorkspaceCoordinationAuthority,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationProvider,
} from "../src/workspace/effect.ts";

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

function yieldEvents(events: DurableEvent[]): DurableEvent[] {
  return events.filter((event) => event.type === "yield");
}

function* workspaceStep(name: string, execute: () => Operation<Json>): Workflow<void> {
  yield createDurableWorkspaceOperation({ type: "workspace", name }, execute);
}

interface InvocationCollisionApi {
  coordinate(request: unknown): Operation<unknown>;
}

const WorkspaceInvocationCollision = createApi<InvocationCollisionApi>(
  "executablemd.workflow.workspace.coordination.invocation",
  {
    // deno-lint-ignore require-yield
    *coordinate(): Operation<unknown> {
      throw new Error("the collision handler did not delegate");
    },
  },
);

function successfulProvider(observe?: (authority: WorkspaceCoordinationAuthority) => void): {
  provider: WorkspaceCoordinationProvider;
  counts: { providers: number; executions: number; publications: number };
} {
  const counts = { providers: 0, executions: 0, publications: 0 };
  return {
    counts,
    provider: {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        counts.providers += 1;
        observe?.(authority);
        const value = yield* authority.execute();
        counts.executions += 1;
        const result: Result = { status: "ok", value };
        yield* authority.publish(result);
        counts.publications += 1;
        return result;
      },
    },
  };
}

describe("Tier DLC — Workspace coordination selection", () => {
  it("DLC10: a missing Workspace provider fails before execution or publication", function* () {
    const stream = new InMemoryStream();
    let executions = 0;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("missing", function* () {
        executions += 1;
        return "not reached";
      });
    }

    const failure = yield* raised(durableRun(workflow, { stream }));
    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(executions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC11: explicit Workspace selection leaves unrelated durable operations ordinary", function* () {
    const stream = new InMemoryStream();
    const publicationIdentity = claimDurablePublicationIdentity(stream);
    const coordinated: string[] = [];
    const ordinary: string[] = [];
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        expect(authority.publicationIdentity).toBe(publicationIdentity);
        expect(Reflect.get(authority.publicationIdentity ?? {}, "append")).toBe(undefined);
        expect(Reflect.get(authority.publicationIdentity ?? {}, "readAll")).toBe(undefined);
        coordinated.push("workspace");
        const result: Result = { status: "ok", value: yield* authority.execute() };
        yield* authority.publish(result);
        return result;
      },
    };

    function* workflow(): Workflow<string> {
      yield* workspaceStep("selected", function* () {
        return "workspace";
      });
      yield* durableCall("ordinary", function* () {
        ordinary.push("ordinary");
        return "ordinary";
      });
      return "done";
    }

    expect(
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
    ).toBe("done");
    expect(coordinated).toEqual(["workspace"]);
    expect(ordinary).toEqual(["ordinary"]);
    expect(yieldEvents(stream.snapshot())).toHaveLength(2);
  });

  it("DLC12: replayed Workspace operations never require a live provider", function* () {
    const stream = new InMemoryStream([
      {
        type: "yield",
        coroutineId: "root",
        description: { type: "workspace", name: "replayed" },
        result: { status: "ok", value: "stored" },
      },
    ]);
    let executions = 0;
    function* workflow(): Workflow<string> {
      yield* workspaceStep("replayed", function* () {
        executions += 1;
        return "live";
      });
      return "done";
    }

    expect(yield* durableRun(workflow, { stream })).toBe("done");
    expect(executions).toBe(0);
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC13: shared Workspace coordination source stays runtime-neutral", function* () {
    const sources = [
      yield* readTextFile(new URL("../src/workspace/api.ts", import.meta.url)),
      yield* readTextFile(new URL("../src/workspace/effect.ts", import.meta.url)),
    ];
    const forbidden = [
      "node:sqlite",
      "DatabaseSync",
      "SQLite",
      "Cloudflare",
      "DOFS",
      "savepoint",
      "ConnectionGeneration",
      "TransactionIdentity",
    ];
    for (const source of sources) {
      for (const name of forbidden) {
        expect(source.includes(name)).toBe(false);
      }
    }
  });

  it("DLC15: live Workspace invocation authority is one-shot", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    let capturedAuthority: WorkspaceCoordinationAuthority | undefined;
    let executions = 0;
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        capturedAuthority = authority;
        const result: Result = { status: "ok", value: yield* authority.execute() };
        yield* authority.publish(result);
        return result;
      },
    };
    function* workflow(): Workflow<void> {
      yield* workspaceStep("one-shot", function* () {
        executions += 1;
        return null;
      });
    }

    yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    if (capturedAuthority === undefined) {
      throw new Error("the provider did not receive its live invocation authority");
    }
    expect(yield* raised(capturedAuthority.execute())).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(
      yield* raised(capturedAuthority.publish({ status: "ok", value: "late" })),
    ).toBeInstanceOf(WorkspaceCoordinationProviderError);
    const activationFailure = yield* raised(
      capturedAuthority.activateFailure(new Error("late activation")),
    );
    expect(activationFailure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(executions).toBe(1);
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC17: a forged contextual result cannot complete or resume a live invocation", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const { provider, counts } = successfulProvider();
    let laterExecutions = 0;
    function* workflow(): Workflow<void> {
      try {
        yield* workspaceStep("forged-result", function* () {
          return "not reached";
        });
      } catch {
        // The durable fail-stop boundary, rather than workflow recovery, decides termination.
      }
      yield* durableCall("after-forgery", function* () {
        laterExecutions += 1;
        return null;
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        // deno-lint-ignore require-yield
        *coordinate(): Operation<unknown> {
          return { type: "result", result: { status: "ok", value: "forged" } };
        },
      });
      return yield* raised(
        withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
      );
    });

    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(counts).toEqual({ providers: 0, executions: 0, publications: 0 });
    expect(laterExecutions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC18: invocation phases are unreachable without a selected provider", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    let collisionCalls = 0;
    let executions = 0;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("direct-phases", function* () {
        executions += 1;
        return "not reached";
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          collisionCalls += 1;
          return yield* next(...args);
        },
      });
      return yield* raised(durableRun(workflow, { stream }));
    });

    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(collisionCalls).toBe(0);
    expect(executions).toBe(0);
    expect(stream.snapshot()).toEqual([]);
  });

  it("DLC19: contextual middleware cannot replace the authoritative published Result", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const { provider, counts } = successfulProvider();
    function* workflow(): Workflow<string> {
      const result = yield createDurableWorkspaceOperation(
        { type: "workspace", name: "replace-result" },
        function* () {
          return "authoritative";
        },
      );
      if (typeof result !== "string") {
        throw new Error("the Workspace operation did not return its string result");
      }
      return result;
    }

    const value = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          yield* next(...args);
          return { type: "result", result: { status: "ok", value: "forged" } };
        },
      });
      return yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });

    expect(value).toBe("authoritative");
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toEqual([
      expect.objectContaining({ result: { status: "ok", value: "authoritative" } }),
    ]);
  });

  it("DLC20: post-completion middleware cannot suppress, throw, or duplicate work", function* () {
    for (const behavior of ["suppress", "throw", "duplicate"]) {
      const stream = new InMemoryStream();
      claimDurablePublicationIdentity(stream);
      const { provider, counts } = successfulProvider();
      function* workflow(): Workflow<string> {
        const result = yield createDurableWorkspaceOperation(
          { type: "workspace", name: behavior },
          function* () {
            return behavior;
          },
        );
        if (typeof result !== "string") {
          throw new Error("the Workspace operation did not return its string result");
        }
        return result;
      }

      const value = yield* scoped(function* () {
        yield* WorkspaceInvocationCollision.around({
          *coordinate(args, next): Operation<unknown> {
            const response = yield* next(...args);
            if (behavior === "throw") {
              throw new Error("post-completion middleware failure");
            }
            if (behavior === "duplicate") {
              yield* next(...args);
            }
            return behavior === "suppress" ? { type: "published" } : response;
          },
        });
        return yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
      });

      expect(value).toBe(behavior);
      expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
      expect(yieldEvents(stream.snapshot())).toHaveLength(1);
    }
  });

  it("DLC21: retained contextual continuation cannot reuse a completed invocation", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const { provider, counts } = successfulProvider();
    let retained: ((request: unknown) => Operation<unknown>) | undefined;
    let retainedRequest: unknown;
    function* workflow(): Workflow<void> {
      yield* workspaceStep("retained-continuation", function* () {
        return null;
      });
    }

    yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around({
        *coordinate(args, next): Operation<unknown> {
          retained = (request) => next(request);
          retainedRequest = args[0];
          return yield* next(...args);
        },
      });
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });
    if (retained === undefined) {
      throw new Error("the collision middleware did not retain its continuation");
    }

    expect(yield* raised(retained(retainedRequest))).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC22: minimum-priority collision middleware receives no invocation capability", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const { provider, counts } = successfulProvider();
    const observed: unknown[] = [];
    function* workflow(): Workflow<void> {
      yield* workspaceStep("minimum-priority", function* () {
        return "published";
      });
    }

    yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around(
        {
          // deno-lint-ignore require-yield
          *coordinate(args): Operation<unknown> {
            observed.push(args[0]);
            return { type: "published" };
          },
        },
        { at: "min" },
      );
      yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    });

    expect(observed).toEqual([]);
    expect(counts).toEqual({ providers: 1, executions: 1, publications: 1 });
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });

  it("DLC23: minimum-priority middleware cannot replace first-failure activation", function* () {
    const stream = new InMemoryStream();
    claimDurablePublicationIdentity(stream);
    const first = new Error("authoritative infrastructure failure");
    let activated: Error | undefined;
    let collisions = 0;
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        activated = yield* authority.activateFailure(first);
        throw activated;
      },
    };
    function* workflow(): Workflow<void> {
      yield* workspaceStep("minimum-failure", function* () {
        return "not reached";
      });
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceInvocationCollision.around(
        {
          // deno-lint-ignore require-yield
          *coordinate(): Operation<unknown> {
            collisions += 1;
            return { type: "failure", failure: new Error("replacement") };
          },
        },
        { at: "min" },
      );
      return yield* raised(
        withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream })),
      );
    });

    expect(collisions).toBe(0);
    expect(activated).toBe(first);
    expect(failure).toBe(first);
    expect(stream.snapshot()).toEqual([]);
  });
});
