/**
 * Tier WFS — what a suspended run leaves, and what a resume finds.
 *
 * `runWorkflow()` takes its document machinery as a parameter, so the executor
 * here is the same observation point the shared CLI fills — no subprocess is
 * needed to hold the executor lock, tear an execution down or report an exit
 * code, and every barrier is a value rather than a wait.
 *
 * The suspension itself is real. The document body calls `suspendFor()`, which
 * publishes its request and then does not return; the settlement that follows
 * is the production path, including the halt that tears the execution down.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, ensure, Err, Ok, resource, scoped } from "effection";
import type { Operation, Result } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { mkdtemp } from "node:fs/promises";
import { until } from "effection";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { collect, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { durableCall } from "@executablemd/durable-streams";
import { useWorkflowLifecycle, useWorkflowRunHost } from "@executablemd/workflow/deno";
import type { WorkflowExecutionTransitions } from "@executablemd/workflow/deno";
import { Git, SUSPENSION_REQUEST, suspendFor, WorkflowLifecycle } from "@executablemd/workflow";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { workflowRunPath } from "@executablemd/workflow/deno";
import { runWorkflow } from "../src/workflow.ts";
import type { WorkflowExecution, WorkflowHost, WorkflowRequest } from "../src/workflow.ts";

const SCHEMA = { type: "object", properties: { approved: { type: "boolean" } } };

const REQUEST: WorkflowRequest = {
  action: "start",
  target: "workflow.md",
  id: undefined,
  verbose: false,
  raw: false,
  secretDetection: false,
};

function* git(repository: string, args: string[]): Operation<string> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function useRunStore(): Operation<string> {
  return resource<string>(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-wfs-")));
    yield* ensure(function* () {
      yield* rm(root, { recursive: true, force: true });
    });
    yield* provide(root);
  });
}

function host(root: string): WorkflowHost {
  return {
    useRunHost(): Operation<WorkflowExecutionTransitions> {
      return useWorkflowRunHost({ root });
    },
    useLifecycle(): Operation<void> {
      return useWorkflowLifecycle({ root });
    },
    attach<T>(_database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      return operation;
    },
  };
}

interface Fixture {
  readonly repository: string;
  readonly objectId: string;
  readonly contents: string;
}

function useFixture(): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const repository = yield* until(mkdtemp(join(tmpdir(), "xmd-wfs-repo-")));
    yield* ensure(function* () {
      yield* rm(repository, { recursive: true, force: true });
    });
    yield* git(repository, ["init", "--quiet"]);
    yield* git(repository, ["config", "user.email", "wfs@example.test"]);
    yield* git(repository, ["config", "user.name", "WFS"]);
    yield* writeTextFile(join(repository, "workflow.md"), "recorded\n");
    yield* git(repository, ["add", "workflow.md"]);
    // The fixture is not the developer's repository: whatever signing their own
    // configuration asks for is not this commit's business.
    yield* git(repository, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "definition"]);
    const objectId = (yield* git(repository, ["rev-parse", "HEAD:workflow.md"])).trim();
    yield* provide({ repository, objectId, contents: "recorded\n" });
  });
}

function useGit(fixture: Fixture): Operation<void> {
  return Git.around(
    {
      // deno-lint-ignore require-yield
      *repositoryRoot(): Operation<string> {
        return fixture.repository;
      },
      // deno-lint-ignore require-yield
      *revParse(): Operation<string> {
        return fixture.objectId;
      },
      // deno-lint-ignore require-yield
      *readObject(): Operation<string> {
        return fixture.contents;
      },
      // deno-lint-ignore require-yield
      *objectFormat(): Operation<"sha1" | "sha256"> {
        return "sha1";
      },
    },
    { at: "min" },
  );
}

/** Everything a second connection can see of one run. */
interface Retained {
  readonly status: string;
  readonly executions: { status: string | undefined; reasonEventId: string | undefined }[];
  readonly requests: string[];
  readonly requestEventId: string | undefined;
  readonly priorEffects: number;
  readonly rootCloses: number;
}

function retained(path: string): Retained {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const status = String(
      database.prepare("SELECT status FROM workflow_run WHERE id = 1").get()?.["status"],
    );
    const executions = database
      .prepare(
        "SELECT stop_status AS status, stop_reason_event_id AS reason FROM document_executions " +
          "ORDER BY sequence",
      )
      .all()
      .map((row) => ({
        status: row["status"] === null ? undefined : String(row["status"]),
        reasonEventId: row["reason"] === null ? undefined : String(row["reason"]),
      }));

    const requests: string[] = [];
    let requestEventId: string | undefined;
    let priorEffects = 0;
    let rootCloses = 0;
    for (const row of database
      .prepare("SELECT event_id AS id, record FROM journal_events ORDER BY sequence")
      .all()) {
      const parsed = JSON.parse(String(row["record"]));
      if (parsed?.type === "close" && parsed?.coroutineId === "root") {
        rootCloses += 1;
      }
      if (parsed?.type !== "yield") {
        continue;
      }
      if (parsed.description?.type === SUSPENSION_REQUEST) {
        requests.push(String(parsed.description.name));
        requestEventId = String(row["id"]);
      }
      if (parsed.description?.type === "call" && parsed.description?.name === "prior") {
        priorEffects += 1;
      }
    }
    return { status, executions, requests, requestEventId, priorEffects, rootCloses };
  } finally {
    database.close();
  }
}

/**
 * A run with its definition recorded and nothing executed yet.
 *
 * Created through the same transitions production uses, so what the executions
 * below resume is an ordinary retained run rather than a fixture shape.
 */
function* createRun(root: string, fixture: Fixture): Operation<string> {
  return yield* scoped(function* () {
    const transitions = yield* useWorkflowRunHost({ root });
    const runId = crypto.randomUUID();
    const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
    if (!acquired.ok) {
      throw acquired.error;
    }
    if (acquired.value.kind !== "acquired") {
      throw new Error(`${runId} already has a live workflow executor`);
    }
    const begun = yield* transitions.begin(acquired.value.lock, {
      runId,
      action: "start",
      creation: {
        base: "main",
        definition: {
          version: 1,
          kind: "git",
          objectFormat: "sha1",
          objectId: fixture.objectId,
          rootDocumentPath: "workflow.md",
        },
        props: {},
        retrieval: { kind: "local-checkout", checkout: fixture.repository },
      },
    });
    if (!begun.ok) {
      throw begun.error;
    }
    const settled = yield* transitions.settle(acquired.value.lock, {
      executionId: begun.value.execution.executionId,
      status: "interrupted",
      reason: { kind: "host", code: "executor-interrupted" },
    });
    if (!settled.ok) {
      throw settled.error;
    }
    return runId;
  });
}

/**
 * One durable effect, then one durable wait — as a real document.
 *
 * Run through `execution.around`, which is where the Workspace attachment and
 * the suspension controller are installed, and through `executeInstalled` with
 * the run's own installations. Anything less would call `suspendFor()` outside
 * the contexts it depends on and prove nothing about a suspended run.
 */
function useWaitingDocument(performed: string[]): Operation<void> {
  return registerComponents([
    {
      name: "Wait",
      origin: "tier-wfs",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* durableCall("prior", function* () {
          performed.push("performed-prior-effect");
          return "done";
        });
        performed.push("reached-the-wait");
        yield* suspendFor({ request: { kind: "approval" }, responseSchema: SCHEMA });
        performed.push("continued-past-the-wait");
        return "";
      },
    },
  ]);
}

function body(): (execution: WorkflowExecution) => Operation<Result<void>> {
  return function* (execution): Operation<Result<void>> {
    return yield* execution.around(
      call(function* (): Operation<Result<void>> {
        try {
          yield* collect(
            yield* executeInstalled(
              { ...inlineSource("<Wait />\n"), stream: execution.stream },
              execution.installations,
            ),
          );
          return Ok(undefined);
        } catch (error) {
          return Err(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
  };
}

describe("Tier WFS — a suspended run and its no-input resumes", () => {
  it("WFS1: suspends, exits 2, releases the lock, and resumes into the same wait", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useFixture();
    yield* useGit(fixture);

    const runId = yield* createRun(root, fixture);
    const performed: string[] = [];
    yield* useWaitingDocument(performed);

    const first = yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      host(root),
      body(),
    );

    const path = workflowRunPath(root, runId);

    // Suspension is its own outcome, and it is the exit code a caller reads.
    expect(first.exitCode).toBe(2);

    const afterFirst = retained(path);
    expect(afterFirst.status).toBe("suspended");

    // The run was created and left resumable before this suite ran, so its
    // own execution is the first row; every row after it belongs to an
    // invocation here.
    const firstSuspended = afterFirst.executions.filter(
      (execution) => execution.status === "suspended",
    );
    expect(firstSuspended).toHaveLength(1);

    // The stop reason names the retained request event rather than repeating
    // anything the request said.
    expect(firstSuspended[0]?.reasonEventId).toBe(afterFirst.requestEventId);

    // No Close: the halt left the root open, which is what makes the run
    // resumable at all.
    expect(afterFirst.rootCloses).toBe(0);
    expect(afterFirst.requests).toHaveLength(1);

    // The document performed its effect, reached the wait and stopped there.
    expect(performed).toEqual(["performed-prior-effect", "reached-the-wait"]);

    // The lock is free. Acquisition refuses outright while an executor holds
    // it, so acquiring at all is the proof it was released.
    yield* scoped(function* () {
      yield* useWorkflowLifecycle({ root });
      const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
      expect(acquired.ok).toBe(true);
      expect(acquired.ok && acquired.value.kind).toBe("acquired");
    });

    // Two no-input resumes, each reaching the same wait.
    for (const attempt of [1, 2]) {
      const resumed = yield* runWorkflow(
        { ...REQUEST, action: "resume", target: runId },
        undefined,
        host(root),
        body(),
      );
      expect(resumed.exitCode).toBe(2);

      const after = retained(path);
      expect(after.status).toBe("suspended");

      // One prior effect and one request across every execution: a resume
      // restores them rather than performing or publishing them again.
      expect(after.requests).toHaveLength(1);
      expect(after.requests[0]).toBe(afterFirst.requests[0]);
      expect(after.rootCloses).toBe(0);

      // One more execution record per attempt, every one settled `suspended`,
      // each naming the one retained request.
      const suspended = after.executions.filter((execution) => execution.status === "suspended");
      expect(suspended).toHaveLength(attempt + 1);
      expect(suspended.every((execution) => execution.reasonEventId === after.requestEventId)).toBe(
        true,
      );
    }

    // Three executions reached the wait and none continued past it, and the
    // prior effect was performed exactly once — the resumes restored it.
    expect(performed.filter((step) => step === "performed-prior-effect")).toHaveLength(1);
    expect(performed.filter((step) => step === "reached-the-wait")).toHaveLength(3);
    expect(performed).not.toContain("continued-past-the-wait");
  });
});
