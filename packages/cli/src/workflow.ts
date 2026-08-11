/**
 * `xmd workflow start` and `xmd workflow resume` — running a document as a
 * retained workflow run.
 *
 * The command selects the environment; the document describes the procedure.
 * `xmd run` executes against the caller's own filesystem and promises nothing
 * afterwards. These two execute against a run: one implicit logical Workspace,
 * one filtered journal, both in one database that outlives the process, so an
 * interrupted procedure continues from its journal frontier rather than from
 * the beginning.
 *
 * ```sh
 * xmd workflow start [--id=<run-id>] [--props-*=…] <definition>
 * xmd workflow resume <run-id>
 * ```
 *
 * `start` names a document; `resume` names a run. That asymmetry is the whole
 * lifecycle rule: a document path locates a definition and never selects a
 * previous run, and a run id addresses a run whose definition and props are
 * already retained. Starting the same document twice without `--id` therefore
 * makes two runs, and `resume` accepts no definition, no props and no generated
 * prop arguments at all — supplying them would ask this run to be a different
 * one.
 *
 * ## Where the boundary is
 *
 * This module is runtime-neutral: it names no SQLite, no DOFS and no host. What
 * it cannot do itself — open a run's storage, and attach that run's Workspace —
 * it asks a `WorkflowHost` for, and the entrypoints decide which one exists.
 * Deno and the compiled binary supply the local one; Node and Bun supply a host
 * that refuses, so the grammar is the same everywhere and the refusal arrives
 * before anything is created or executed.
 *
 * ## Exit status
 *
 * Only a completed run exits zero. The rest are distinguishable, because shell
 * automation that could not tell a suspended run from a finished one would
 * treat every incomplete workflow as success.
 */

import { Err, Ok, ensure, scoped } from "effection";
import type { Operation, Result } from "effection";
import { field, object, cli } from "configliere";
import { z } from "zod";
import type { DurableStream, Json } from "@executablemd/durable-streams";
import { retainedSource } from "@executablemd/core";
import type { RootDocumentSource } from "@executablemd/core";
import { retainedWorkflowInstallation, WorkflowRunStorage } from "@executablemd/workflow";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type {
  WorkflowRunDatabase,
  WorkflowRunStatus,
  WorkflowStopReason,
} from "@executablemd/workflow";
import { loadRetainedDefinition, supportedRootDocument } from "./workflow-definition.ts";
import type { EstablishedDefinition } from "./workflow-definition.ts";

/**
 * What this module cannot do without knowing the host.
 *
 * Two operations, both of which reach storage. Everything else about the
 * lifecycle — the grammar, the definition, the props, the statuses, the exit
 * codes — is the same wherever a run lives.
 */
export interface WorkflowHost {
  /** Install this host's run storage for the current scope and its descendants. */
  useStorage(): Operation<void>;
  /**
   * Attach one run's Workspace around a live or partial document execution.
   *
   * A completed run does not take this path: its root result is already
   * recorded, so there is nothing to give a filesystem to.
   */
  attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T>;
}

export type HostWorkflowInstaller = () => Operation<WorkflowHost>;

/** The one sentence a host without workflow support says. */
export const UNSUPPORTED_WORKFLOW_HOST =
  "xmd workflow is available only through the Deno entrypoint or compiled xmd binary";

export class WorkflowHostUnsupportedError extends Error {
  override name = "WorkflowHostUnsupportedError";

  constructor() {
    super(UNSUPPORTED_WORKFLOW_HOST);
  }
}

/** The installer Node and Bun supply: the grammar exists, the capability does not. */
// deno-lint-ignore require-yield
export function* unsupportedWorkflowHost(): Operation<WorkflowHost> {
  throw new WorkflowHostUnsupportedError();
}

/** Only a completed run exits zero. */
const EXIT_BY_STATUS: Readonly<Record<WorkflowRunStatus, number>> = Object.freeze({
  completed: 0,
  failed: 1,
  suspended: 2,
  cancelled: 3,
  interrupted: 130,
  // A run this process is still holding has not reported an outcome. Reaching
  // here with one is a defect, and zero would call it success.
  running: 1,
});

/** A failure the host classified, rather than an exception message it retained. */
const HOST_FAILURE_CODE = "document-execution-failed";
const HOST_INTERRUPTED_CODE = "executor-interrupted";
const HOST_ORPHANED_CODE = "executor-disappeared";

export const WORKFLOW_ACTIONS = ["start", "resume"];

export const workflowConfig = object({
  action: {
    description: "start or resume",
    ...field(z.string().optional(), cli.argument()),
  },
  target: {
    description: "markdown definition to start, or the run id to resume",
    ...field(z.string().optional(), cli.argument()),
  },
  id: {
    description: "run id to create or address (start only; generated when absent)",
    ...field(z.string().optional()),
  },
  verbose: {
    description: "log journal entries to stderr",
    aliases: ["-V"],
    ...field(z.boolean(), field.default(false)),
  },
  raw: {
    description: "output raw markdown without normalization or terminal formatting",
    ...field(z.boolean(), field.default(false)),
  },
  secretDetection: {
    description:
      "scan durable events for credentials before they persist; " +
      "disable with --no-secret-detection",
    ...field(z.boolean(), field.default(true)),
  },
});

/** What one invocation asks for, after the grammar has been read. */
export interface WorkflowRequest {
  readonly action: "start" | "resume";
  readonly target: string;
  readonly id: string | undefined;
  readonly verbose: boolean;
  readonly raw: boolean;
  readonly secretDetection: boolean;
}

/** What the shared CLI needs in order to execute this run's document. */
export interface WorkflowExecution {
  readonly root: RootDocumentSource;
  readonly props: Record<string, Json>;
  readonly stream: DurableStream;
  /**
   * What the trusted host attaches to this run's one execution.
   *
   * An `ExecutionInstallation` rather than something installed into a scope:
   * its retained-run admission is applied inside canonical core's own journal
   * read, before any middleware or document code exists, and its `prepare`
   * hook records the run inside the durable root before the root import.
   */
  readonly installations: readonly ExecutionInstallation[];
  /** Wraps the whole document execution, or passes it through on completed replay. */
  around<T>(operation: Operation<T>): Operation<T>;
}

/** How one `start` or `resume` ended. */
export interface WorkflowOutcome {
  readonly exitCode: number;
}

/**
 * The run id `start` uses when the caller named none.
 *
 * Opaque and cryptographically random, so two starts of one document are two
 * runs and neither id says anything about what it runs. A caller who wants a
 * stable id supplies one; the local caller is authorized to use any
 * storage-valid id, and hashing is what keeps that id from becoming a path.
 */
function generatedRunId(): string {
  return crypto.randomUUID();
}

function report(message: string): void {
  console.error(message);
}

function reportRun(runId: string): void {
  report(`workflow run: ${runId}`);
}

function reportStatus(status: WorkflowRunStatus): void {
  report(`workflow status: ${status}`);
}

/** Whether this journal already holds the root's terminal event. */
function* isCompleted(stream: DurableStream): Operation<boolean> {
  const events = yield* stream.readAll();
  return events.some((event) => event.type === "close" && event.coroutineId === "root");
}

/**
 * The stop reason a failure gets.
 *
 * A retained event that already crossed the secret filter is preferable to a
 * code, because it says which effect failed. Anything else becomes one
 * categorical host code: the alternative is retaining an exception message
 * beside the journal that filtered it, which is history nothing has filtered.
 */
function* failureReason(database: WorkflowRunDatabase): Operation<WorkflowStopReason> {
  const entries = yield* database.readJournalEntries();
  if (entries.ok) {
    for (let index = entries.value.length - 1; index >= 0; index -= 1) {
      const entry = entries.value[index];
      if (entry !== undefined && entry.event.result.status === "err") {
        return { kind: "journal", eventId: entry.eventId };
      }
    }
  }
  return { kind: "host", code: HOST_FAILURE_CODE };
}

/**
 * Close an execution record this process did not start and cannot finish.
 *
 * A run left `running` by a host that disappeared has an execution record with
 * no end. Closing it as interrupted before a new one begins is what keeps the
 * records a history of executions rather than a history with a hole in it.
 * Concurrent ownership is #367's; nothing here claims a second executor is safe.
 */
function* closeOrphanedExecutions(database: WorkflowRunDatabase): Operation<Result<void>> {
  const executions = yield* database.readDocumentExecutions();
  if (!executions.ok) {
    return executions;
  }
  for (const execution of executions.value) {
    if (execution.stoppedAt !== undefined) {
      continue;
    }
    const finished = yield* database.finishDocumentExecution({
      executionId: execution.executionId,
      status: "interrupted",
      reason: { kind: "host", code: HOST_ORPHANED_CODE },
    });
    if (!finished.ok) {
      return finished;
    }
  }
  return Ok(undefined);
}

/** The grammar this command accepts, refusing what it does not. */
export function parseWorkflowRequest(config: {
  action?: string;
  target?: string;
  id?: string;
  verbose: boolean;
  raw: boolean;
  secretDetection: boolean;
}): Result<WorkflowRequest> {
  const { action, target } = config;
  if (action === undefined) {
    return Err(
      new Error(
        "xmd workflow requires a subcommand — `xmd workflow start <document.md>` or " +
          "`xmd workflow resume <run-id>`",
      ),
    );
  }
  if (action !== "start" && action !== "resume") {
    return Err(
      new Error(
        `unrecognized subcommand for xmd workflow: ${action} — ` +
          `expected ${WORKFLOW_ACTIONS.join(" or ")}`,
      ),
    );
  }
  if (target === undefined || target === "") {
    return Err(
      new Error(
        action === "start"
          ? "xmd workflow start requires a markdown definition — `xmd workflow start <document.md>`"
          : "xmd workflow resume requires a run id — `xmd workflow resume <run-id>`",
      ),
    );
  }
  if (action === "resume" && config.id !== undefined) {
    return Err(
      new Error(
        "unrecognized option for xmd workflow resume: --id — a resume names its run as its " +
          "only argument",
      ),
    );
  }
  return Ok({
    action,
    target,
    id: config.id,
    verbose: config.verbose,
    raw: config.raw,
    secretDetection: config.secretDetection,
  });
}

/** What the props phase already established for a `start`. */
export interface WorkflowStart {
  readonly established: EstablishedDefinition;
  readonly props: Record<string, Json>;
}

/** The statuses a resume may continue from, and what the rest mean. */
function admitResume(status: WorkflowRunStatus): Result<void> {
  switch (status) {
    case "failed":
    case "cancelled":
      // Terminal, and terminal in a direction a resume cannot move. Replaying
      // what a failed run recorded is what a compatible `start --id` is for;
      // asking to *continue* one is asking for something that is over.
      return Err(
        new Error(
          `workflow run ${status}: a run that ${status === "failed" ? "failed" : "was cancelled"} ` +
            "is not resumed. The run is left exactly as it is.",
        ),
      );
    // A completed run replays what it recorded, and attaches no Workspace to do
    // it. `running` keeps its documented temporary treatment until #367 settles
    // durable ownership.
    case "completed":
    case "interrupted":
    case "suspended":
    case "running":
      return Ok(undefined);
  }
}

/**
 * Open the run this request addresses, creating it when `start` describes a new
 * one.
 *
 * `create()` is also how a run is found: a request describing the stored run
 * answers with it, and one differing in any immutable field is refused with the
 * conflict diagnostics storage already has. Nothing here repairs, replaces or
 * initializes anything it did not create, and a lookup that finds nothing
 * creates nothing.
 */
function* openRun(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
): Operation<Result<{ database: WorkflowRunDatabase; source: string }>> {
  if (request.action === "resume") {
    const found = yield* WorkflowRunStorage.operations.lookup(request.target);
    if (!found.ok) {
      return found;
    }
    const database = found.value;
    // Before the definition is fetched, before an orphaned execution is closed,
    // and before anything is begun: a run that ended is not a run to continue,
    // and finding that out after Git has been consulted and a record opened
    // would be finding it out too late.
    const admitted = admitResume(database.record.status);
    if (!admitted.ok) {
      return admitted;
    }
    const source = yield* loadRetainedDefinition(
      database.record.definition,
      database.retrieval?.metadata,
    );
    if (!source.ok) {
      return source;
    }
    return Ok({ database, source: source.value });
  }

  if (start === undefined) {
    return Err(new Error("xmd workflow start has no definition to run"));
  }

  const supported = supportedRootDocument(start.established.definition);
  if (!supported.ok) {
    return supported;
  }

  const created = yield* WorkflowRunStorage.operations.create({
    runId: request.id ?? generatedRunId(),
    definition: start.established.definition,
    base: start.established.base,
    props: start.props,
  });
  if (!created.ok) {
    return created;
  }

  const replaced = yield* created.value.replaceRetrievalMetadata(start.established.retrieval);
  if (!replaced.ok) {
    return replaced;
  }
  return Ok({ database: created.value, source: start.established.source });
}

/**
 * Run one `start` or `resume` to completion, and answer with its exit status.
 *
 * `execute` is the shared CLI's own document machinery, handed everything this
 * run decided: the pinned source, the retained props, the run's journal, the
 * installations that belong inside the execution scope, and the attachment that
 * wraps it.
 */
export function runWorkflow(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
  host: WorkflowHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<WorkflowOutcome> {
  return scoped(function* () {
    yield* host.useStorage();

    const opened = yield* openRun(request, start);
    if (!opened.ok) {
      report(opened.error.message);
      return { exitCode: 1 };
    }

    const { database, source } = opened.value;
    const { record } = database;
    reportRun(record.runId);

    const orphaned = yield* closeOrphanedExecutions(database);
    if (!orphaned.ok) {
      report(orphaned.error.message);
      return { exitCode: 1 };
    }

    const begun = yield* database.beginDocumentExecution();
    if (!begun.ok) {
      report(begun.error.message);
      return { exitCode: 1 };
    }
    const executionId = begun.value.executionId;

    // Interruption is the outcome nothing else publishes. Registered before the
    // execution starts, so a scope torn down by Ctrl-C settles the run rather
    // than leaving a record with no end and a status of `running`.
    //
    // The phase, rather than a boolean: "the document produced an outcome" and
    // "this invocation is durably settled" are different facts, and collapsing
    // them is how a post-execution storage refusal would be republished as an
    // interruption. Teardown speaks only while the phase is still `running`.
    const phase: LifecyclePhase = { state: "running" };
    yield* ensure(function* () {
      if (phase.state !== "running") {
        return;
      }
      const reason: WorkflowStopReason = { kind: "host", code: HOST_INTERRUPTED_CODE };
      const retained = yield* retain(database, executionId, "interrupted", reason);
      if (!retained.ok) {
        // Never claim a status storage refused. What went wrong is reported,
        // and no `workflow status:` line is published.
        //
        // The process still leaves on the signal's terms. `main()` resolves its
        // exit continuation with 130 when SIGINT arrives, before teardown
        // begins, and that continuation is first-settlement-wins — so an
        // interrupted run exits 130 whether or not its last write landed. What
        // this run owes the caller is an accurate account, not a different exit
        // code: the refusal is reported, and no status is claimed that storage
        // did not accept. An ordinary settlement refusal, which happens while
        // there is still an outcome to return, does exit 1.
        report(retained.error.message);
        return;
      }
      reportStatus("interrupted");
    });

    const completed = yield* isCompleted(database.journal);
    const execution: WorkflowExecution = {
      root: retainedSource(record.definition.rootDocumentPath, source),
      props: record.props,
      stream: database.journal,
      // The run already exists: storage created it before anything executed,
      // so this installation records exactly that value, allocates nothing and
      // never consults Git. Service denial is installed beside it, through the
      // same host-service slot `xmd run` fills with a real adapter.
      installations: [
        retainedWorkflowInstallation({
          runId: record.runId,
          base: record.base,
          pinnedCommit: record.definition.objectId,
        }),
      ],
      around<T>(operation: Operation<T>): Operation<T> {
        // A completed run replays its retained output and result. Attaching a
        // Workspace for it would open a transaction and capture a root for
        // work that is not going to happen.
        return completed ? operation : host.attach(database, operation);
      },
    };

    const result = yield* attempt(execution, execute);
    // The document is over, whatever storage does next — so teardown must not
    // relabel this run interrupted, even if what follows refuses.
    phase.state = "executed";

    const status: WorkflowRunStatus = result.ok ? "completed" : "failed";
    const reason = result.ok ? undefined : yield* failureReason(database);
    const retained = yield* retain(database, executionId, status, reason);

    // A document failure is still the failure worth reading, so it is reported
    // whether or not the lifecycle writes landed.
    if (!result.ok) {
      report(result.error.message);
    }
    if (!retained.ok) {
      // The status was not retained, so it is not published and its exit code
      // is not this invocation's. Storage refusing is its own failure.
      report(retained.error.message);
      return { exitCode: 1 };
    }
    phase.state = "settled";
    reportStatus(status);
    return { exitCode: EXIT_BY_STATUS[status] };
  });
}

/**
 * How far this invocation has durably got.
 *
 * `running` — the document may still be running, and a torn-down scope is an
 * interruption to retain. `executed` — the document produced an outcome, so
 * teardown has nothing left to say about it whatever storage does next.
 * `settled` — both lifecycle writes persisted and the status was published.
 */
interface LifecyclePhase {
  state: "running" | "executed" | "settled";
}

/**
 * Retain one outcome: the execution record first, then the run state.
 *
 * Ordered, and the first refusal is the answer. The run state describes a
 * document execution that ended, so publishing it after the record that says so
 * was refused would state a conclusion whose premise storage rejected.
 *
 * Only what the caller already decided crosses into storage — a status and a
 * filtered reason. A storage diagnostic is reported to the caller and never
 * written back into what the run retains.
 */
function* retain(
  database: WorkflowRunDatabase,
  executionId: string,
  status: WorkflowRunStatus,
  reason: WorkflowStopReason | undefined,
): Operation<Result<void>> {
  const finished = yield* database.finishDocumentExecution({ executionId, status, reason });
  if (!finished.ok) {
    return finished;
  }
  const updated = yield* database.updateRunState({ status, reason });
  if (!updated.ok) {
    return updated;
  }
  return Ok(undefined);
}

/**
 * Run the document, converting a failure the shared machinery did not catch.
 *
 * Whatever escapes is still this execution's outcome rather than an
 * interruption, so it is published as a failure and the interruption finalizer
 * stays out of the way.
 */
function* attempt(
  execution: WorkflowExecution,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<Result<void>> {
  try {
    return yield* execute(execution);
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** The exit code a status reports, for a caller composing its own outcome. */
export function workflowExitCode(status: WorkflowRunStatus): number {
  return EXIT_BY_STATUS[status];
}
