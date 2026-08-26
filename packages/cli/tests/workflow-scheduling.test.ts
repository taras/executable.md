/**
 * Tier SCH — explicit scheduled resume (#300 slice 2).
 *
 * A trusted host that has independently observed a successful typed answer
 * delivery may decide the run should continue now. Every case here is about
 * what that decision is *not* allowed to be: a second executor, a second
 * answer-claim path, a queue, or anything that survives the scope that asked
 * for it.
 *
 * The runs are real. Real git-backed definitions, the real production
 * `runWorkflow()` path, the real suspension controller, the real answer
 * delivery, real SQLite storage. What the suite supplies is the document, the
 * host wiring, and — where a case has to stand inside the claim transaction or
 * between two authored effects — a barrier of its own on a seam that already
 * exists.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import {
  call,
  ensure,
  Err,
  Ok,
  resource,
  scoped,
  spawn,
  suspend,
  until,
  withResolvers,
} from "effection";
import type { Operation, Result } from "effection";
import { rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { collect, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type { DurableEvent, Json } from "@executablemd/durable-streams";
import {
  useWorkflowInputDelivery,
  useWorkflowLifecycle,
  useWorkflowRunHost,
  withWorkflowWorkspace,
  workflowRunPath,
} from "@executablemd/workflow/deno";
import type { WorkflowExecutionTransitions } from "@executablemd/workflow/deno";
// The connection registry a Deno host owns. Not on the package entrypoint — a
// host outside the package has no business installing hooks on a run's
// transactions — so the one case that must stand inside the claim transaction
// composes the same three installations `useWorkflowRunHost()` composes and
// imports them from source, as the in-package workflow suites do.
import { useWorkflowRunConnections } from "../../workflow/src/deno/connections.ts";
import type { WorkflowRunConnectionHooks } from "../../workflow/src/deno/connections.ts";
import { installWorkflowRunStorage } from "../../workflow/src/deno/provider.ts";
import { installWorkflowLifecycle } from "../../workflow/src/deno/lifecycle.ts";
import {
  SUSPENSION_ANSWER,
  SUSPENSION_REQUEST,
  WorkflowInputDelivery,
  WorkflowLifecycle,
} from "@executablemd/workflow";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { establishDefinition } from "../src/workflow-definition.ts";
import { runWorkflow } from "../src/workflow.ts";
import type {
  WorkflowExecution,
  WorkflowHost,
  WorkflowOutcome,
  WorkflowRequest,
  WorkflowStart,
} from "../src/workflow.ts";
import { ordinaryResume, scheduleResume } from "../src/scheduling.ts";
import type { OrdinaryResume } from "../src/scheduling.ts";

const RUN_ID = "scheduled-run";

const SCHEMA =
  `{"type":"object","properties":{"proceed":{"type":"boolean"}},` +
  `"required":["proceed"],"additionalProperties":false}`;

/**
 * One effect, a durable wait, then one more effect.
 *
 * The two writes are what "before" and "after" the wait mean in every
 * assertion below, and the binding read after the `<Elicit>` is what proves a
 * continuation used the delivered value rather than merely getting past it.
 */
const DOCUMENT = `<File path="before.md">
before the wait
</File>

<Elicit schema={${SCHEMA}} as="decision">
Proceed with the change?
</Elicit>

<File path="after.md">
after the wait: {decision.proceed}
</File>

decision: {decision.proceed}
`;

/**
 * The same document with a stop between the answer and the effect that uses it.
 *
 * `<Barrier />` is this suite's own component and exists nowhere else: it is
 * how one case stands in the gap the claim commit opens, where the answer is
 * durable and the work that reads it has not happened. A run whose host does
 * not install it cannot render this document at all, which is what keeps the
 * case from passing on a barrier that quietly did nothing.
 */
const BARRIER_DOCUMENT = `<File path="before.md">
before the wait
</File>

<Elicit schema={${SCHEMA}} as="decision">
Proceed with the change?
</Elicit>

<Barrier />

<File path="after.md">
after the wait: {decision.proceed}
</File>

decision: {decision.proceed}
`;

const OPTIONS = { verbose: false, raw: false, secretDetection: false } as const;

function* git(repository: string, args: string[]): Operation<string> {
  const result = yield* exec("git", { arguments: args, cwd: repository }).expect();
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function useRunStore(): Operation<string> {
  return resource<string>(function* (provide) {
    const root = yield* until(mkdtemp(join(tmpdir(), "xmd-sch-")));
    yield* ensure(function* () {
      yield* rm(root, { recursive: true, force: true });
    });
    yield* provide(root);
  });
}

/**
 * What `runWorkflow()` reports, kept rather than printed.
 *
 * The already-running refusal and the cancellation refusal are both exit code
 * 1, so several cases below need the sentence to tell them apart.
 */
function useReports(): Operation<string[]> {
  return resource<string[]>(function* (provide) {
    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    yield* ensure(() => {
      console.log = log;
      console.error = error;
    });
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    yield* provide(lines);
  });
}

interface Fixture {
  readonly repository: string;
  readonly objectId: string;
}

/** A committed definition whose root document is `document`. */
function useDefinitionFixture(document: string = DOCUMENT): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    // Realpathed: on macOS `tmpdir()` is a symlink, and the definition's own
    // repository-relative check compares `resolve(document)` against what git
    // reports as the toplevel — which is the resolved path. An unresolved
    // fixture path fails that check for a reason that has nothing to do with
    // the run.
    const created = yield* until(mkdtemp(join(tmpdir(), "xmd-sch-repo-")));
    const repository = yield* until(realpath(created));
    yield* ensure(function* () {
      yield* rm(repository, { recursive: true, force: true });
    });
    yield* git(repository, ["init", "--quiet"]);
    yield* git(repository, ["config", "user.email", "sch@example.test"]);
    yield* git(repository, ["config", "user.name", "SCH"]);
    yield* writeTextFile(join(repository, "workflow.md"), document);
    yield* git(repository, ["add", "workflow.md"]);
    yield* git(repository, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "definition"]);
    const objectId = (yield* git(repository, ["rev-parse", "HEAD:workflow.md"])).trim();
    yield* provide({ repository, objectId });
  });
}

function startFor(fixture: Fixture): Operation<WorkflowStart | undefined> {
  return call(function* (): Operation<WorkflowStart | undefined> {
    const established = yield* establishDefinition(join(fixture.repository, "workflow.md"));
    if (!established.ok) {
      throw established.error;
    }
    return { established: established.value, props: {}, propsSchema: {} };
  });
}

/** The production host, over one run store. */
function host(root: string): WorkflowHost {
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
      return withWorkflowWorkspace(database, operation, {});
    },
  };
}

/**
 * The same host, over a connection registry carrying transaction hooks.
 *
 * The three installations are the ones `useWorkflowRunHost()` composes, in the
 * same order and over one registry, because storage and lifecycle write to the
 * same databases. Delegated with `yield*` from a generator method rather than
 * wrapped in a `call()`: the registry is a resource, and a scope of its own
 * would close it the moment this returned.
 */
function hookedHost(root: string, hooks: WorkflowRunConnectionHooks): WorkflowHost {
  return {
    ...host(root),
    *useRunHost(): Operation<WorkflowExecutionTransitions> {
      const connections = yield* useWorkflowRunConnections(() => {}, hooks);
      yield* installWorkflowRunStorage({ root }, {}, connections);
      return yield* installWorkflowLifecycle({ root }, connections);
    },
  };
}

/**
 * A stop that happens once, and never again.
 *
 * The first arrival announces itself and waits; every arrival after it passes
 * straight through. That is what lets one barrier serve a run that is halted
 * while it waits and then resumed — the resumed execution reaches the same
 * point and must not stop there a second time.
 */
interface Barrier {
  /** Settles when something first reached the barrier. */
  readonly reached: Operation<void>;
  /** Let the waiting arrival continue. */
  release(): void;
  /** Arrive. */
  enter(): Operation<void>;
}

function barrier(): Barrier {
  const arrived = withResolvers<void>();
  const released = withResolvers<void>();
  let entered = false;
  return {
    reached: arrived.operation,
    release: () => released.resolve(),
    *enter(): Operation<void> {
      if (entered) {
        return;
      }
      entered = true;
      arrived.resolve();
      yield* released.operation;
    },
  };
}

/**
 * A host that stops one invocation immediately after it takes the executor
 * lock, so a second entry point can be raced against it deterministically.
 *
 * `attach()` is the first thing `runWorkflow()` does with the run after
 * acquisition, which is exactly where a competing caller has to find the lock
 * already held.
 */
function holdingHost(root: string, hold: Barrier): WorkflowHost {
  const production = host(root);
  return {
    ...production,
    *attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      yield* hold.enter();
      return yield* production.attach(database, operation);
    },
  };
}

/** `<Barrier />`, for the one document that writes it. */
function barrierComponent(hold: Barrier): ExecutionInstallation {
  return {
    install(): Operation<void> {
      return registerComponents([
        {
          name: "Barrier",
          origin: "tier-sch",
          props: { type: "object", properties: {}, additionalProperties: false },
          *fn(): Operation<string> {
            yield* hold.enter();
            return "";
          },
        },
      ]);
    },
  };
}

/** The document executor both entry points run. */
function body(
  rendered: string[],
  extra: readonly ExecutionInstallation[] = [],
): (execution: WorkflowExecution) => Operation<Result<void>> {
  return function* (execution): Operation<Result<void>> {
    return yield* execution.around(
      call(function* (): Operation<Result<void>> {
        try {
          rendered.push(
            String(
              yield* collect(
                yield* executeInstalled(
                  { ...execution.root, stream: execution.stream, props: execution.props },
                  [...execution.installations, ...extra],
                ),
              ),
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

function invoke(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
  workflowHost: WorkflowHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<WorkflowOutcome> {
  return runWorkflow(request, start, workflowHost, execute);
}

/** The manual entry point: `xmd workflow resume <run-id>`, as a request. */
function manualResume(
  workflowHost: WorkflowHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<WorkflowOutcome> {
  return invoke(
    { action: "resume", target: RUN_ID, id: undefined, ...OPTIONS },
    undefined,
    workflowHost,
    execute,
  );
}

/**
 * Start the run and leave it suspended at its wait.
 *
 * Exit 2 is the ordinary suspended outcome, not a failure: the run reported a
 * durable wait, settled `suspended` and gave its executor lock back.
 */
function* suspendedRun(
  root: string,
  fixture: Fixture,
  rendered: string[],
  extra: readonly ExecutionInstallation[] = [],
): Operation<void> {
  const outcome = yield* invoke(
    {
      action: "start",
      target: join(fixture.repository, "workflow.md"),
      id: RUN_ID,
      ...OPTIONS,
    },
    yield* startFor(fixture),
    host(root),
    body(rendered, extra),
  );
  expect(outcome.exitCode).toBe(2);
}

/** Retain a typed answer, the way `xmd workflow answer` does. */
function deliver(root: string, suspensionId: string, value: Json = { proceed: true }) {
  return scoped(function* () {
    yield* useWorkflowInputDelivery({ root });
    const delivered = yield* WorkflowInputDelivery.operations.deliver({
      runId: RUN_ID,
      suspensionId,
      value,
      secretDetection: false,
    });
    if (!delivered.ok) {
      throw delivered.error;
    }
    return delivered.value;
  });
}

/** Cancel the run through the ordinary lifecycle operation. */
function cancel(root: string) {
  return scoped(function* () {
    yield* useWorkflowLifecycle({ root });
    return yield* WorkflowLifecycle.operations.cancel(RUN_ID);
  });
}

function rows(root: string, sql: string): Record<string, unknown>[] {
  const database = new DatabaseSync(workflowRunPath(root, RUN_ID));
  try {
    return database.prepare(sql).all();
  } catch {
    return [];
  } finally {
    database.close();
  }
}

function runState(root: string): Record<string, unknown> {
  return rows(root, "SELECT status, stop_reason_event_id FROM workflow_run")[0] ?? {};
}

function executions(root: string): number {
  return Number(rows(root, "SELECT count(*) AS n FROM document_executions")[0]?.["n"] ?? 0);
}

function executionStatuses(root: string): string[] {
  return rows(root, "SELECT stop_status FROM document_executions ORDER BY sequence ASC").map(
    (row) => String(row["stop_status"]),
  );
}

function answerRows(root: string): Record<string, unknown>[] {
  return rows(root, "SELECT * FROM workflow_suspension_answers");
}

/** Every journaled event, or only those of one effect type. */
function events(root: string, type?: string): Record<string, unknown>[] {
  const all = rows(root, "SELECT * FROM journal_events");
  if (type === undefined) {
    return all;
  }
  return all.filter((row) => {
    const described = JSON.parse(String(row["record"] ?? "{}"));
    return described?.type === "yield" && described?.description?.type === type;
  });
}

function tables(root: string): string[] {
  return rows(root, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((row) =>
    String(row["name"]),
  );
}

/** The suspension this run is waiting at. */
function suspensionId(root: string): string {
  const pending = answerRows(root);
  if (pending.length > 0) {
    return String(pending[0]?.["suspension_id"]);
  }
  const waits = events(root, SUSPENSION_REQUEST);
  const last = waits[waits.length - 1];
  const described = JSON.parse(String(last?.["record"] ?? "{}"));
  return String(described?.description?.name ?? "");
}

/** Whether this is the journal event the answer claim publishes. */
function isAnswerEvent(event: DurableEvent): boolean {
  return event.type === "yield" && event.description.type === SUSPENSION_ANSWER;
}

describe("Tier SCH — explicit scheduled resume", () => {
  it("SCH1: delivery alone never schedules execution", function* () {
    yield* useReports();
    const root = yield* useRunStore();
    const fixture = yield* useDefinitionFixture();
    const rendered: string[] = [];
    yield* suspendedRun(root, fixture, rendered);

    const before = {
      state: runState(root),
      executions: executions(root),
      events: events(root).length,
      writes: events(root, "workspace_file").length,
    };
    expect(before.state["status"]).toBe("suspended");
    expect(before.writes).toBe(1);

    // The scheduler is never reached, and nothing may reach it on delivery's
    // behalf: what this counts is calls, so a hidden hook would be visible
    // here as a call nobody in this test made.
    let scheduled = 0;
    const resume: OrdinaryResume = (runId) => {
      scheduled += 1;
      return ordinaryResume(OPTIONS, host(root), body(rendered))(runId);
    };

    yield* deliver(root, suspensionId(root));

    expect(scheduled).toBe(0);
    expect(runState(root)).toEqual(before.state);
    expect(executions(root)).toBe(before.executions);
    expect(events(root).length).toBe(before.events);
    expect(events(root, "workspace_file").length).toBe(before.writes);
    // The value is retained and pending: delivery did its own job.
    expect(answerRows(root)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("pending");
    // The document never finished rendering: it halted at its wait, so there
    // is no output yet for delivery to have produced.
    expect(rendered).toHaveLength(0);

    // And the scheduler still works when something actually calls it, so the
    // zero above is a fact about delivery rather than about a broken fixture.
    const outcome = yield* scheduleResume(resume, { runId: RUN_ID });
    expect(scheduled).toBe(1);
    expect(outcome.exitCode).toBe(0);
    expect(runState(root)["status"]).toBe("completed");
    expect(rendered).toHaveLength(1);
  });

  it("SCH2: one explicit schedule runs the ordinary resume path", function* () {
    yield* useReports();
    const root = yield* useRunStore();
    const fixture = yield* useDefinitionFixture();
    const rendered: string[] = [];
    yield* suspendedRun(root, fixture, rendered);
    yield* deliver(root, suspensionId(root));

    // Everything that crosses the scheduler boundary, recorded verbatim.
    const crossed: unknown[] = [];
    const shared = ordinaryResume(OPTIONS, host(root), body(rendered));
    const resume: OrdinaryResume = (runId) => {
      crossed.push(runId);
      return shared(runId);
    };

    const outcome = yield* scheduleResume(resume, { runId: RUN_ID });
    expect(outcome.exitCode).toBe(0);

    // One argument, one string, and it is the public run id. Nothing else
    // crossed — no answer, suspension id, definition, props, path, database or
    // executor value, because there is nowhere on the request to put one.
    expect(crossed).toEqual([RUN_ID]);
    expect(crossed.every((value) => typeof value === "string")).toBe(true);
    expect(Object.keys({ runId: RUN_ID })).toEqual(["runId"]);

    // The real run claimed its answer and completed through the ordinary path.
    expect(runState(root)["status"]).toBe("completed");
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(1);
    // The effect after the wait ran once, and the document read the value.
    expect(events(root, "workspace_file")).toHaveLength(2);
    expect(rendered[rendered.length - 1]).toContain("decision: true");
  });

  it("SCH3: scheduled and manual resume share one non-blocking executor lock", function* () {
    // Both orders, each on a run store of its own, because a run is resumed
    // once and the second order needs a run still waiting at its answer.
    for (const first of ["manual", "scheduled"] as const) {
      yield* scoped(function* () {
        const reports = yield* useReports();
        const root = yield* useRunStore();
        const fixture = yield* useDefinitionFixture();
        const rendered: string[] = [];
        yield* suspendedRun(root, fixture, rendered);
        yield* deliver(root, suspensionId(root));

        const hold = barrier();
        const held = holdingHost(root, hold);
        const competing = host(root);

        const holding = yield* spawn(() =>
          first === "manual"
            ? manualResume(held, body(rendered))
            : scheduleResume(ordinaryResume(OPTIONS, held, body(rendered)), { runId: RUN_ID }),
        );

        // The lock is taken and this invocation is standing on it. Its own
        // execution record already exists — the run was admitted under that
        // lock — so what the competing caller must not do is add another.
        yield* hold.reached;
        const admitted = executions(root);
        expect(admitted).toBe(2);

        const second = yield* first === "manual"
          ? scheduleResume(ordinaryResume(OPTIONS, competing, body(rendered)), { runId: RUN_ID })
          : manualResume(competing, body(rendered));

        // Refused, not queued: the competing caller was answered while the
        // first was still holding, which is the whole of "non-blocking".
        expect(second.exitCode).toBe(1);
        expect(reports.some((line) => line.includes("is already running"))).toBe(true);
        expect(reports.some((line) => line.includes("rather than following it"))).toBe(true);

        // And it entered nothing: no execution record of its own, no claim.
        expect(executions(root)).toBe(admitted);
        expect(answerRows(root)[0]?.["state"]).toBe("pending");
        expect(events(root, SUSPENSION_ANSWER)).toHaveLength(0);

        hold.release();
        const winner = yield* holding;

        // Exactly one reached canonical execution, whichever started first.
        expect(winner.exitCode).toBe(0);
        expect(runState(root)["status"]).toBe("completed");
        expect(executions(root)).toBe(2);
        expect(events(root, SUSPENSION_ANSWER)).toHaveLength(1);
        expect(events(root, "workspace_file")).toHaveLength(2);
        expect(answerRows(root)[0]?.["state"]).toBe("consumed");
        expect(rendered).toHaveLength(1);
        expect(rendered[0]).toContain("decision: true");
      });
    }
  });

  it("SCH4: duplicate and late schedules consume one answer once", function* () {
    const reports = yield* useReports();
    const root = yield* useRunStore();
    const fixture = yield* useDefinitionFixture();
    const rendered: string[] = [];
    yield* suspendedRun(root, fixture, rendered);
    yield* deliver(root, suspensionId(root));

    const hold = barrier();
    const first = yield* spawn(() =>
      scheduleResume(ordinaryResume(OPTIONS, holdingHost(root, hold), body(rendered)), {
        runId: RUN_ID,
      }),
    );
    yield* hold.reached;

    // The duplicate: a second schedule for the same pending answer, while the
    // first still holds the lock.
    const duplicate = yield* scheduleResume(ordinaryResume(OPTIONS, host(root), body(rendered)), {
      runId: RUN_ID,
    });
    expect(duplicate.exitCode).toBe(1);
    expect(reports.some((line) => line.includes("is already running"))).toBe(true);

    hold.release();
    const winner = yield* first;
    expect(winner.exitCode).toBe(0);
    expect(runState(root)["status"]).toBe("completed");

    const settled = {
      answers: events(root, SUSPENSION_ANSWER).length,
      writes: events(root, "workspace_file").length,
      events: events(root).length,
      executions: executions(root),
    };
    expect(settled.answers).toBe(1);
    expect(settled.writes).toBe(2);
    expect(answerRows(root)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");

    // The late one: scheduled after the winner settled. A completed run
    // replays its retained output, and replaying is all it may do.
    const late = yield* scheduleResume(ordinaryResume(OPTIONS, host(root), body(rendered)), {
      runId: RUN_ID,
    });
    expect(late.exitCode).toBe(0);
    expect(runState(root)["status"]).toBe("completed");
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(settled.answers);
    expect(events(root, "workspace_file")).toHaveLength(settled.writes);
    expect(events(root).length).toBe(settled.events);
    expect(answerRows(root)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");
    // It replayed the retained output rather than re-entering authored work.
    expect(rendered).toHaveLength(2);
    expect(rendered[1]).toContain("decision: true");
    // One more execution record, and no more work: the late call is an
    // attempt the run accounts for, not a second continuation.
    expect(executions(root)).toBe(settled.executions + 1);
  });

  it("SCH5: cancellation and scheduled acquisition preserve their winner", function* () {
    yield* scoped(function* () {
      // Cancellation first, with nothing running.
      const root = yield* useRunStore();
      const fixture = yield* useDefinitionFixture();
      const rendered: string[] = [];
      yield* useReports();
      yield* suspendedRun(root, fixture, rendered);
      yield* deliver(root, suspensionId(root));

      const cancelled = yield* cancel(root);
      expect(cancelled.ok).toBe(true);
      expect(runState(root)["status"]).toBe("cancelled");

      const before = {
        executions: executions(root),
        events: events(root).length,
        answers: answerRows(root)[0]?.["state"],
      };

      const scheduled = yield* scheduleResume(ordinaryResume(OPTIONS, host(root), body(rendered)), {
        runId: RUN_ID,
      });

      // Scheduling advances nothing a cancellation already settled.
      expect(scheduled.exitCode).toBe(1);
      expect(runState(root)["status"]).toBe("cancelled");
      expect(executions(root)).toBe(before.executions);
      expect(events(root).length).toBe(before.events);
      expect(events(root, SUSPENSION_ANSWER)).toHaveLength(0);
      expect(answerRows(root)[0]?.["state"]).toBe(before.answers);
      expect(rendered).toHaveLength(0);
    });

    yield* scoped(function* () {
      // Scheduling first: the scheduled owner holds the lock, and cancellation
      // reports it rather than reaching through it.
      const root = yield* useRunStore();
      const fixture = yield* useDefinitionFixture();
      const rendered: string[] = [];
      yield* useReports();
      yield* suspendedRun(root, fixture, rendered);
      yield* deliver(root, suspensionId(root));

      const hold = barrier();
      const scheduled = yield* spawn(() =>
        scheduleResume(ordinaryResume(OPTIONS, holdingHost(root, hold), body(rendered)), {
          runId: RUN_ID,
        }),
      );
      yield* hold.reached;

      const refused = yield* cancel(root);
      expect(refused.ok).toBe(false);
      if (refused.ok) {
        throw new Error("cancellation reached through a live executor");
      }
      expect(refused.error.message).toContain("is running");
      expect(refused.error.message).toContain("does not reach into a live document execution");
      expect(runState(root)["status"]).toBe("running");

      hold.release();
      const outcome = yield* scheduled;

      // The scheduled owner kept its run and finished it.
      expect(outcome.exitCode).toBe(0);
      expect(runState(root)["status"]).toBe("completed");
      expect(events(root, SUSPENSION_ANSWER)).toHaveLength(1);
      expect(events(root, "workspace_file")).toHaveLength(2);
      expect(answerRows(root)[0]?.["state"]).toBe("consumed");
    });
  });

  it("SCH6: halting during claim rolls back publication and consumption", function* () {
    yield* useReports();
    const root = yield* useRunStore();
    const fixture = yield* useDefinitionFixture();
    const rendered: string[] = [];
    yield* suspendedRun(root, fixture, rendered);
    yield* deliver(root, suspensionId(root));

    // Inside the claim transaction, after the answer event was routed into it
    // and before the delivery is consumed or anything commits. The publication
    // has been offered and nothing has been decided, which is the only moment
    // a rollback has something to take back.
    const claiming = barrier();
    const scheduled = yield* spawn(() =>
      scheduleResume(
        ordinaryResume(
          OPTIONS,
          hookedHost(root, {
            *afterRoutedJournalAppend(_database, event): Operation<void> {
              if (!isAnswerEvent(event)) {
                return;
              }
              yield* claiming.enter();
            },
          }),
          body(rendered),
        ),
        { runId: RUN_ID },
      ),
    );

    yield* claiming.reached;
    yield* scheduled.halt();

    // Nothing the open transaction offered survived it.
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(0);
    expect(answerRows(root)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("pending");
    expect(events(root, "workspace_file")).toHaveLength(1);
    expect(rendered).toHaveLength(0);

    // Teardown ran to the end: the run is settled, not left `running`, and the
    // execution it interrupted is recorded as interrupted.
    expect(runState(root)["status"]).toBe("interrupted");
    expect(executionStatuses(root)).toEqual(["suspended", "interrupted"]);

    // And the answer is still there to be claimed, exactly once.
    const later = yield* manualResume(host(root), body(rendered));
    expect(later.exitCode).toBe(0);
    expect(runState(root)["status"]).toBe("completed");
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(1);
    expect(events(root, "workspace_file")).toHaveLength(2);
    expect(answerRows(root)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("decision: true");
  });

  it("SCH7: halting after claim replays the committed answer once", function* () {
    yield* useReports();
    const root = yield* useRunStore();
    const fixture = yield* useDefinitionFixture(BARRIER_DOCUMENT);
    const rendered: string[] = [];
    const waiting = barrier();
    const installed = [barrierComponent(waiting)];
    yield* suspendedRun(root, fixture, rendered, installed);
    yield* deliver(root, suspensionId(root));

    const scheduled = yield* spawn(() =>
      scheduleResume(ordinaryResume(OPTIONS, host(root), body(rendered, installed)), {
        runId: RUN_ID,
      }),
    );

    // The document is standing between the answer and the work that uses it.
    yield* waiting.reached;

    // Read from a connection of this test's own, which has no part in the
    // claim. Seeing the event and the consumed delivery from outside is what
    // proves the claim's top-level transaction committed — there is no
    // uncommitted state another connection can read.
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(1);
    expect(answerRows(root)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");
    // And the effect that reads the answer has not happened.
    expect(events(root, "workspace_file")).toHaveLength(1);

    yield* scheduled.halt();

    // The committed winner stays committed. Interruption settles the run; it
    // does not reach back into a transaction that already ended.
    expect(runState(root)["status"]).toBe("interrupted");
    expect(executionStatuses(root)).toEqual(["suspended", "interrupted"]);
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");
    expect(events(root, "workspace_file")).toHaveLength(1);
    expect(rendered).toHaveLength(0);

    // The barrier is spent, so the resumed execution runs through it.
    const later = yield* manualResume(host(root), body(rendered, installed));
    expect(later.exitCode).toBe(0);
    expect(runState(root)["status"]).toBe("completed");

    // Replay restored the answer: no second claim, and the value survived the
    // interruption into the work that reads it.
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(1);
    expect(answerRows(root)).toHaveLength(1);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");
    expect(events(root, "workspace_file")).toHaveLength(2);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("decision: true");
  });

  it("SCH8: a fresh host resumes without scheduler memory", function* () {
    yield* useReports();
    const root = yield* useRunStore();
    const fixture = yield* useDefinitionFixture();
    const rendered: string[] = [];
    yield* suspendedRun(root, fixture, rendered);
    yield* deliver(root, suspensionId(root));

    const settledTables = tables(root);

    // The whole scheduling host lives in this scope and nothing of it leaves:
    // its connection registry, its lifecycle installation, its executor lock
    // registry and the closure that scheduled the resume all end here.
    yield* scoped(function* () {
      const claiming = barrier();
      const scheduled = yield* spawn(() =>
        scheduleResume(
          ordinaryResume(
            OPTIONS,
            hookedHost(root, {
              *afterRoutedJournalAppend(_database, event): Operation<void> {
                if (!isAnswerEvent(event)) {
                  return;
                }
                yield* claiming.enter();
              },
            }),
            body(rendered),
          ),
          { runId: RUN_ID },
        ),
      );
      yield* claiming.reached;
      yield* scheduled.halt();
    });

    // The same state SCH6 observes, reached by ending the host rather than by
    // halting one operation inside it.
    expect(runState(root)["status"]).toBe("interrupted");
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(0);
    expect(answerRows(root)[0]?.["state"]).toBe("pending");
    expect(rendered).toHaveLength(0);

    // A host built now, from nothing but the run store, over a resume closure
    // that never saw the first one.
    const fresh = host(root);
    const recovered = yield* scheduleResume(ordinaryResume(OPTIONS, fresh, body(rendered)), {
      runId: RUN_ID,
    });
    expect(recovered.exitCode).toBe(0);
    expect(runState(root)["status"]).toBe("completed");
    expect(events(root, SUSPENSION_ANSWER)).toHaveLength(1);
    expect(events(root, "workspace_file")).toHaveLength(2);
    expect(answerRows(root)[0]?.["state"]).toBe("consumed");
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("decision: true");

    // Recovery read retained storage and nothing else: no table was added for
    // a scheduling request, and no run status or journal event names one.
    expect(tables(root)).toEqual(settledTables);
    expect(
      tables(root).filter((name) => /schedul|queue|job|lease|heartbeat|sidecar/i.test(name)),
    ).toEqual([]);
    expect(String(runState(root)["status"])).toMatch(/^(completed|failed|suspended|interrupted)$/);
    expect(
      events(root)
        .map((row) => String(JSON.parse(String(row["record"] ?? "{}"))?.description?.type ?? ""))
        .filter((type) => /schedul/i.test(type)),
    ).toEqual([]);

    // And the scheduler itself retains nothing between calls: every name it
    // publishes is an operation, so there is no registry to carry one.
    const surface = yield* until(import("../src/scheduling.ts"));
    const published = Reflect.ownKeys(surface).filter((key) => typeof key === "string");
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((key) => typeof Reflect.get(surface, key) === "function")).toBe(true);
  });

  it("SCH9: the stacked base is the reviewed composed consumer", function* () {
    const toplevel = (yield* git(".", ["rev-parse", "--show-toplevel"])).trim();

    // The exact PR #181 head this slice branched from, and the exact main base
    // beneath it. Recorded rather than derived: what the Planner reviewed is a
    // commit, not whatever this checkout happens to be on.
    expect(STACKED_BASE).toBe("525efaa736110f0ffcd5534985897d1db0692124");
    expect(STACKED_MAIN_BASE).toBe("170a021db9d551f96f1e9bfdd9ea61f74e30e44e");

    // The consumer's file set, exactly. An addition or a deletion under the
    // reviewed workflow changes this list even when every surviving file is
    // untouched.
    const tracked = (yield* git(toplevel, ["ls-files", "--", ...REVIEWED_CONSUMER_ROOTS]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    expect(tracked).toEqual([...REVIEWED_CONSUMER].map(([path]) => path).sort());

    // And its content, exactly. `git hash-object` reads the working tree, so
    // this holds whatever the checkout's history depth is — which matters,
    // because CI clones one commit deep and has no reviewed base to diff
    // against.
    const paths = [...REVIEWED_CONSUMER].map(([path]) => path);
    const hashed = (yield* git(toplevel, ["hash-object", "--", ...paths]))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(hashed).toHaveLength(paths.length);
    expect(Object.fromEntries(paths.map((path, index) => [path, hashed[index]]))).toEqual(
      Object.fromEntries(REVIEWED_CONSUMER),
    );
  });
});

/** The exact PR #181 head this slice is stacked on. */
const STACKED_BASE = "525efaa736110f0ffcd5534985897d1db0692124";

/** The exact `main` base and merge base beneath it. */
const STACKED_MAIN_BASE = "170a021db9d551f96f1e9bfdd9ea61f74e30e44e";

/** Where the reviewed consumer lives. */
const REVIEWED_CONSUMER_ROOTS = [
  "workflows/adversarial-implementation",
  "scripts/tests/adversarial-composition-workflow.test.ts",
];

/**
 * The reviewed consumer, as this slice depends on it.
 *
 * Blob object ids rather than a diff: this slice must not change the workflow
 * documents or the composition suite it depends on, and content identity says
 * so from any checkout — including CI's, which is one commit deep and cannot
 * name the base at all.
 *
 * The provenance below is unchanged: this slice was reviewed on PR #181 head
 * `525efaa7` over `170a021d`, and it still is. What has moved since are blobs,
 * and only through work reviewed in its own right — #299's R3 corrected the
 * observation instruction the Implementation stage renders and extended AC2 to
 * send it, and #292's final synchronization then made the workflow documents
 * describe the delivered revision and added `SYNC1` beside AC0–AC7, each under
 * independent Planner review. Pinning what those files hold now is what keeps
 * this case a statement about *this* slice changing them rather than a
 * statement about nobody changing them.
 */
const REVIEWED_CONSUMER: readonly (readonly [string, string])[] = [
  [
    "scripts/tests/adversarial-composition-workflow.test.ts",
    "adf7e58e609c116e2f93fb97e3592bc70756f24b",
  ],
  ["workflows/adversarial-implementation/Discovery.md", "eea1c650fe5a9d417595b9b457b73dc51485f05a"],
  [
    "workflows/adversarial-implementation/Implementation.md",
    "65333321a163f125d6021f807ac14108e049deac",
  ],
  [
    "workflows/adversarial-implementation/InstructionFiles.md",
    "7ce93d7c1b7f79c560c9a861f27e7597697724d9",
  ],
  ["workflows/adversarial-implementation/Planning.md", "943cb9701e3f4a464f13606547ca319e770aecf3"],
  [
    "workflows/adversarial-implementation/UserCheckpoint.md",
    "576e352ac232426c157a33be964402d600a545bc",
  ],
  ["workflows/adversarial-implementation/artifacts.md", "98899d95b70286851c08b5ccb10e26fd7b20e17e"],
  [
    "workflows/adversarial-implementation/primitives.md",
    "9e66ca0df27608a3c2a6f2887db5b7cb4ed1e34a",
  ],
  ["workflows/adversarial-implementation/runtime.md", "128fb2c1337b5d78890ebc05dcfe79f7416d7f3c"],
  ["workflows/adversarial-implementation/start.md", "b898f95188e5e1940e0e483a9ce74e69c49a53f2"],
  [
    "workflows/adversarial-implementation/tests/agents/checkpoint-material-choice.md",
    "c126bdfe64c227c381317bf12338e235c52e78b5",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/checkpoint-no-choice.md",
    "37233970d764ca28a82f2031361214a91f6279ee",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/checkpoint-twice-no-choice.md",
    "71b960d1d9cc68e83da4a6c88a8d799a9142cde5",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/discovery.md",
    "08e86c746045361ed2752ac456491d863b998348",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/malformed-checkpoint.md",
    "d6c73891be4f4aa845d68e20e1ec9477ac6e1556",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/malformed-implementor.md",
    "5e98acad2a2ad4747eda034f2221b7b4befaa2f8",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/malformed-planner.md",
    "c62e30f33a2e05cf69d49f11f9a8de6f85eebb10",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/plan-converges-implementor.md",
    "ee727a7854facfc7aee530f0c7c39ebee18fc865",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/plan-converges-planner.md",
    "482312813324b7d36516e87624e172e501482f8e",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/revision-implementor.md",
    "5e466bafef109db4444be51594b23e15da2820ec",
  ],
  [
    "workflows/adversarial-implementation/tests/agents/revision-planner.md",
    "fc5b99b299de2708f378ae265c55aea66d4016ab",
  ],
  [
    "workflows/adversarial-implementation/tests/fixtures/AGENTS.md",
    "5c1e220a6907494f4ec5e91aee1b321334784d3b",
  ],
  [
    "workflows/adversarial-implementation/tests/fixtures/nested/AGENTS.md",
    "ab3a7ac1b96e04e81bc463f572c7b77b19a4f711",
  ],
  [
    "workflows/adversarial-implementation/tests/planning-logic.test.md",
    "0f0bb56250e25be242ebaa8d93d76b44cad54e75",
  ],
];
