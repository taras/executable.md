/**
 * Tier WFC2 — `xmd workflow cancel` and `xmd workflow delete`.
 *
 * Shelled out, so the exit code and the two output streams are what a caller
 * sees. A management command reports its own request: cancelling a run that
 * becomes terminal is success, and only a request the command cannot answer
 * exits 1.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, ensure, Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { ensureDir, exists, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "@executablemd/test-support/launch";
import { workflowRunLock, workflowRunPath } from "@executablemd/workflow/deno";
import { useWorkflowLifecycle, useWorkflowRunHost } from "@executablemd/workflow/deno";
import type { WorkflowExecutionTransitions } from "@executablemd/workflow/deno";
import { Git, suspendFor, WorkflowLifecycle } from "@executablemd/workflow";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { collect, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { runWorkflow } from "../src/workflow.ts";
import type { WorkflowExecution, WorkflowHost, WorkflowRequest } from "../src/workflow.ts";

interface Fixture {
  readonly repository: string;
  readonly runs: string;
  readonly home: string;
}

const RELEASE = ["# Release", "", "Nothing but prose.", ""].join("\n");

function* git(repository: string, args: string[]): Operation<void> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function useFixture<T>(body: (fixture: Fixture) => Operation<T>): Operation<T> {
  return scoped(function* () {
    const root = join(tmpdir(), `xmd-wfc2-${randomUUID()}`);
    const fixture: Fixture = {
      repository: join(root, "repository"),
      runs: join(root, "runs"),
      home: join(root, "home"),
    };
    yield* ensure(() => rm(root, { recursive: true, force: true }));
    yield* ensureDir(fixture.repository);
    yield* ensureDir(fixture.home);
    yield* writeTextFile(join(fixture.repository, "flow.md"), RELEASE);

    yield* git(fixture.repository, ["init", "-q", "--initial-branch=main", "."]);
    yield* git(fixture.repository, ["config", "user.email", "tier-wfc2@example.test"]);
    yield* git(fixture.repository, ["config", "user.name", "Tier WFC2"]);
    yield* git(fixture.repository, ["add", "-A"]);
    // The fixture is not the developer's repository: whatever signing their own
    // configuration asks for is not this commit's business.
    yield* git(fixture.repository, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "definition",
    ]);

    return yield* body(fixture);
  });
}

function xmd(fixture: Fixture, args: string[]) {
  return runCli(args, {
    cwd: fixture.repository,
    env: { HOME: fixture.home, XMD_WORKFLOW_RUNS: fixture.runs },
  });
}

describe("Tier WFC2 — xmd workflow cancel and delete", () => {
  it("WFC2-1: a completed run refuses cancellation and reports its own request", function* () {
    yield* useFixture(function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flow.md"]).expect();

      // Its outcome already won.
      const refused = yield* xmd(fixture, ["workflow", "cancel", "release-1"]).join();
      expect(refused.code).toBe(1);
      expect(refused.stdout).toBe("");
      expect(yield* status(fixture, "release-1")).toBe("completed");
    });
  });

  it("WFC2-2: cancelling a resumable run succeeds and reports the retained status", function* () {
    yield* useFixture(function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flow.md"]).expect();
      // A run whose outcome has not won: the only way to reach one from here is
      // to take the root Close away, which is what an interrupted run looks
      // like on disk.
      yield* interrupt(fixture, "release-1");

      const cancelled = yield* xmd(fixture, ["workflow", "cancel", "release-1"]).join();
      expect(cancelled.code).toBe(0);
      expect(cancelled.stdout).toContain("workflow cancel: release-1");
      expect(cancelled.stdout).toContain("cancelled");
      expect(yield* status(fixture, "release-1")).toBe("cancelled");

      // Idempotent: asking again is the same answer, not an error.
      const again = yield* xmd(fixture, ["workflow", "cancel", "release-1"]).join();
      expect(again.code).toBe(0);
    });
  });

  it("WFC2-3: delete removes the run and says what went", function* () {
    yield* useFixture(function* (fixture) {
      yield* xmd(fixture, ["workflow", "start", "--id=release-1", "flow.md"]).expect();
      yield* xmd(fixture, ["workflow", "start", "--id=release-2", "flow.md"]).expect();

      const deleted = yield* xmd(fixture, ["workflow", "delete", "release-1"]).join();
      expect(deleted.code).toBe(0);
      expect(deleted.stdout).toContain("workflow delete: release-1");
      expect(deleted.stdout).toContain("run-storage");

      expect(yield* exists(workflowRunPath(fixture.runs, "release-1"))).toBe(false);
      // The empty lock may remain; it is host arrangement, not retained state,
      // and it is not a category the caller is told about.
      expect(deleted.stdout).not.toContain("lifecycle-control");

      // The run beside it is still there and still readable.
      expect(yield* status(fixture, "release-2")).toBe("completed");

      // Absent is an error rather than an idempotent success.
      const again = yield* xmd(fixture, ["workflow", "delete", "release-1"]).join();
      expect(again.code).toBe(1);
      expect(again.stdout).toBe("");
    });
  });

  it("WFC2-4: an absent run is refused by both, and nothing is created", function* () {
    yield* useFixture(function* (fixture) {
      for (const action of ["cancel", "delete"]) {
        const refused = yield* xmd(fixture, ["workflow", action, "never-started"]).join();
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain("never-started");
      }
      expect(yield* exists(workflowRunPath(fixture.runs, "never-started"))).toBe(false);
      expect(yield* exists(workflowRunLock(fixture.runs, "never-started"))).toBe(true);
    });
  });
});

/** What `status --json` says this run retains. */
function* status(fixture: Fixture, runId: string): Operation<string> {
  const answered = yield* xmd(fixture, ["workflow", "status", runId, "--json"]).join();
  if (answered.code !== 0) {
    throw new Error(`status ${runId} failed: ${answered.stderr}`);
  }
  return JSON.parse(answered.stdout).record.status;
}

/**
 * The retained shape an interrupted run has: an outcome its root never
 * recorded. Removing the Close is the only way to reach it from here, since
 * this fixture's document cannot be made to hang.
 */
// deno-lint-ignore require-yield
function* interrupt(fixture: Fixture, runId: string): Operation<void> {
  const database = new DatabaseSync(workflowRunPath(fixture.runs, runId));
  try {
    database.exec('DELETE FROM journal_events WHERE record LIKE \'%"type":"close"%\'');
    database.exec("UPDATE workflow_run SET status = 'interrupted'");
    database.exec("UPDATE document_executions SET stop_status = 'interrupted'");
  } finally {
    database.close();
  }
}

/**
 * Tier WFC3 — cancellation against a run that is settling into a suspension.
 *
 * The interesting moment is narrow: a document has reported a durable wait, its
 * execution is tearing down, the executor lock is still held and no status has
 * been published. Everything A14 asks about lives there.
 *
 * It is reached without a sleep and without polling, because that moment *is* a
 * finalizer. The suspension controller runs one provider-private observation
 * while the execution tears down, and the cancellation attempt happens inside
 * it — deterministically mid-settlement, every run.
 *
 * `runWorkflow()` takes its document machinery as a parameter, so this needs no
 * subprocess: the executor here is the same observation point the shared CLI
 * fills, holding the same lock through the same teardown.
 */

const WAIT_SCHEMA = { type: "object", properties: { approved: { type: "boolean" } } };

const CONTROL_REQUEST: WorkflowRequest = {
  action: "start",
  target: "flow.md",
  id: undefined,
  verbose: false,
  raw: false,
  secretDetection: false,
};

/** The object id the fixture's own commit gave its definition. */
function* definitionObject(fixture: Fixture): Operation<string> {
  const result = yield* exec("git", {
    arguments: ["rev-parse", "HEAD:flow.md"],
    cwd: fixture.repository,
  }).expect();
  return result.stdout.trim();
}

/** The definition, answered at the Git boundary the retained run reads across. */
function useDefinitionGit(fixture: Fixture, objectId: string): Operation<void> {
  return Git.around(
    {
      // deno-lint-ignore require-yield
      *repositoryRoot(): Operation<string> {
        return fixture.repository;
      },
      // deno-lint-ignore require-yield
      *revParse(): Operation<string> {
        return objectId;
      },
      // deno-lint-ignore require-yield
      *readObject(): Operation<string> {
        return RELEASE;
      },
      // deno-lint-ignore require-yield
      *objectFormat(): Operation<"sha1" | "sha256"> {
        return "sha1";
      },
    },
    { at: "min" },
  );
}

/** What one attachment did, so a test can say whether it is still alive. */
interface Attachment {
  readonly events: string[];
  /** Run while this attachment is being released, which is mid-settlement. */
  readonly onRelease?: () => Operation<void>;
  /** Fail this attachment's release, which is a real teardown failure. */
  readonly failOnRelease?: boolean;
}

/**
 * A host whose attachment is a real scoped resource.
 *
 * The Workspace attachment is where an execution's longest-lived structure
 * lives, so a suite that wrapped it in a no-op could not tell an attachment that
 * was released from one that is still open — nor prove what happens when
 * releasing one fails. This attaches for real: it records when it opened and
 * when it was released, and it can fail on release, which is an ordinary
 * finalizer of the execution and nothing to do with the suspension controller.
 */
function liveHost(root: string, attachment: Attachment): WorkflowHost {
  return {
    useRunHost(): Operation<WorkflowExecutionTransitions> {
      return useWorkflowRunHost({ root });
    },
    useLifecycle(): Operation<void> {
      return useWorkflowLifecycle({ root });
    },
    attach<T>(_database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      return scoped(function* () {
        attachment.events.push("attached");
        yield* ensure(function* () {
          attachment.events.push("released");
          if (attachment.onRelease !== undefined) {
            yield* attachment.onRelease();
          }
          if (attachment.failOnRelease === true) {
            throw new Error("PLANTED-ATTACHMENT-RELEASE-FAILURE");
          }
        });
        return yield* operation;
      });
    },
  };
}

function useWaitingDocument(): Operation<void> {
  return registerComponents([
    {
      name: "Wait",
      origin: "tier-wfc3",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* suspendFor({ request: { kind: "approval" }, responseSchema: WAIT_SCHEMA });
        return "";
      },
    },
  ]);
}

function waitingBody(): (execution: WorkflowExecution) => Operation<Result<void>> {
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

/** The lifecycle rows a cancellation must not move. */
function lifecycleRows(path: string): { status: string; executions: string[] } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      status: String(
        database.prepare("SELECT status FROM workflow_run WHERE id = 1").get()?.["status"],
      ),
      executions: database
        .prepare("SELECT stop_status AS status FROM document_executions ORDER BY sequence")
        .all()
        .map((row) => String(row["status"])),
    };
  } finally {
    database.close();
  }
}

function* startedRun(root: string, repository: string, objectId: string): Operation<string> {
  return yield* scoped(function* () {
    const transitions = yield* useWorkflowRunHost({ root });
    const runId = randomUUID();
    const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
    if (!acquired.ok || acquired.value.kind !== "acquired") {
      throw new Error(`${runId} could not be created`);
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
          objectId,
          rootDocumentPath: "flow.md",
        },
        props: {},
        retrieval: { kind: "local-checkout", checkout: repository },
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

describe("Tier WFC3 — cancelling a run that is settling into a suspension", () => {
  it("WFC3-1: refuses against the live lock, changes nothing, and settlement continues", function* () {
    yield* useFixture(function* (fixture) {
      yield* scoped(function* () {
        const root = fixture.runs;
        const objectId = yield* definitionObject(fixture);
        yield* useDefinitionGit(fixture, objectId);
        yield* useWaitingDocument();

        const runId = yield* startedRun(root, fixture.repository, objectId);
        const path = workflowRunPath(root, runId);

        let refusal: Result<unknown> | undefined;
        let duringRows: { status: string; executions: string[] } | undefined;
        // The barrier is the execution attachment being released, which is the
        // lifecycle boundary this claim is about: the wait has been reported,
        // teardown is running, the executor lock is still this execution's and
        // no status has been published. No suspension-controller hook and no
        // sleep — just the finalizer production already runs here.
        const attachment: Attachment = {
          events: [],
          *onRelease(): Operation<void> {
            yield* scoped(function* () {
              yield* useWorkflowLifecycle({ root });
              refusal = yield* WorkflowLifecycle.operations.cancel(runId);
            });
            duringRows = lifecycleRows(path);
          },
        };

        const outcome = yield* runWorkflow(
          { ...CONTROL_REQUEST, action: "resume", target: runId },
          undefined,
          liveHost(root, attachment),
          waitingBody(),
        );

        // The refusal observed a live executor rather than acquiring anything.
        expect(refusal?.ok).toBe(false);
        expect(String(refusal?.ok === false ? refusal.error.message : "")).toContain("running");

        // It moved nothing. The run was still `running` mid-settlement, with no
        // suspended record yet — the refusal neither published a status nor
        // closed an execution.
        expect(duringRows?.status).toBe("running");
        expect(duringRows?.executions).not.toContain("cancelled");
        expect(duringRows?.executions).not.toContain("suspended");

        // And it neither resolved nor halted the settlement: teardown finished
        // and the run settled suspended anyway.
        expect(outcome.exitCode).toBe(2);
        const after = lifecycleRows(path);
        expect(after.status).toBe("suspended");
        expect(after.executions.filter((status) => status === "suspended")).toHaveLength(1);
        expect(after.executions).not.toContain("cancelled");

        // Nothing of the execution outlived its settlement: the attachment was
        // opened and released, in that order, before this returned.
        expect(attachment.events).toEqual(["attached", "released"]);
      });
    });
  });

  it("WFC3-2: an attachment that fails to release settles failed, never suspended", function* () {
    yield* useFixture(function* (fixture) {
      yield* scoped(function* () {
        const root = fixture.runs;
        const objectId = yield* definitionObject(fixture);
        yield* useDefinitionGit(fixture, objectId);
        yield* useWaitingDocument();

        const runId = yield* startedRun(root, fixture.repository, objectId);
        const path = workflowRunPath(root, runId);
        const published: string[] = [];

        // The failure is the Workspace attachment's own release — an ordinary
        // finalizer of the execution, outside the suspension controller
        // entirely. Nothing here uses a controller hook to produce it.
        const attachment: Attachment = {
          events: [],
          failOnRelease: true,
          *onRelease(): Operation<void> {
            published.push(lifecycleRows(path).status);
          },
        };

        const outcome = yield* runWorkflow(
          { ...CONTROL_REQUEST, action: "resume", target: runId },
          undefined,
          liveHost(root, attachment),
          waitingBody(),
        );

        // Teardown is settlement evidence, not work after the outcome: a
        // teardown that raised leaves a failed run, and `suspended` is never
        // published at any point.
        expect(outcome.exitCode).toBe(1);
        const after = lifecycleRows(path);
        expect(after.status).toBe("failed");
        expect(after.executions).not.toContain("suspended");
        expect(published).not.toContain("suspended");

        // The attachment really was released — it raised while releasing, which
        // is what a teardown failure is.
        expect(attachment.events).toEqual(["attached", "released"]);
      });
    });
  });
});
