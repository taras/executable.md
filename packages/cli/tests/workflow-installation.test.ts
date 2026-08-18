/**
 * Tier WFI — what `start` and `resume` hand to canonical core.
 *
 * The end-to-end tier (WFC) proves the lifecycle a caller sees. This one proves
 * its *shape*: that a run reaches core as an `ExecutionInstallation` the trusted
 * host passes to `executeInstalled()`, through exactly one execution, and that a
 * completed replay is given no Workspace to mutate.
 *
 * `runWorkflow()` takes its document machinery as a parameter, so none of this
 * needs a subprocess: the executor here is the observation point the shared CLI
 * fills with `runScopedDocument`.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { ensure, Err, Ok, resource, scoped, spawn, suspend, withResolvers } from "effection";
import type { Operation, Result } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { mkdtemp } from "node:fs/promises";
import { until } from "effection";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  useWorkflowInputDelivery,
  useWorkflowLifecycle,
  useWorkflowRunHost,
} from "@executablemd/workflow/deno";
import type { WorkflowExecutionTransitions } from "@executablemd/workflow/deno";
import { Git, WorkflowLifecycle, WorkflowRunStorage } from "@executablemd/workflow";
import type { WorkflowRunDatabase, WorkflowRunStatus } from "@executablemd/workflow";
import type { Json } from "@executablemd/core";
import { runWorkflow } from "../src/workflow.ts";
import type { WorkflowExecution, WorkflowHost, WorkflowRequest } from "../src/workflow.ts";

/**
 * The fixture repository, answered through the Git Api itself.
 *
 * The boundary a definition is read across, substituted at that boundary and
 * nowhere else: the object id and the bytes are the ones `git` reported for a
 * real commit, so nothing about what a definition *is* is faked here.
 */
function useGit(
  repository: string,
  objectId: string,
  contents: string,
  asked: string[] = [],
): Operation<void> {
  return Git.around(
    {
      // deno-lint-ignore require-yield
      *repositoryRoot(): Operation<string> {
        asked.push("repositoryRoot");
        return repository;
      },
      // deno-lint-ignore require-yield
      *objectFormat(): Operation<"sha1" | "sha256"> {
        asked.push("objectFormat");
        return "sha1";
      },
      // deno-lint-ignore require-yield
      *readObject([commit, path]): Operation<string> {
        asked.push(`readObject:${commit}:${path}`);
        if (commit !== objectId) {
          throw new Error(`unexpected commit ${commit}`);
        }
        if (path !== "workflow.md") {
          throw new Error(`unexpected path ${path}`);
        }
        return contents;
      },
      // deno-lint-ignore require-yield
      *revParse([revision]): Operation<string> {
        asked.push(`revParse:${revision}`);
        return objectId;
      },
    },
    { at: "min" },
  );
}

/**
 * Capture what the CLI reports, and put `console.error` back afterwards.
 *
 * A status line is an observable of this lifecycle, so a test that only reads
 * exit codes cannot tell "no status was published" from "a status was published
 * beside an exit 1".
 */
function useReported(lines: string[]): Operation<void> {
  return resource<void>(function* (provide) {
    const written = console.error;
    yield* ensure(() => {
      console.error = written;
    });
    console.error = (...parts: unknown[]) => {
      lines.push(parts.map((part) => String(part)).join(" "));
    };
    yield* provide();
  });
}

/** An isolated run store for one test. */
function useRunStore(): Operation<string> {
  return resource<string>(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-wfi-")));
    yield* ensure(function* () {
      yield* rm(root, { recursive: true, force: true });
    });
    yield* provide(root);
  });
}

/** A host that records every attachment rather than opening a Workspace. */
function recordingHost(root: string, attached: string[]): WorkflowHost {
  return {
    useRunHost(): Operation<WorkflowExecutionTransitions> {
      return useWorkflowRunHost({ root });
    },
    useLifecycle(): Operation<void> {
      return useWorkflowLifecycle({ root });
    },
    useDelivery(): Operation<void> {
      return useWorkflowInputDelivery({ root });
    },
    attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      attached.push(database.record.runId);
      return operation;
    },
  };
}

/**
 * A host whose settlement storage refuses.
 *
 * Substituted at the transitions boundary, which is the one the CLI depends on
 * for lifecycle. Finishing the execution record and publishing the run state
 * are one transaction now, so there is one place a refusal can happen — and one
 * refusal, rather than a dependent write that a refused prerequisite skips.
 */
function refusingHost(root: string, refuse: "settle" | "none", attempted: string[]): WorkflowHost {
  const host = recordingHost(root, []);
  return {
    *useRunHost(): Operation<WorkflowExecutionTransitions> {
      const transitions = yield* host.useRunHost();
      return {
        begin: transitions.begin,
        fork: transitions.fork,
        stageFork: transitions.stageFork,
        *settle(executorLock, completion) {
          attempted.push(`settle:${completion.status}`);
          if (refuse === "settle") {
            return Err(new Error("PLANTED-STORAGE-REFUSAL"));
          }
          return yield* transitions.settle(executorLock, completion);
        },
      };
    },
    useLifecycle: host.useLifecycle,
    useDelivery: host.useDelivery,
    attach: host.attach,
  };
}

/** Record a root terminal, so the next pass over this journal is a replay. */
function* closeRoot(root: string, runId: string): Operation<void> {
  yield* scoped(function* () {
    yield* useWorkflowRunHost({ root });
    const found = yield* WorkflowRunStorage.operations.lookup(runId);
    if (!found.ok) {
      throw found.error;
    }
    yield* found.value.journal.append({
      type: "close",
      coroutineId: "root",
      result: { status: "ok", value: { status: "ok", output: "", value: "" } },
    });
  });
}

/** Put a run into the state a previous invocation would have left it in. */
function* endRun(root: string, runId: string, status: WorkflowRunStatus): Operation<void> {
  yield* scoped(function* () {
    const transitions = yield* useWorkflowRunHost({ root });
    const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
    if (!acquired.ok) {
      throw acquired.error;
    }
    if (acquired.value.kind !== "acquired") {
      throw new Error(`${runId} already has a live workflow executor`);
    }
    const { lock: executorLock } = acquired.value;
    const begun = yield* transitions.begin(executorLock, { runId, action: "resume" });
    if (!begun.ok) {
      throw begun.error;
    }
    const settled = yield* transitions.settle(executorLock, {
      executionId: begun.value.execution.executionId,
      status,
    });
    if (!settled.ok) {
      throw settled.error;
    }
  });
}

/**
 * Everything about a stored run that a refused resume must leave alone.
 *
 * Not a summary, and not the database's bytes either: the complete document
 * execution records and the complete journal *entries* — in order, each with the
 * opaque id storage gave it. A length would not notice a record opened and
 * closed again, and reading events rather than entries would not notice one
 * appended and rewritten under a new id.
 */
function* runSnapshot(root: string, runId: string): Operation<string> {
  return yield* scoped(function* () {
    yield* useWorkflowRunHost({ root });
    const found = yield* WorkflowRunStorage.operations.lookup(runId);
    if (!found.ok) {
      throw found.error;
    }
    const database = found.value;
    const executions = yield* database.readDocumentExecutions();
    if (!executions.ok) {
      throw executions.error;
    }
    const journal = yield* database.readJournalEntries();
    if (!journal.ok) {
      throw journal.error;
    }
    return JSON.stringify({
      status: database.record.status,
      stopReason: database.record.stopReason ?? null,
      updatedAt: database.record.updatedAt,
      props: database.record.props,
      definition: database.record.definition,
      retrieval: database.retrieval ?? null,
      executions: executions.value,
      journal: journal.value,
    });
  });
}

const REQUEST: WorkflowRequest = {
  action: "start",
  target: "workflow.md",
  id: undefined,
  verbose: false,
  raw: false,
  secretDetection: false,
};

describe("Tier WFI — what a run hands to canonical core", () => {
  it("WFI1: a run reaches core as one installation carrying its admission and preparation", function* () {
    const attached: string[] = [];
    const seen: WorkflowExecution[] = [];
    let executions = 0;

    yield* scoped(function* () {
      const root = yield* useRunStore();
      const created = yield* startedRun(root);
      yield* useGit(created.repository, created.objectId, created.contents);
      yield* runWorkflow(
        { ...REQUEST, action: "resume", target: created.runId },
        undefined,
        recordingHost(root, attached),
        function* (execution): Operation<Result<void>> {
          executions += 1;
          seen.push(execution);
          return Ok(undefined);
        },
      );
    });

    // Exactly one execution — not an `executeInstalled()` followed by an
    // `execute()`, and not one per phase.
    expect(executions).toEqual(1);
    const execution = seen[0];
    expect(execution).toBeDefined();
    // Exactly one installation, and it carries both halves of the contract:
    // the mandatory retained-history admission core applies inside its own
    // journal read, and the durable preparation core invokes inside the
    // durable root.
    expect(execution?.installations.length).toEqual(1);
    const installation = execution?.installations[0];
    expect(installation?.admissions?.length).toEqual(1);
    expect(typeof installation?.prepare).toEqual("function");
  });

  it("WFI2: a completed run is given no Workspace to attach", function* () {
    const attached: string[] = [];
    let executions = 0;

    yield* scoped(function* () {
      const root = yield* useRunStore();
      const created = yield* startedRun(root);
      yield* useGit(created.repository, created.objectId, created.contents);
      // First pass: live, so the Workspace is attached.
      yield* runWorkflow(
        { ...REQUEST, action: "resume", target: created.runId },
        undefined,
        recordingHost(root, attached),
        function* (execution): Operation<Result<void>> {
          executions += 1;
          // Close the root, so the next pass is a completed replay.
          yield* execution.stream.append({
            type: "close",
            coroutineId: "root",
            result: { status: "ok", value: { status: "ok", output: "", value: "" } },
          });
          return yield* execution.around(
            (function* (): Operation<Result<void>> {
              return Ok(undefined);
            })(),
          );
        },
      );

      const live = attached.length;
      expect(live).toEqual(1);

      // Second pass over the same journal: nothing left to give a filesystem to.
      yield* runWorkflow(
        { ...REQUEST, action: "resume", target: created.runId },
        undefined,
        recordingHost(root, attached),
        function* (execution): Operation<Result<void>> {
          executions += 1;
          return yield* execution.around(
            (function* (): Operation<Result<void>> {
              return Ok(undefined);
            })(),
          );
        },
      );
    });

    expect(executions).toEqual(2);
    // The completed pass attached nothing.
    expect(attached.length).toEqual(1);
  });

  it("WFI3: a failed or cancelled run is refused before anything is opened", function* () {
    for (const terminal of ["failed", "cancelled"] as const) {
      const attached: string[] = [];
      const asked: string[] = [];
      const reported: string[] = [];
      let executions = 0;

      const outcome = yield* scoped(function* () {
        const root = yield* useRunStore();
        const created = yield* startedRun(root);
        yield* useGit(created.repository, created.objectId, created.contents, asked);
        yield* endRun(root, created.runId, terminal);
        yield* useReported(reported);
        const before = yield* runSnapshot(root, created.runId);
        // Everything the fixture itself asked of Git is behind us.
        asked.length = 0;

        const result = yield* runWorkflow(
          { ...REQUEST, action: "resume", target: created.runId },
          undefined,
          recordingHost(root, attached),
          // deno-lint-ignore require-yield
          function* (): Operation<Result<void>> {
            executions += 1;
            return Ok(undefined);
          },
        );
        const after = yield* runSnapshot(root, created.runId);
        return { result, before, after };
      });

      expect(outcome.result.exitCode).toEqual(1);
      // Nothing was fetched, attached or run — the definition in particular was
      // never read out of Git.
      expect(asked).toEqual([]);
      expect(attached).toEqual([]);
      expect(executions).toEqual(0);
      // No status was published for a run whose status did not change.
      expect(reported.some((line) => line.includes("workflow status:"))).toBe(false);
      expect(reported.some((line) => line.includes(terminal))).toBe(true);
      // Structurally unchanged: the same status, stop reason, definition,
      // props and retrieval metadata, the same execution records, and the same
      // journal entries under the same ids in the same order.
      expect(outcome.after).toEqual(outcome.before);
    }
  });

  it("WFI4: completed and interrupted runs are still admitted", function* () {
    const outcomes: Array<{ status: string; executions: number; attached: number }> = [];

    for (const admitted of ["completed", "interrupted"] as const) {
      const attached: string[] = [];
      let executions = 0;

      yield* scoped(function* () {
        const root = yield* useRunStore();
        const created = yield* startedRun(root);
        yield* useGit(created.repository, created.objectId, created.contents);
        if (admitted === "completed") {
          yield* closeRoot(root, created.runId);
        }
        yield* endRun(root, created.runId, admitted);
        yield* runWorkflow(
          { ...REQUEST, action: "resume", target: created.runId },
          undefined,
          recordingHost(root, attached),
          function* (execution): Operation<Result<void>> {
            executions += 1;
            // The shared CLI wraps its document work in this; a completed run
            // is what decides there is nothing to wrap it with.
            return yield* execution.around(
              (function* (): Operation<Result<void>> {
                return Ok(undefined);
              })(),
            );
          },
        );
      });

      outcomes.push({ status: admitted, executions, attached: attached.length });
    }

    // Both reached the executor; only the completed one was spared a Workspace.
    expect(outcomes).toEqual([
      { status: "completed", executions: 1, attached: 0 },
      { status: "interrupted", executions: 1, attached: 1 },
    ]);
  });

  it("WFI5: a lifecycle write storage refused is never published as a status", function* () {
    // One transition, so one refusal. Finishing the record and publishing the
    // status can no longer fail independently — which is the point of settling
    // them together.
    const faults: Array<{ refuse: "settle"; attempts: string[] }> = [
      { refuse: "settle", attempts: ["settle:completed"] },
    ];

    for (const fault of faults) {
      const attempted: string[] = [];
      const reported: string[] = [];

      const outcome = yield* scoped(function* () {
        const root = yield* useRunStore();
        const created = yield* startedRun(root);
        yield* useGit(created.repository, created.objectId, created.contents);
        yield* useReported(reported);
        return yield* runWorkflow(
          { ...REQUEST, action: "resume", target: created.runId },
          undefined,
          refusingHost(root, fault.refuse, attempted),
          // deno-lint-ignore require-yield
          function* (): Operation<Result<void>> {
            return Ok(undefined);
          },
        );
      });

      // A refusal is this invocation's failure, not a status.
      expect(outcome.exitCode).toEqual(1);
      expect(reported.some((line) => line.includes("workflow status:"))).toBe(false);
      // The planted refusal is what the caller is told about.
      expect(reported.some((line) => line.includes("PLANTED-STORAGE-REFUSAL"))).toBe(true);
      // A refused prerequisite is not followed by its dependent write, and
      // nothing relabelled the run interrupted on the way out.
      expect(attempted).toEqual(fault.attempts);
    }
  });

  it("WFI6: an interruption storage refusal is never published as a status", function* () {
    const faults: Array<{ refuse: "settle"; attempts: string[] }> = [
      { refuse: "settle", attempts: ["settle:interrupted"] },
    ];

    for (const fault of faults) {
      const attempted: string[] = [];
      const reported: string[] = [];
      const running = withResolvers<void>();

      yield* scoped(function* () {
        const root = yield* useRunStore();
        const created = yield* startedRun(root);
        yield* useGit(created.repository, created.objectId, created.contents);
        yield* useReported(reported);

        const invocation = yield* spawn(() =>
          runWorkflow(
            { ...REQUEST, action: "resume", target: created.runId },
            undefined,
            refusingHost(root, fault.refuse, attempted),
            function* (): Operation<Result<void>> {
              // The document is live and the interruption finalizer is
              // registered: halting now is a real interruption rather than a
              // race against a delay.
              running.resolve();
              yield* suspend();
              return Ok(undefined);
            },
          ),
        );

        yield* running.operation;
        // Teardown runs to completion before this returns.
        yield* invocation.halt();
      });

      // The finalizer attempted exactly what it was allowed to, in order.
      expect(attempted).toEqual(fault.attempts);
      // And claimed nothing storage refused.
      expect(reported.some((line) => line.includes("workflow status: interrupted"))).toBe(false);
      expect(reported.some((line) => line.includes("PLANTED-STORAGE-REFUSAL"))).toBe(true);
    }
  });

  it("WFI7: an interruption that was retained keeps the ordinary outcome", function* () {
    const attempted: string[] = [];
    const reported: string[] = [];
    const running = withResolvers<void>();

    yield* scoped(function* () {
      const root = yield* useRunStore();
      const created = yield* startedRun(root);
      yield* useGit(created.repository, created.objectId, created.contents);
      yield* useReported(reported);

      const invocation = yield* spawn(() =>
        runWorkflow(
          { ...REQUEST, action: "resume", target: created.runId },
          undefined,
          // Storage refuses nothing here.
          refusingHost(root, "none", attempted),
          function* (): Operation<Result<void>> {
            running.resolve();
            yield* suspend();
            return Ok(undefined);
          },
        ),
      );

      yield* running.operation;
      yield* invocation.halt();
    });

    // Both writes landed, so the status this run publishes is one storage
    // accepted.
    // One transition: the record and the status it implies commit together.
    expect(attempted).toEqual(["settle:interrupted"]);
    expect(reported.some((line) => line.includes("workflow status: interrupted"))).toBe(true);
  });
});

/**
 * A real repository with one committed document, and a run that retains it.
 *
 * The definition a resume loads is committed Git bytes, so nothing here can be
 * faked: the object id is the one `git` reports, and the retrieval metadata
 * names the checkout the resume reads it back through.
 */
function* startedRun(root: string): Operation<Started> {
  const repository = yield* until(mkdtemp(join(tmpdir(), "xmd-wfi-repo-")));
  yield* ensure(function* () {
    yield* rm(repository, { recursive: true, force: true });
  });

  yield* git(repository, ["init", "--quiet"]);
  yield* git(repository, ["config", "user.email", "wfi@example.test"]);
  yield* git(repository, ["config", "user.name", "WFI"]);
  yield* writeTextFile(join(repository, "workflow.md"), "recorded\n");
  yield* git(repository, ["add", "workflow.md"]);
  // The fixture is not the developer's repository: whatever signing their own
  // configuration asks for is not this commit's business.
  yield* git(repository, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "definition"]);
  const contents = "recorded\n";
  const objectId = (yield* git(repository, ["rev-parse", "HEAD:workflow.md"])).trim();
  const objectFormat = (yield* git(repository, ["rev-parse", "--show-object-format"])).trim();

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
          objectFormat: objectFormat === "sha256" ? "sha256" : "sha1",
          objectId,
          rootDocumentPath: "workflow.md",
        },
        props: {},
        retrieval: { kind: "local-checkout", checkout: repository },
      },
    });
    if (!begun.ok) {
      throw begun.error;
    }
    return { runId, repository, objectId, contents };
  });
}

/** A created run, and everything the Git boundary must answer for it. */
interface Started {
  readonly runId: string;
  readonly repository: string;
  readonly objectId: string;
  readonly contents: string;
}

/** One `git` invocation in `repository`, answering with its stdout. */
function* git(repository: string, args: string[]): Operation<string> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}
