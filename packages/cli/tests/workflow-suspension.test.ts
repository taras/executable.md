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
 *
 * `xmd workflow answer` runs through the same module the CLI dispatches to, so
 * what is observed of a delivery is what a caller sees: one stdout line, no
 * status line, and a run whose lifecycle the delivery did not touch.
 *
 * Tier CKX below drives the same executor with the wait a *document* reaches:
 * an ordinary `<Elicit>`, resolved to the workflow host's registration and
 * answered by the suspending provider. That the production attachment installs
 * that pair is Tier CK's claim, in the workflow package; what is under test
 * here is that a question asked in Markdown settles, delivers and resumes on
 * exactly the terms a `suspendFor()` written by hand already does.
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
import { collect, execute, inlineSource, registerComponents } from "@executablemd/core";
import { executeInstalled } from "@executablemd/core/host";
import { durableCall, InMemoryStream } from "@executablemd/durable-streams";
import {
  useWorkflowInputDelivery,
  useWorkflowLifecycle,
  useWorkflowRunHost,
} from "@executablemd/workflow/deno";
import type { WorkflowExecutionTransitions } from "@executablemd/workflow/deno";
import {
  Git,
  SUSPENSION_REQUEST,
  suspendFor,
  useWorkflowElicitation,
  WorkflowLifecycle,
} from "@executablemd/workflow";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { workflowRunPath } from "@executablemd/workflow/deno";
import { runWorkflow } from "../src/workflow.ts";
import type {
  WorkflowExecution,
  WorkflowHost,
  WorkflowManagementRequest,
  WorkflowRequest,
} from "../src/workflow.ts";
import { runWorkflowManagement } from "../src/workflow-management.ts";

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

/**
 * A host whose attachment is a real scoped resource.
 *
 * "No attachment remains" is only observable if something was actually
 * attached, so this opens and closes for real and records both. A no-op wrapper
 * could not tell a released attachment from one still holding the execution.
 */
function host(root: string, events: string[] = []): WorkflowHost {
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
    attach<T>(_database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      return scoped(function* () {
        events.push("attached");
        yield* ensure(function* () {
          events.push("released");
        });
        return yield* operation;
      });
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

/**
 * What one management invocation wrote, on each stream separately.
 *
 * The distinction is the point: a delivery reports itself on standard output
 * and publishes no `workflow status:` line at all, and a test reading only exit
 * codes cannot tell that from a status published beside a zero.
 */
interface Written {
  readonly out: string[];
  readonly err: string[];
}

function manage(
  request: WorkflowManagementRequest,
  workflowHost: WorkflowHost,
): Operation<{ exitCode: number; written: Written }> {
  return scoped(function* () {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    yield* ensure(() => {
      console.log = log;
      console.error = error;
    });
    console.log = (...parts: unknown[]) => {
      out.push(parts.map((part) => String(part)).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      err.push(parts.map((part) => String(part)).join(" "));
    };
    const outcome = yield* runWorkflowManagement(request, workflowHost);
    return { exitCode: outcome.exitCode, written: { out, err } };
  });
}

/** The retained answers this run holds, read the way something outside XMD would. */
function answers(path: string): { suspensionId: string; state: string; answer: string }[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT suspension_id, state, answer FROM workflow_suspension_answers")
      .all()
      .map((row) => ({
        suspensionId: String(row["suspension_id"]),
        state: String(row["state"]),
        answer: String(row["answer"]),
      }));
  } finally {
    database.close();
  }
}

/**
 * The same waiting document, recording what the wait handed back.
 *
 * The value is what proves delivery reached the document rather than merely
 * reaching its journal: an answered wait returns, and the step after it runs
 * with the value in hand.
 */
function useAnsweredDocument(performed: string[]): Operation<void> {
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
        const answer = yield* suspendFor({
          request: { kind: "approval" },
          responseSchema: SCHEMA,
        });
        performed.push(`continued-with-${JSON.stringify(answer)}`);
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
    const attachments: string[] = [];
    yield* useWaitingDocument(performed);

    const first = yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      host(root, attachments),
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
        host(root, attachments),
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

    // Every attachment this run opened was released before its settlement: an
    // attached/released pair per execution, and nothing left open.
    expect(attachments).toEqual([
      "attached",
      "released",
      "attached",
      "released",
      "attached",
      "released",
    ]);

    // Three executions reached the wait and none continued past it, and the
    // prior effect was performed exactly once — the resumes restored it.
    expect(performed.filter((step) => step === "performed-prior-effect")).toHaveLength(1);
    expect(performed.filter((step) => step === "reached-the-wait")).toHaveLength(3);
    expect(performed).not.toContain("continued-past-the-wait");
  });

  it("WFS2: a run that never waits is unchanged by the suspension controller", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useFixture();
    yield* useGit(fixture);

    const runId = yield* createRun(root, fixture);
    const attachments: string[] = [];
    yield* registerComponents([
      {
        name: "Wait",
        origin: "tier-wfs",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          yield* durableCall("prior", function* () {
            return "done";
          });
          return "";
        },
      },
    ]);

    // The controller is installed for this execution exactly as it is for one
    // that waits. A document that never suspends must not notice.
    const completed = yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      host(root, attachments),
      body(),
    );

    expect(completed.exitCode).toBe(0);
    const path = workflowRunPath(root, runId);
    const after = retained(path);
    expect(after.status).toBe("completed");
    expect(after.requests).toHaveLength(0);
    expect(after.rootCloses).toBe(1);
    expect(attachments).toEqual(["attached", "released"]);

    // And replaying that completed run stays a replay: no second effect, no
    // request, and the same terminal outcome.
    const replayed = yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      host(root, attachments),
      body(),
    );
    expect(replayed.exitCode).toBe(0);
    const afterReplay = retained(path);
    expect(afterReplay.status).toBe("completed");
    expect(afterReplay.priorEffects).toBe(after.priorEffects);
    expect(afterReplay.requests).toHaveLength(0);
  });

  it("WFS4: a delivery retains a value, changes nothing else, and a resume spends it", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useFixture();
    yield* useGit(fixture);

    const runId = yield* createRun(root, fixture);
    const performed: string[] = [];
    yield* useAnsweredDocument(performed);

    expect(
      (yield* runWorkflow(
        { ...REQUEST, action: "resume", target: runId },
        undefined,
        host(root),
        body(),
      )).exitCode,
    ).toBe(2);

    const path = workflowRunPath(root, runId);
    const suspended = retained(path);
    const suspensionId = suspended.requests[0] ?? "";
    expect(suspensionId).not.toBe("");

    const delivered = yield* manage(
      {
        action: "answer",
        runId,
        suspensionId,
        value: { approved: true },
        secretDetection: true,
      },
      host(root),
    );

    expect(delivered.exitCode).toBe(0);
    // The delivery, on standard output, and nothing else anywhere. A status
    // line here would say the run moved, and it did not.
    expect(delivered.written.out).toEqual([`workflow answer: ${runId} (${suspensionId})`]);
    expect(delivered.written.err).toEqual([]);

    // The run is exactly where the suspension left it: same status, same stop
    // reason, same executions, same history.
    const afterDelivery = retained(path);
    expect(afterDelivery).toEqual(suspended);
    expect(answers(path)).toEqual([
      { suspensionId, state: "pending", answer: JSON.stringify({ approved: true }) },
    ]);

    // Nothing executed, so the document is still where it stopped.
    expect(performed).toEqual(["performed-prior-effect", "reached-the-wait"]);

    // The resume is what spends it: the wait returns the delivered value, the
    // document continues past it, and the run completes.
    const resumed = yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      host(root),
      body(),
    );

    expect(resumed.exitCode).toBe(0);
    expect(performed).toEqual([
      "performed-prior-effect",
      "reached-the-wait",
      "reached-the-wait",
      `continued-with-${JSON.stringify({ approved: true })}`,
    ]);

    const afterResume = retained(path);
    expect(afterResume.status).toBe("completed");
    expect(afterResume.rootCloses).toBe(1);
    // One request across every execution, and the delivery is spent.
    expect(afterResume.requests).toHaveLength(1);
    expect(answers(path)[0]?.state).toBe("consumed");
  });

  it("WFS5: a delivery does not take the executor lock, and a wrong wait is refused", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useFixture();
    yield* useGit(fixture);

    const runId = yield* createRun(root, fixture);
    yield* useAnsweredDocument([]);

    yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      host(root),
      body(),
    );

    const path = workflowRunPath(root, runId);
    const suspensionId = retained(path).requests[0] ?? "";
    expect(suspensionId).not.toBe("");

    // A wait this run is not at, refused without writing anything.
    const wrong = yield* manage(
      {
        action: "answer",
        runId,
        suspensionId: `${suspensionId}0`,
        value: {},
        secretDetection: true,
      },
      host(root),
    );
    expect(wrong.exitCode).toBe(1);
    expect(wrong.written.out).toEqual([]);
    expect(wrong.written.err[0]).toContain("is not waiting at");
    expect(answers(path)).toEqual([]);

    // And the real wait, answered while a live workflow executor holds the
    // lock. Delivery never asks for it, so holding it changes nothing.
    const delivered = yield* scoped(function* () {
      yield* useWorkflowLifecycle({ root });
      const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
      expect(acquired.ok && acquired.value.kind).toBe("acquired");
      return yield* manage(
        {
          action: "answer",
          runId,
          suspensionId,
          value: { approved: false },
          secretDetection: true,
        },
        host(root),
      );
    });

    expect(delivered.exitCode).toBe(0);
    expect(answers(path)[0]?.state).toBe("pending");
  });

  it("WFS3: an ordinary execution outside a workflow run is unaffected", function* () {
    // No workflow host, no run, no controller: `suspendFor()` has no run to
    // derive an identity from, so it refuses rather than reaching for one.
    const stream = new InMemoryStream();
    yield* registerComponents([
      {
        name: "Wait",
        origin: "tier-wfs",
        props: { type: "object", properties: {}, additionalProperties: false },
        *fn() {
          yield* suspendFor({ request: { kind: "approval" }, responseSchema: SCHEMA });
          return "";
        },
      },
    ]);

    let thrown: unknown;
    try {
      yield* collect(yield* execute({ ...inlineSource("<Wait />\n"), stream }));
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("workflow run");

    // Nothing was published: an ordinary run's journal is untouched by a
    // suspension it could not have.
    const events = yield* stream.readAll();
    expect(
      events.filter(
        (event) => event.type === "yield" && event.description.type === SUSPENSION_REQUEST,
      ),
    ).toHaveLength(0);
  });
});

/** The question a document asks, and the effect that must not run twice. */
const CHECKPOINT_SCHEMA =
  `{"type":"object","properties":{"proceed":{"type":"boolean"}},"required":["proceed"]}`;

const CHECKPOINT = `<Prior />
<Elicit schema={${CHECKPOINT_SCHEMA}} as="decision">
Proceed with the change?
</Elicit>

decision: {decision.proceed}
`;

/** One durable effect ahead of the question, so a repeat would be visible. */
function usePriorEffect(performed: string[]): Operation<void> {
  return registerComponents([
    {
      name: "Prior",
      origin: "tier-ckx",
      props: { type: "object", properties: {}, additionalProperties: false },
      *fn() {
        yield* durableCall("prior", function* () {
          performed.push("performed-prior-effect");
          return "done";
        });
        return "";
      },
    },
  ]);
}

/**
 * The same host, with the workflow's elicitation pair installed in its
 * attachment — where `withWorkflowWorkspace` installs it in production.
 */
function elicitingHost(root: string, events: string[] = []): WorkflowHost {
  const inner = host(root, events);
  return {
    ...inner,
    attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T> {
      return inner.attach(
        database,
        scoped(function* () {
          yield* useWorkflowElicitation();
          return yield* operation;
        }),
      );
    },
  };
}

/** The checkpoint document, as this run's root. */
function checkpointBody(rendered: string[]): (execution: WorkflowExecution) => Operation<Result<void>> {
  return function* (execution): Operation<Result<void>> {
    return yield* execution.around(
      call(function* (): Operation<Result<void>> {
        try {
          rendered.push(
            String(
              yield* collect(
                yield* executeInstalled(
                  { ...inlineSource(CHECKPOINT), stream: execution.stream },
                  execution.installations,
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

describe("Tier CKX — a checkpoint a document asked for", () => {
  it("CK1/CK3/CK4: an <Elicit> suspends, a delivery executes nothing, and a resume spends it", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useFixture();
    yield* useGit(fixture);

    const runId = yield* createRun(root, fixture);
    const performed: string[] = [];
    const rendered: string[] = [];
    const attachments: string[] = [];
    yield* usePriorEffect(performed);

    // CK1 — the question settles the run rather than blocking it.
    const first = yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      elicitingHost(root, attachments),
      checkpointBody(rendered),
    );
    expect(first.exitCode).toBe(2);

    const path = workflowRunPath(root, runId);
    const suspended = retained(path);
    expect(suspended.status).toBe("suspended");
    expect(suspended.requests).toHaveLength(1);
    expect(suspended.rootCloses).toBe(0);
    expect(suspended.priorEffects).toBe(1);

    // The stop reason names the retained request, and the executor lock is
    // free — acquisition refuses outright while one is held, so acquiring is
    // the proof it was released.
    const settled = suspended.executions.filter((execution) => execution.status === "suspended");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.reasonEventId).toBe(suspended.requestEventId);
    yield* scoped(function* () {
      yield* useWorkflowLifecycle({ root });
      const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
      expect(acquired.ok).toBe(true);
    });

    // Nothing rendered: the document never reached its own end.
    expect(rendered).toEqual([]);

    // CK3 — the delivery retains a value and moves nothing.
    const suspensionId = suspended.requests[0] ?? "";
    const delivered = yield* manage(
      { action: "answer", runId, suspensionId, value: { proceed: true }, secretDetection: true },
      elicitingHost(root),
    );
    expect(delivered.exitCode).toBe(0);
    expect(delivered.written.out).toEqual([`workflow answer: ${runId} (${suspensionId})`]);
    expect(delivered.written.err).toEqual([]);
    expect(retained(path)).toEqual(suspended);
    expect(performed).toEqual(["performed-prior-effect"]);

    // CK4 — the resume spends it, the answer reaches the document as the bound
    // value, and the effect ahead of the question is restored rather than
    // performed a second time.
    const resumed = yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      elicitingHost(root, attachments),
      checkpointBody(rendered),
    );
    expect(resumed.exitCode).toBe(0);

    const completed = retained(path);
    expect(completed.status).toBe("completed");
    expect(completed.priorEffects).toBe(1);
    expect(completed.requests).toHaveLength(1);
    expect(completed.requests[0]).toBe(suspended.requests[0]);
    expect(performed).toEqual(["performed-prior-effect"]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("decision: true");
    expect(answers(path)[0]?.state).toBe("consumed");

    // Every attachment opened was released before its settlement.
    expect(attachments).toEqual(["attached", "released", "attached", "released"]);
  });

  it("CK5: a second delivery and a schema-invalid one are refused, and retain nothing", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useFixture();
    yield* useGit(fixture);

    const runId = yield* createRun(root, fixture);
    const performed: string[] = [];
    yield* usePriorEffect(performed);

    yield* runWorkflow(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      elicitingHost(root),
      checkpointBody([]),
    );

    const path = workflowRunPath(root, runId);
    const suspensionId = retained(path).requests[0] ?? "";
    expect(suspensionId).not.toBe("");

    // An answer the retained response schema rejects, before anything is
    // written: `proceed` is declared boolean and required.
    const invalid = yield* manage(
      {
        action: "answer",
        runId,
        suspensionId,
        value: { proceed: "yes" },
        secretDetection: true,
      },
      elicitingHost(root),
    );
    expect(invalid.exitCode).not.toBe(0);
    // Refused by the schema the *document* compiled and the request retained,
    // rather than by anything delivery reconstructed: `proceed` is the field
    // `<Elicit>` declared, and this is the shape its schema gives it.
    expect(invalid.written.err.join(" ")).toContain("does not satisfy the response schema");
    expect(invalid.written.err.join(" ")).toContain("/proceed must be boolean");
    expect(answers(path)).toEqual([]);

    const accepted = yield* manage(
      { action: "answer", runId, suspensionId, value: { proceed: true }, secretDetection: true },
      elicitingHost(root),
    );
    expect(accepted.exitCode).toBe(0);
    const afterFirst = answers(path);
    expect(afterFirst).toHaveLength(1);

    // The wait is no longer pending, so a second delivery has nothing to
    // answer — and leaves what the first retained exactly as it was.
    const duplicate = yield* manage(
      { action: "answer", runId, suspensionId, value: { proceed: false }, secretDetection: true },
      elicitingHost(root),
    );
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.written.err.join(" ")).toContain("already has an answer waiting");
    expect(answers(path)).toEqual(afterFirst);
  });
});
