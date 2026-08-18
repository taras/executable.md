/**
 * `xmd workflow` — running a document as a retained workflow run, and reading
 * one back.
 *
 * The command selects the environment; the document describes the procedure.
 * `xmd run` executes against the caller's own filesystem and promises nothing
 * afterwards. `start` and `resume` execute against a run: one implicit logical
 * Workspace, one filtered journal, both in one database that outlives the
 * process, so an interrupted procedure continues from its journal frontier
 * rather than from the beginning. The rest read that run back or control it,
 * and never execute anything.
 *
 * ```sh
 * xmd workflow start [--id=<run-id>] [--props-*=…] <definition>
 * xmd workflow resume <run-id>
 * xmd workflow status <run-id> [--json]
 * xmd workflow list [--status=<status>] [--json]
 * xmd workflow history <run-id> [--json]
 * xmd workflow cancel <run-id>
 * xmd workflow delete <run-id>
 * ```
 *
 * `start` names a document; every other action names a run. That asymmetry is
 * the whole lifecycle rule: a document path locates a definition and never
 * selects a previous run, and a run id addresses a run whose definition and
 * props are already retained. Starting the same document twice without `--id` therefore
 * makes two runs, and `resume` accepts no definition, no props and no generated
 * prop arguments at all — supplying them would ask this run to be a different
 * one.
 *
 * ## Where the boundary is
 *
 * This module is runtime-neutral: it names no SQLite, no DOFS and no host. What
 * it cannot do itself — open a run's storage, install its lifecycle, and attach
 * that run's Workspace — it asks a `WorkflowHost` for, and the entrypoints
 * decide which one exists.
 * Deno and the compiled binary supply the local one; Node and Bun supply a host
 * that refuses, so the grammar is the same everywhere and the refusal arrives
 * before anything is created or executed.
 *
 * ## Exit status
 *
 * Only a completed run exits zero. The rest are distinguishable, because shell
 * automation that could not tell a suspended run from a finished one would
 * treat every incomplete workflow as success. A management command reports its
 * own request instead: reading a failed run succeeds, and only a request this
 * command cannot answer exits 1.
 */

import { Err, Ok, ensure, scoped } from "effection";
import type { Operation, Result } from "effection";
import { field, object, cli } from "configliere";
import { z } from "zod";
import type { DurableStream, Json } from "@executablemd/durable-streams";
import { retainedSource } from "@executablemd/core";
import type { RootDocumentSource } from "@executablemd/core";
import {
  retainedWorkflowInstallation,
  WORKFLOW_RUN_STATUSES,
  WorkflowLifecycle,
} from "@executablemd/workflow";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type {
  WorkflowRunDatabase,
  WorkflowRunStatus,
  WorkflowStopReason,
} from "@executablemd/workflow";
import type {
  WorkflowExecutionTransitions,
  WorkflowRunCreation,
} from "@executablemd/workflow/deno";
import {
  createSuspensionController,
  type SuspensionControllerOptions,
  type SuspensionNotice,
} from "@executablemd/workflow/deno";
import { SUSPENSION_REQUEST } from "@executablemd/workflow";
import { loadRetainedDefinition, supportedRootDocument } from "./workflow-definition.ts";
import type { EstablishedDefinition } from "./workflow-definition.ts";

/**
 * What this module cannot do without knowing the host.
 *
 * Three operations, all of which reach a run's retained state. Everything else
 * about the lifecycle — the grammar, the definition, the props, the statuses,
 * the exit codes — is the same wherever a run lives.
 */
export interface WorkflowHost {
  /**
   * Install everything one run needs, and answer with its execution
   * transitions.
   *
   * Storage and lifecycle over one connection registry, because they write to
   * the same databases. The transitions are a closure rather than something
   * installed: beginning an execution answers with an open database, and a
   * contextual surface anything can reach is the wrong place for that.
   */
  useRunHost(): Operation<WorkflowExecutionTransitions>;
  /**
   * Install this host's run lifecycle for the current scope and its descendants.
   *
   * Separate from storage because a management command needs no writable
   * database: reading a run is not a weaker form of executing one.
   */
  useLifecycle(): Operation<void>;
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

export const WORKFLOW_ACTIONS = [
  "start",
  "resume",
  "status",
  "list",
  "history",
  "cancel",
  "delete",
];

/** The actions that read or control a run rather than executing one. */
const MANAGEMENT_ACTIONS = ["status", "list", "history", "cancel", "delete"];

/** The options that belong to executing a run. */
const EXECUTION_OPTIONS = [
  "--verbose",
  "-V",
  "--raw",
  "--secret-detection",
  "--no-secret-detection",
];

/** What each action accepts, beyond `start`'s generated `--props-*` arguments. */
const OPTIONS_BY_ACTION: Readonly<Record<string, readonly string[]>> = Object.freeze({
  start: [...EXECUTION_OPTIONS, "--id"],
  resume: EXECUTION_OPTIONS,
  status: ["--json"],
  history: ["--json"],
  list: ["--json", "--status"],
  cancel: [],
  delete: [],
});

export const workflowConfig = object({
  action: {
    description: "start, resume, status, list, history, cancel or delete",
    ...field(z.string().optional(), cli.argument()),
  },
  target: {
    description: "markdown definition to start, or the run id every other action addresses",
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
  json: {
    description: "write the inspection result as JSON (status, list and history only)",
    ...field(z.boolean(), field.default(false)),
  },
  status: {
    description: "list only runs retaining this status",
    ...field(z.string().optional()),
  },
});

/** What one execution invocation asks for, after the grammar has been read. */
export interface WorkflowRequest {
  readonly action: "start" | "resume";
  readonly target: string;
  readonly id: string | undefined;
  readonly verbose: boolean;
  readonly raw: boolean;
  readonly secretDetection: boolean;
}

/**
 * What one management invocation asks for.
 *
 * Separate from an execution request because the two share no parameters: an
 * inspection has no props, no journal verbosity and no secret policy, and an
 * execution has no output format and no status filter. Collapsing them would
 * make every option applicable to every action, which is exactly what the
 * grammar refuses.
 */
export type WorkflowManagementRequest =
  | { readonly action: "status" | "history"; readonly runId: string; readonly json: boolean }
  | {
      readonly action: "list";
      readonly status: WorkflowRunStatus | undefined;
      readonly json: boolean;
    }
  | { readonly action: "cancel" | "delete"; readonly runId: string };

/** One `xmd workflow` invocation, once its action has decided what it is. */
export type WorkflowCommand =
  | { readonly kind: "execute"; readonly request: WorkflowRequest }
  | { readonly kind: "manage"; readonly request: WorkflowManagementRequest };

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
 * The grammar this command accepts, refusing what it does not.
 *
 * By action, because the actions do not share a grammar: only `start` names a
 * document and takes generated property arguments, only `list` takes no run id
 * and accepts a status filter, and only the three inspections produce JSON. An
 * option an action does not have is refused rather than ignored — silently
 * accepting `--json` on a cancellation would answer a request nobody made.
 *
 * `args` is the invocation's own argv, needed because a boolean option carries
 * its default whether or not it was written: whether `--verbose` reached a
 * `status` cannot be read from the parsed configuration at all.
 */
export function parseWorkflowRequest(
  config: {
    action?: string;
    target?: string;
    id?: string;
    verbose: boolean;
    raw: boolean;
    secretDetection: boolean;
    json: boolean;
    status?: string;
  },
  args: readonly string[] = [],
): Result<WorkflowCommand> {
  const { action, target } = config;
  if (action === undefined) {
    return Err(
      new Error(
        "xmd workflow requires a subcommand — `xmd workflow start <document.md>` or " +
          "`xmd workflow resume <run-id>`",
      ),
    );
  }
  if (!WORKFLOW_ACTIONS.includes(action)) {
    return Err(
      new Error(
        `unrecognized subcommand for xmd workflow: ${action} — ` +
          `expected ${WORKFLOW_ACTIONS.join(", ")}`,
      ),
    );
  }

  const refusal = optionRefusal(action, args);
  if (refusal !== undefined) {
    return Err(new Error(refusal));
  }

  if (action !== "start" && action !== "resume") {
    return manageRequest(action, config);
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
    kind: "execute",
    request: {
      action,
      target,
      id: config.id,
      verbose: config.verbose,
      raw: config.raw,
      secretDetection: config.secretDetection,
    },
  });
}

function manageRequest(
  action: string,
  config: { target?: string; id?: string; json: boolean; status?: string },
): Result<WorkflowCommand> {
  if (config.id !== undefined) {
    return Err(
      new Error(
        `unrecognized option for xmd workflow ${action}: --id — only a start names the run it ` +
          "creates",
      ),
    );
  }

  if (action === "list") {
    if (config.target !== undefined && config.target !== "") {
      return Err(
        new Error(
          `unrecognized argument for xmd workflow list: ${config.target} — list reports every ` +
            "run and names none",
        ),
      );
    }
    if (config.status === undefined) {
      return Ok({
        kind: "manage",
        request: { action: "list", status: undefined, json: config.json },
      });
    }
    const filter = WORKFLOW_RUN_STATUSES.find((status) => status === config.status);
    if (filter === undefined) {
      return Err(
        new Error(
          `unrecognized value for --status: ${config.status} — expected one of ` +
            `${WORKFLOW_RUN_STATUSES.join(", ")}`,
        ),
      );
    }
    return Ok({ kind: "manage", request: { action: "list", status: filter, json: config.json } });
  }

  const runId = config.target;
  if (runId === undefined || runId === "") {
    return Err(
      new Error(`xmd workflow ${action} requires a run id — \`xmd workflow ${action} <run-id>\``),
    );
  }
  // The id is opaque, and every character in it is part of it. A run may be
  // created as `release-*`, because the local caller may choose any
  // storage-valid id and hashing is what keeps that id from becoming a path —
  // so reading `*` as syntax here would make a run that exists impossible to
  // ask about. Deletion's rule is that it expands nothing, not that it refuses
  // the character: `delete release-*` addresses the run called `release-*` and
  // never a set of runs.
  if (action === "cancel" || action === "delete") {
    return Ok({ kind: "manage", request: { action, runId } });
  }
  if (action === "status" || action === "history") {
    return Ok({ kind: "manage", request: { action, runId, json: config.json } });
  }
  // Reached only if `WORKFLOW_ACTIONS` names an action this function does not,
  // which is a disagreement inside the grammar rather than a caller's mistake.
  return Err(new Error(`xmd workflow ${action} has no request to make`));
}

/**
 * Why the options written are not this action's, or nothing when they are.
 *
 * Read from argv rather than from the parse, and stopping where option parsing
 * stops: everything after `--` is positional however it is spelled, and a
 * boolean option carries its default whether or not anybody wrote it. A
 * generated property argument belongs to `start` and is named by prefix,
 * because what a document declares is not knowable here.
 *
 * A second `--status` is refused rather than resolved. The parser keeps the
 * last value, so accepting two would silently filter by one of the two statuses
 * the caller named.
 */
function optionRefusal(action: string, args: readonly string[]): string | undefined {
  const applicable = OPTIONS_BY_ACTION[action];
  if (applicable === undefined) {
    return undefined;
  }
  const start = args.indexOf("workflow");
  if (start === -1) {
    return undefined;
  }
  let filters = 0;
  for (const arg of args.slice(start + 1)) {
    if (arg === "--") {
      return undefined;
    }
    if (!arg.startsWith("-") || arg === "-") {
      continue;
    }
    const separator = arg.indexOf("=");
    const name = arg.slice(0, separator === -1 ? arg.length : separator);
    if (name === "--status") {
      filters += 1;
      if (filters > 1) {
        return "xmd workflow list accepts one --status filter, and two name two different lists";
      }
    }
    if (applicable.includes(name)) {
      continue;
    }
    if (action === "start" && name.startsWith("--props-")) {
      continue;
    }
    return (
      `unrecognized option for xmd workflow ${action}: ${name} — it belongs to another ` +
      "workflow action"
    );
  }
  return undefined;
}

/** What the props phase already established for a `start`. */
export interface WorkflowStart {
  readonly established: EstablishedDefinition;
  readonly props: Record<string, Json>;
}

/**
 * Run one `start` or `resume` to completion, and answer with its exit status.
 *
 * `execute` is the shared CLI's own document machinery, handed everything this
 * run decided: the pinned source, the retained props, the run's journal, the
 * installations that belong inside the execution scope, and the attachment that
 * wraps it.
 */
/**
 * What a caller owning this process may arrange about one run.
 *
 * Not part of the workflow API and not reachable from a document: a document
 * asks to wait, and what a failing teardown then settles is the host's
 * behavior to prove, not the document's to choose.
 */
export interface RunWorkflowOptions {
  readonly suspension?: Omit<SuspensionControllerOptions, "database">;
}

export function runWorkflow(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
  host: WorkflowHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
  options: RunWorkflowOptions = {},
): Operation<WorkflowOutcome> {
  return scoped(function* () {
    const transitions = yield* host.useRunHost();

    // The run id first, because everything else needs to be done under its
    // executor lock — and a generated one is this invocation's own run.
    const runId = request.action === "resume" ? request.target : (request.id ?? generatedRunId());

    const creation = yield* startCreation(request, start);
    if (!creation.ok) {
      report(creation.error.message);
      return { exitCode: 1 };
    }

    // Acquired before storage is created or opened, before a retained
    // definition is fetched, before replay history is read, before a Workspace
    // is attached and before the root is imported. Nothing below this line
    // happens for a run somebody else is running.
    const acquired = yield* WorkflowLifecycle.operations.acquireExecutor(runId);
    if (!acquired.ok) {
      report(acquired.error.message);
      return { exitCode: 1 };
    }
    if (acquired.value.kind !== "acquired") {
      report(
        `workflow run ${runId} is already running: one workflow executor advances a run, and ` +
          "this host reports that executor rather than following it.",
      );
      return { exitCode: 1 };
    }
    const { lock: executorLock } = acquired.value;

    // One transaction: whatever the previous workflow executor left is reconciled, this
    // action is admitted against what that left behind, and the execution is
    // recorded — or none of it is.
    const begun = yield* transitions.begin(executorLock, {
      runId,
      action: request.action,
      ...(creation.value === undefined ? {} : { creation: creation.value }),
    });
    if (!begun.ok) {
      report(begun.error.message);
      return { exitCode: 1 };
    }

    const { database, record, execution, replay } = begun.value;
    reportRun(record.runId);

    // Only now, and only because execution or replay was admitted.
    const source = yield* documentSource(start, database);
    if (!source.ok) {
      report(source.error.message);
      return { exitCode: 1 };
    }

    // Interruption is the outcome nothing else publishes. Registered before the
    // execution starts, so a scope torn down by Ctrl-C settles the run rather
    // than leaving a record with no end and a status of `running`. The executor
    // lock outlives this finalizer, so its settlement remains authorized.
    //
    // The phase, rather than a boolean: "the document produced an outcome" and
    // "this invocation is durably settled" are different facts, and collapsing
    // them is how a post-execution storage refusal would be republished as an
    // interruption. Teardown speaks only while the phase is still `running`.
    const suspension = createSuspensionController({
      database,
      ...(options.suspension ?? {}),
    });
    const phase: LifecyclePhase = { state: "running" };
    yield* ensure(function* () {
      if (phase.state !== "running") {
        return;
      }
      const retained = yield* transitions.settle(executorLock, {
        executionId: execution.executionId,
        status: "interrupted",
        reason: { kind: "host", code: HOST_INTERRUPTED_CODE },
      });
      if (!retained.ok) {
        // Never claim a status storage refused. What went wrong is reported,
        // and no `workflow status:` line is published.
        //
        // The process still leaves on the signal's terms. `main()` resolves its
        // exit continuation with 130 when SIGINT arrives, before teardown
        // begins, and that continuation is first-settlement-wins — so an
        // interrupted run exits 130 whether or not its last write landed. What
        // this run owes the caller is an accurate account, not a different exit
        // code.
        report(retained.error.message);
        return;
      }
      reportStatus("interrupted");
    });

    const completed = yield* isCompleted(database.journal);
    const documentExecution: WorkflowExecution = {
      root: retainedSource(record.definition.rootDocumentPath, source.value),
      props: record.props,
      stream: database.journal,
      // The run already exists: the begin transition created or found it before
      // anything executed, so this installation records exactly that value,
      // allocates nothing and never consults Git. Service denial is installed
      // beside it, through the same host-service slot `xmd run` fills with a
      // real adapter.
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
        // work that is not going to happen. A replayed terminal run keeps its
        // outcome either way — the begin transition preserved it.
        //
        // The suspension controller owns the scope *inside* the attachment, so
        // halting a suspended execution tears the Workspace down with it and
        // nothing survives the settlement.
        return completed || replay
          ? suspension.own(operation)
          : host.attach(database, suspension.own(operation));
      },
    };

    // Suspension is a settlement candidate of its own, beside the document's
    // canonical outcome and foreground interruption. `race` is what makes it
    // one: whichever settles first halts the other, and a suspension winning
    // halts the execution — which is the structured teardown this run's
    // settlement is evidence of, not work done after the outcome was decided.
    // One outcome, from one place. The suspension controller ends a waiting
    // execution from inside the execution's own scope, so whatever a finalizer
    // raises on the way out — the Workspace attachment's, an Agent's, any
    // descendant's — arrives here as this attempt's failure rather than being
    // swallowed by a halt. An execution whose teardown failed did not reach a
    // durable wait, and `suspended` is never claimed for one.
    const attempted = yield* attempt(documentExecution, execute);
    const waiting = suspension.reported() && !attempted.ok && suspension.entered(attempted.error);
    const settlement: Settlement = waiting
      ? { kind: "suspension", notice: yield* suspension.notice }
      : { kind: "document", result: attempted };

    // The document is over, whatever storage does next — so teardown must not
    // relabel this run interrupted, even if what follows refuses.
    phase.state = "executed";

    if (settlement.kind === "suspension") {
      // The executor lock is still held, and stays held until this invocation
      // returns: teardown finished above, and only then may the run claim a
      // status. The stop reason names the retained request event rather than
      // repeating anything the request said.
      const requested = yield* suspensionEvent(database, settlement.notice.suspensionId);
      const suspended = yield* transitions.settle(executorLock, {
        executionId: execution.executionId,
        status: "suspended",
        ...(requested === undefined ? {} : { reason: requested }),
      });
      if (!suspended.ok) {
        report(suspended.error.message);
        return { exitCode: 1 };
      }
      phase.state = "settled";
      reportStatus("suspended");
      return { exitCode: EXIT_BY_STATUS.suspended };
    }

    const result = settlement.result;
    const status: WorkflowRunStatus = result.ok ? "completed" : "failed";
    const reason = result.ok ? undefined : yield* failureReason(database);
    const retained = yield* transitions.settle(executorLock, {
      executionId: execution.executionId,
      status,
      ...(reason === undefined ? {} : { reason }),
    });

    // A document failure is still the failure worth reading, so it is reported
    // whether or not the lifecycle write landed.
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
 * What a `start` creates its run from, or nothing when a resume names one.
 *
 * Checked before the executor lock is taken, because a definition that cannot
 * be a root document is this invocation's mistake rather than something to
 * hold a run for.
 */
function* startCreation(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
): Operation<Result<WorkflowRunCreation | undefined>> {
  if (request.action === "resume") {
    return Ok(undefined);
  }
  if (start === undefined) {
    return Err(new Error("xmd workflow start has no definition to run"));
  }
  const supported = supportedRootDocument(start.established.definition);
  if (!supported.ok) {
    return supported;
  }
  return Ok({
    definition: start.established.definition,
    base: start.established.base,
    props: start.props,
    ...(start.established.retrieval === undefined
      ? {}
      : { retrieval: start.established.retrieval }),
  });
}

/**
 * The document this run executes.
 *
 * A `start` already established it from Git to read what the pinned document
 * declares. A resume fetches what the run retained, and only once the run has
 * been admitted — a run that ended is not one to fetch a definition for.
 */
function* documentSource(
  start: WorkflowStart | undefined,
  database: WorkflowRunDatabase,
): Operation<Result<string>> {
  if (start !== undefined) {
    return Ok(start.established.source);
  }
  return yield* loadRetainedDefinition(database.record.definition, database.retrieval?.metadata);
}

/**
 * How far this invocation has durably got.
 *
 * `running` — the document may still be running, and a torn-down scope is an
 * interruption to retain. `executed` — the document produced an outcome, so
 * teardown has nothing left to say about it whatever storage does next.
 * `settled` — the settlement committed and the status was published.
 */
interface LifecyclePhase {
  state: "running" | "executed" | "settled";
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

/** Which candidate settled this execution. */
type Settlement =
  | { readonly kind: "document"; readonly result: Result<void> }
  | { readonly kind: "suspension"; readonly notice: SuspensionNotice };

/**
 * The retained request event one suspension published, as a stop reason.
 *
 * A reference rather than a copy. The request already crossed the secret gate
 * on its way into the journal and already carries this run's Workspace root;
 * repeating its text into lifecycle state would retain the same words twice,
 * under a column no gate reads.
 */
function* suspensionEvent(
  database: WorkflowRunDatabase,
  suspensionId: string,
): Operation<WorkflowStopReason | undefined> {
  const entries = yield* database.readJournalEntries();
  if (!entries.ok) {
    return undefined;
  }
  for (let index = entries.value.length - 1; index >= 0; index -= 1) {
    const entry = entries.value[index];
    const description = entry?.event.type === "yield" ? entry.event.description : undefined;
    if (description?.type === SUSPENSION_REQUEST && description.name === suspensionId) {
      return { kind: "journal", eventId: entry?.eventId ?? "" };
    }
  }
  return undefined;
}

/** The exit code a status reports, for a caller composing its own outcome. */
export function workflowExitCode(status: WorkflowRunStatus): number {
  return EXIT_BY_STATUS[status];
}
