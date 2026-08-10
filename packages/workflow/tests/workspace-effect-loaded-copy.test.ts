import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { readTextFile, rm, writeTextFile } from "@effectionx/fs";
import { ensure, type Operation, scoped, until } from "effection";
import { pathToFileURL } from "node:url";
import {
  establishJournalProvenance,
  durableRun,
  InMemoryStream,
  type Json,
  type Result,
  type Workflow,
} from "@executablemd/durable-streams";
import { WorkspaceCoordination, WorkspaceCoordinationProviderError } from "../src/workspace/api.ts";
import {
  type WorkspaceCoordinationAuthority,
  type WorkspaceCoordinationProvider,
  withWorkspaceCoordinationProvider,
} from "../src/workspace/effect.ts";
import { createDurableWorkspaceOperation } from "../mod.ts";

interface LoadedWorkspaceCopy {
  createDurableWorkspaceOperation: typeof createDurableWorkspaceOperation;
}

function loadedWorkspaceCopy(value: unknown): value is LoadedWorkspaceCopy {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "createDurableWorkspaceOperation") === "function"
  );
}

function* physicalWorkspaceCopy(): Operation<LoadedWorkspaceCopy> {
  const directory = yield* until(Deno.makeTempDir({ prefix: "xmd-workflow-copy-" }));
  yield* ensure(() => rm(directory, { recursive: true, force: true }));
  const source = new URL("../src/workspace/", import.meta.url);
  const destination = pathToFileURL(`${directory}/`);
  yield* writeTextFile(
    new URL("api.ts", destination),
    yield* readTextFile(new URL("api.ts", source)),
  );
  yield* writeTextFile(
    new URL("effect.ts", destination),
    yield* readTextFile(new URL("effect.ts", source)),
  );
  const copy = yield* until(import(new URL("effect.ts", destination).href));
  if (!loadedWorkspaceCopy(copy)) {
    throw new Error("the physical Workspace package copy did not export its durable operation");
  }
  return copy;
}

function* raised(operation: Operation<unknown>): Operation<unknown> {
  try {
    yield* operation;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("Tier DLC — physical Workspace package composition", () => {
  it("DLC16: provider selection composes without sharing invocation authority", function* () {
    const copy = yield* physicalWorkspaceCopy();
    const stream = new InMemoryStream();
    establishJournalProvenance(stream);
    let providers = 0;
    let transactions = 0;
    let executions = 0;
    let publications = 0;
    let capturedAuthority: WorkspaceCoordinationAuthority | undefined;
    const provider: WorkspaceCoordinationProvider = {
      *run(authority: WorkspaceCoordinationAuthority): Operation<Result> {
        providers += 1;
        transactions += 1;
        capturedAuthority = authority;
        const result: Result = { status: "ok", value: yield* authority.execute() };
        publications += 1;
        yield* authority.publish(result);
        return result;
      },
    };
    function* workflow(): Workflow<void> {
      yield copy.createDurableWorkspaceOperation(
        { type: "workspace", name: "physical-copy" },
        function* (): Operation<Json> {
          executions += 1;
          return "copied";
        },
      );
    }

    yield* withWorkspaceCoordinationProvider(provider, durableRun(workflow, { stream }));

    expect({ providers, transactions, executions, publications }).toEqual({
      providers: 1,
      transactions: 1,
      executions: 1,
      publications: 1,
    });
    expect(stream.snapshot().filter((event) => event.type === "yield")).toHaveLength(1);
    if (capturedAuthority === undefined) {
      throw new Error("the provider did not receive the physical copy invocation");
    }
    expect(yield* raised(capturedAuthority.execute())).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );
    expect(
      yield* raised(capturedAuthority.publish({ status: "ok", value: "reused" })),
    ).toBeInstanceOf(WorkspaceCoordinationProviderError);
    expect(yield* raised(capturedAuthority.activateFailure(new Error("reused")))).toBeInstanceOf(
      WorkspaceCoordinationProviderError,
    );

    const refusedStream = new InMemoryStream();
    establishJournalProvenance(refusedStream);
    let refusedExecutions = 0;
    function* refusedWorkflow(): Workflow<void> {
      yield copy.createDurableWorkspaceOperation(
        { type: "workspace", name: "substituted-copy" },
        function* (): Operation<Json> {
          refusedExecutions += 1;
          return "not reached";
        },
      );
    }

    const failure = yield* scoped(function* () {
      yield* WorkspaceCoordination.around({ provider: () => Object.freeze({}) });
      return yield* raised(
        withWorkspaceCoordinationProvider(
          provider,
          durableRun(refusedWorkflow, { stream: refusedStream }),
        ),
      );
    });

    expect(Reflect.get(failure ?? {}, "name")).toBe("WorkspaceCoordinationProviderError");
    expect({ providers, transactions, refusedExecutions, publications }).toEqual({
      providers: 1,
      transactions: 1,
      refusedExecutions: 0,
      publications: 1,
    });
    expect(refusedStream.snapshot()).toEqual([]);
  });
});
