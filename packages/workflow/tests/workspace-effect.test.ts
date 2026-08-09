import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import { type Operation } from "effection";
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
  type WorkspaceCoordinationInvocation,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationInvocation,
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
      *run(invocation: WorkspaceCoordinationInvocation): Operation<Result> {
        return yield* withWorkspaceCoordinationInvocation(invocation, function* (authority) {
          expect(authority.publicationIdentity).toBe(publicationIdentity);
          expect(Reflect.get(authority.publicationIdentity ?? {}, "append")).toBe(undefined);
          expect(Reflect.get(authority.publicationIdentity ?? {}, "readAll")).toBe(undefined);
          coordinated.push("workspace");
          const result: Result = { status: "ok", value: yield* authority.execute() };
          yield* authority.publish(result);
          return result;
        });
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
    let captured: WorkspaceCoordinationInvocation | undefined;
    let capturedAuthority: WorkspaceCoordinationAuthority | undefined;
    let executions = 0;
    const provider: WorkspaceCoordinationProvider = {
      *run(invocation: WorkspaceCoordinationInvocation): Operation<Result> {
        captured = invocation;
        return yield* withWorkspaceCoordinationInvocation(invocation, function* (authority) {
          capturedAuthority = authority;
          const result: Result = { status: "ok", value: yield* authority.execute() };
          yield* authority.publish(result);
          return result;
        });
      },
    };
    function* workflow(): Workflow<void> {
      yield* workspaceStep("one-shot", function* () {
        executions += 1;
        return null;
      });
    }

    yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));
    if (captured === undefined) {
      throw new Error("the provider did not receive its live invocation");
    }
    let reused = 0;
    const failure = yield* raised(
      withWorkspaceCoordinationInvocation(captured, function* () {
        reused += 1;
        return { status: "ok", value: null };
      }),
    );
    expect(failure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(reused).toBe(0);
    if (capturedAuthority === undefined) {
      throw new Error("the provider did not receive its live invocation authority");
    }
    expect(yield* raised(capturedAuthority.execute())).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(
      yield* raised(capturedAuthority.publish({ status: "ok", value: "late" })),
    ).toBeInstanceOf(WorkspaceCoordinationProviderError);
    let activationFailure: unknown;
    try {
      capturedAuthority.activateFailure(new Error("late activation"));
    } catch (error) {
      activationFailure = error;
    }
    expect(activationFailure).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(executions).toBe(1);
    expect(yieldEvents(stream.snapshot())).toHaveLength(1);
  });
});
