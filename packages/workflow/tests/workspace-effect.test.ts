import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile } from "@effectionx/fs";
import { type Operation } from "effection";
import {
  durableCall,
  durableRun,
  InMemoryStream,
  type DurableEvent,
  type Json,
  type Result,
  type Workflow,
} from "@executablemd/durable-streams";
import {
  createDurableWorkspaceOperation,
  WorkspaceCoordination,
  WorkspaceCoordinationProviderError,
} from "../mod.ts";

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
    expect(yieldEvents(stream.snapshot())).toEqual([]);
  });

  it("DLC11: explicit Workspace selection leaves unrelated durable operations ordinary", function* () {
    const stream = new InMemoryStream();
    const coordinated: string[] = [];
    const ordinary: string[] = [];
    yield* WorkspaceCoordination.around({
      *run<T extends Json>([execute, publish]: [
        () => Operation<T>,
        (result: Result) => Operation<void>,
      ]): Operation<Result> {
        coordinated.push("workspace");
        const result: Result = { status: "ok", value: yield* execute() };
        yield* publish(result);
        return result;
      },
    });

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

    expect(yield* durableRun(workflow, { stream })).toBe("done");
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
});
