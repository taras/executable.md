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
 * answered by the suspending provider. It runs a real `start` — the definition
 * is established through the command's own module and the attachment is
 * `withWorkflowWorkspace` itself — so nothing it depends on is installed by
 * this suite. Only the agent is a stand-in, in the slot the real agent profile
 * fills, because what is under test is that a turn is retained once rather than
 * what an agent says.
 */

import { describe, it } from "@executablemd/test-support/bdd";
import { expect } from "@executablemd/test-support/expect";
import { call, ensure, Err, Ok, resource, scoped } from "effection";
import type { Operation, Result } from "effection";
import { exists, rm, writeTextFile } from "@effectionx/fs";
import { exec } from "@effectionx/process";
import { mkdtemp, readFile } from "node:fs/promises";
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
import { Git, SUSPENSION_REQUEST, suspendFor, WorkflowLifecycle } from "@executablemd/workflow";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import { workflowRunPath } from "@executablemd/workflow/deno";
import { withWorkflowWorkspace, WORKSPACE_FILE } from "@executablemd/workflow/deno";
import { Agent, installAgentComponents } from "@executablemd/core";
import type {
  AgentPromptEvent,
  Json as CoreJson,
  PromptOptions,
  Session,
} from "@executablemd/core";
import type { Stream } from "effection";
import { createHash } from "node:crypto";
import { establishDefinition } from "../src/workflow-definition.ts";
import { runWorkflow } from "../src/workflow.ts";
import type {
  WorkflowExecution,
  WorkflowHost,
  WorkflowManagementRequest,
  WorkflowRequest,
  WorkflowStart,
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

/**
 * The checkpoint document, and the three effects that must survive a resume.
 *
 * One real `<Prompt>` turn, one real generated-XMD observation and one real
 * file mutation, all before the question. Each is an ordinary durable effect
 * with its own journal entry, which is what makes "the resume repeated none of
 * them" a claim about the journal rather than about a counter this suite kept.
 */
const CHECKPOINT_SCHEMA = `{"type":"object","properties":{"proceed":{"type":"boolean"}},"required":["proceed"]}`;

const CHECKPOINT = `<File path="notes.md">
the change is ready
</File>

<Evaluate source={"<File path=\\"notes.md\\" />"} allow={["read"]} as="observed" />

<Agent name="codex">
  <Prompt as="verdict" throwOnError>
    Is it ready?
  </Prompt>
</Agent>

<Elicit schema={${CHECKPOINT_SCHEMA}} as="decision">
Proceed with the change?
</Elicit>

decision: {decision.proceed}
`;

/**
 * What each of the three effects is called in the journal.
 *
 * Two of the names are module-private to the package that writes them, so they
 * are stated here with their source. They are not taken on trust: CK3/CK4
 * asserts all three appear among the effect types the run actually journaled,
 * so a renamed effect fails the case rather than silently counting zero.
 */
const PROMPT_EFFECT = "agent_prompt"; // packages/core/src/agent/journal.ts
const EVALUATION_EFFECT = "generated_xmd"; // packages/core/src/generated-xmd.ts
const FILE_EFFECT = WORKSPACE_FILE;

/** Every prompt this run's agent was actually asked. */
interface AgentCalls {
  readonly prompts: string[];
}

/**
 * A root Agent provider that answers without a process.
 *
 * Test-only, and the smallest thing that makes `<Prompt>` a real durable turn:
 * what is under test is that the turn is retained once, not what an agent says.
 */
function* useStubAgent(calls: AgentCalls): Operation<void> {
  // Installed on the caller's scope, not a nested one: a `scoped()` here would
  // close before the document runs and take the registration with it.
  yield* installAgentComponents();
  yield* Agent.around(
    {
      // deno-lint-ignore require-yield
      *agent([name]) {
        return name ?? "codex";
      },
      // deno-lint-ignore require-yield
      *session([name]) {
        return { sessionKey: `s:${name ?? "default"}`, cwd: "/" };
      },
      // deno-lint-ignore require-yield
      *prompt([content, options]): Operation<Stream<AgentPromptEvent, string>> {
        calls.prompts.push(content);
        const session: Session =
          typeof options?.session === "object" ? options.session : { sessionKey: "s", cwd: "/" };
        const events: AgentPromptEvent[] = [
          { type: "started", agent: options?.agent ?? "codex", session },
          { type: "text_delta", text: "ready" },
          { type: "terminal", status: "completed" },
        ];
        return {
          *[Symbol.iterator]() {
            let index = 0;
            return {
              // deno-lint-ignore require-yield
              *next() {
                if (index < events.length) {
                  return { done: false, value: events[index++]! };
                }
                return { done: true, value: "ready" };
              },
            };
          },
        };
      },
    },
    { at: "min" },
  );
}

/**
 * The production host, with a stub agent in the slot the real profile fills.
 *
 * `attach` is `withWorkflowWorkspace` itself, so the elicitation pair these
 * cases depend on is installed by the code that installs it in production
 * rather than by this suite.
 */
function productionHost(root: string, calls: AgentCalls, events: string[] = []): WorkflowHost {
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
      return scoped(function* () {
        events.push("attached");
        yield* ensure(function* () {
          events.push("released");
        });
        return yield* withWorkflowWorkspace(database, operation, {
          agent: () => useStubAgent(calls),
        });
      });
    },
  };
}

/** A committed definition whose root document is `source`. */
function useCheckpointFixture(source: string): Operation<Fixture> {
  return resource<Fixture>(function* (provide) {
    const repository = yield* until(mkdtemp(join(tmpdir(), "xmd-ckx-repo-")));
    yield* ensure(function* () {
      yield* rm(repository, { recursive: true, force: true });
    });
    yield* git(repository, ["init", "--quiet"]);
    yield* git(repository, ["config", "user.email", "ckx@example.test"]);
    yield* git(repository, ["config", "user.name", "CKX"]);
    yield* writeTextFile(join(repository, "workflow.md"), source);
    yield* git(repository, ["add", "workflow.md"]);
    yield* git(repository, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "definition"]);
    const objectId = (yield* git(repository, ["rev-parse", "HEAD:workflow.md"])).trim();
    yield* provide({ repository, objectId, contents: source });
  });
}

/** What `xmd workflow start` establishes, through the command's own module. */
function* startFor(fixture: Fixture): Operation<WorkflowStart> {
  const established = yield* establishDefinition(join(fixture.repository, "workflow.md"));
  if (!established.ok) {
    throw established.error;
  }
  return { established: established.value, props: {}, propsSchema: {} };
}

/** The document this run pinned, executed as its root. */
function pinnedBody(rendered: string[]): (execution: WorkflowExecution) => Operation<Result<void>> {
  return function* (execution): Operation<Result<void>> {
    return yield* execution.around(
      call(function* (): Operation<Result<void>> {
        try {
          rendered.push(
            String(
              yield* collect(
                yield* executeInstalled(
                  { ...execution.root, stream: execution.stream, props: execution.props },
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

/** One `runWorkflow` invocation, with what it reported on each stream. */
function invoke(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
  workflowHost: WorkflowHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
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
    console.log = (...parts: unknown[]) => out.push(parts.map((part) => String(part)).join(" "));
    console.error = (...parts: unknown[]) => err.push(parts.map((part) => String(part)).join(" "));
    const outcome = yield* runWorkflow(request, start, workflowHost, execute);
    return { exitCode: outcome.exitCode, written: { out, err } };
  });
}

/**
 * Every byte of this run's storage, main database and sidecars alike.
 *
 * A refusal is specified to leave the database byte-identical, so this compares
 * bytes rather than the rows a query would select — a write a query does not
 * look at is exactly what a refusal must not make.
 */
function* storageDigest(path: string): Operation<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = `${path}${suffix}`;
    digests[suffix === "" ? "db" : suffix] = (yield* exists(file))
      ? createHash("sha256")
          .update(yield* until(readFile(file)))
          .digest("hex")
      : "absent";
  }
  return digests;
}

/**
 * The three effects, counted.
 *
 * `workspace_file` is two, and deliberately: the mutation writes one file and
 * the admitted observation reads one, and both are ordinary Workspace file
 * effects. Pinning the shape rather than asserting "one each" is what makes a
 * repeat visible — a resume that re-ran the read would make it three.
 */
function counts(path: string): Record<string, number> {
  return {
    [PROMPT_EFFECT]: journalled(path, PROMPT_EFFECT),
    [EVALUATION_EFFECT]: journalled(path, EVALUATION_EFFECT),
    [FILE_EFFECT]: journalled(path, FILE_EFFECT),
  };
}

/** Every durable yield of one description type this run retained. */
function journalled(path: string, type: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    let count = 0;
    for (const row of database
      .prepare("SELECT record FROM journal_events ORDER BY sequence")
      .all()) {
      const parsed = JSON.parse(String(row["record"]));
      if (parsed?.type === "yield" && parsed.description?.type === type) {
        count += 1;
      }
    }
    return count;
  } finally {
    database.close();
  }
}

/** Every distinct effect type this run journaled, for naming what it performed. */
function effectTypes(path: string): string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const seen = new Set<string>();
    for (const row of database
      .prepare("SELECT record FROM journal_events ORDER BY sequence")
      .all()) {
      const parsed = JSON.parse(String(row["record"]));
      if (parsed?.type === "yield") {
        seen.add(String(parsed.description?.type));
      }
    }
    return [...seen].sort();
  } finally {
    database.close();
  }
}

describe("Tier CKX — a checkpoint a document asked for", () => {
  it("CK1: a real start suspends, reports its identifiers, and releases the lock", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useCheckpointFixture(CHECKPOINT);
    yield* useGit(fixture);

    const calls: AgentCalls = { prompts: [] };
    const attachments: string[] = [];
    const started = yield* invoke(
      { ...REQUEST, action: "start" },
      yield* startFor(fixture),
      productionHost(root, calls, attachments),
      pinnedBody([]),
    );

    // The process return a caller reads: suspension is its own outcome.
    expect(started.exitCode).toBe(2);

    // Both identifiers reach standard error, and the run id is the one the
    // storage holds rather than something this suite chose.
    const runLine = started.written.err.find((line) => line.startsWith("workflow run: "));
    expect(runLine).toBeDefined();
    const runId = String(runLine).slice("workflow run: ".length).trim();
    expect(started.written.err).toContain("workflow status: suspended");

    const path = workflowRunPath(root, runId);
    const suspended = retained(path);
    expect(suspended.status).toBe("suspended");
    expect(suspended.requests).toHaveLength(1);
    expect(suspended.rootCloses).toBe(0);

    // The stop reason names the retained request rather than repeating it.
    const settled = suspended.executions.filter((execution) => execution.status === "suspended");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.reasonEventId).toBe(suspended.requestEventId);

    // The lock is free: acquisition refuses outright while an executor holds
    // it, so acquiring at all is the proof it was released.
    yield* scoped(function* () {
      yield* useWorkflowLifecycle({ root });
      const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
      expect(acquired.ok).toBe(true);
      expect(acquired.ok && acquired.value.kind).toBe("acquired");
    });

    // The attachment opened and closed: nothing is left holding the execution.
    expect(attachments).toEqual(["attached", "released"]);
  });

  it("CK3/CK4: a delivery executes nothing, and a resume repeats no committed effect", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useCheckpointFixture(CHECKPOINT);
    yield* useGit(fixture);

    const calls: AgentCalls = { prompts: [] };
    const rendered: string[] = [];
    const started = yield* invoke(
      { ...REQUEST, action: "start" },
      yield* startFor(fixture),
      productionHost(root, calls),
      pinnedBody(rendered),
    );
    expect(started.exitCode).toBe(2);

    const runId = String(started.written.err.find((line) => line.startsWith("workflow run: ")))
      .slice("workflow run: ".length)
      .trim();
    const path = workflowRunPath(root, runId);

    // The three effects ahead of the question ran, once each, and the document
    // stopped at the wait rather than rendering its end.
    // Named rather than assumed: a renamed effect fails here instead of
    // silently counting zero for the rest of the case.
    const performed = effectTypes(path);
    expect(performed).toContain(PROMPT_EFFECT);
    expect(performed).toContain(EVALUATION_EFFECT);
    expect(performed).toContain(FILE_EFFECT);

    const atSuspension = counts(path);
    expect(atSuspension).toEqual({
      [PROMPT_EFFECT]: 1,
      [EVALUATION_EFFECT]: 1,
      [FILE_EFFECT]: 2,
    });
    expect(calls.prompts).toHaveLength(1);
    expect(rendered).toEqual([]);

    // CK3 — the delivery retains a value and moves nothing.
    const suspended = retained(path);
    const suspensionId = suspended.requests[0] ?? "";
    const delivered = yield* manage(
      { action: "answer", runId, suspensionId, value: { proceed: true }, secretDetection: true },
      productionHost(root, calls),
    );
    expect(delivered.exitCode).toBe(0);
    expect(delivered.written.out).toEqual([`workflow answer: ${runId} (${suspensionId})`]);
    expect(delivered.written.err).toEqual([]);
    expect(retained(path)).toEqual(suspended);
    expect(calls.prompts).toHaveLength(1);

    // CK4 — the resume spends the answer, and repeats none of the three.
    const resumed = yield* invoke(
      { ...REQUEST, action: "resume", target: runId },
      undefined,
      productionHost(root, calls),
      pinnedBody(rendered),
    );
    expect(resumed.exitCode).toBe(0);

    const completed = retained(path);
    expect(completed.status).toBe("completed");
    expect(completed.requests).toHaveLength(1);
    expect(completed.requests[0]).toBe(suspended.requests[0]);

    // Not one more of anything: the resume restored every committed effect.
    expect(counts(path)).toEqual(atSuspension);

    // The agent was asked once across both executions: the resume restored the
    // turn rather than taking it again.
    expect(calls.prompts).toHaveLength(1);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("decision: true");
    expect(answers(path)[0]?.state).toBe("consumed");
  });

  it("CK5: an invalid and a duplicate delivery are refused, byte for byte", function* () {
    const root = yield* useRunStore();
    const fixture = yield* useCheckpointFixture(CHECKPOINT);
    yield* useGit(fixture);

    const calls: AgentCalls = { prompts: [] };
    const started = yield* invoke(
      { ...REQUEST, action: "start" },
      yield* startFor(fixture),
      productionHost(root, calls),
      pinnedBody([]),
    );
    const runId = String(started.written.err.find((line) => line.startsWith("workflow run: ")))
      .slice("workflow run: ".length)
      .trim();
    const path = workflowRunPath(root, runId);
    const suspensionId = retained(path).requests[0] ?? "";
    expect(suspensionId).not.toBe("");

    // An answer the retained response schema rejects. `proceed` is the field
    // `<Elicit>` declared, and this is the shape its schema gives it — so the
    // refusal is by the schema the document compiled, not one delivery guessed.
    const before = yield* storageDigest(path);
    const invalid = yield* manage(
      { action: "answer", runId, suspensionId, value: { proceed: "yes" }, secretDetection: true },
      productionHost(root, calls),
    );
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.written.err.join(" ")).toContain("does not satisfy the response schema");
    expect(invalid.written.err.join(" ")).toContain("/proceed must be boolean");
    expect(yield* storageDigest(path)).toEqual(before);

    const accepted = yield* manage(
      { action: "answer", runId, suspensionId, value: { proceed: true }, secretDetection: true },
      productionHost(root, calls),
    );
    expect(accepted.exitCode).toBe(0);

    // The digest is sensitive to what a delivery writes: a delivery that was
    // accepted moved bytes, so the two comparisons above and below are not
    // comparing something that could never change.
    const afterAccepted = yield* storageDigest(path);
    expect(afterAccepted).not.toEqual(before);

    // The wait is no longer pending, so a second delivery has nothing to
    // answer — and leaves every byte the first one wrote exactly as it was.
    const duplicate = yield* manage(
      { action: "answer", runId, suspensionId, value: { proceed: false }, secretDetection: true },
      productionHost(root, calls),
    );
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.written.err.join(" ")).toContain("already has an answer waiting");
    expect(yield* storageDigest(path)).toEqual(afterAccepted);
  });
});
