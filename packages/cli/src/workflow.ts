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
 * xmd workflow fork <source-run-id> --at=<event-id> [--id=<run-id>] <definition> [--props-*=…]
 * xmd workflow answer [--no-secret-detection] <run-id> <suspension-id> <json>
 * xmd workflow status <run-id> [--json]
 * xmd workflow list [--status=<status>] [--json]
 * xmd workflow history <run-id> [--forkable] [--json]
 * xmd workflow cancel <run-id>
 * xmd workflow delete <run-id>
 * ```
 *
 * `answer` is delivery rather than execution: it retains one typed value for the
 * wait a suspended run stopped at, and starts nothing. The run continues when
 * somebody resumes it, which is the operation that publishes the answer and
 * gives it to the document.
 *
 * `fork` names both: the run it continues and the document it continues with.
 * It is the one action that changes a definition without abandoning history —
 * a new immutable run identity whose journal begins as somebody else's, and
 * whose first live effect happens at the checkpoint the caller selected. Its
 * props begin as the source's, because a corrected definition is still a run of
 * the same procedure and restating every property would make forking a
 * transcription exercise.
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

import { Err, Ok, ensure, scoped, until } from "effection";
import type { Operation, Result } from "effection";
import { field, object, cli } from "configliere";
import { z } from "zod";
import type { DurableEvent, DurableStream, Json } from "@executablemd/durable-streams";
import { retainedSource, validateProps } from "@executablemd/core";
import type { PropsSchema } from "@executablemd/core";
import type { RootDocumentSource } from "@executablemd/core";
import {
  definitionComponents,
  retainedWorkflowInstallation,
  workflowBundleInstallation,
  WORKFLOW_RUN_STATUSES,
  WorkflowLifecycle,
} from "@executablemd/workflow";
import type { ExecutionInstallation } from "@executablemd/core/host";
import type {
  ExecutorLock,
  WorkflowRunDatabase,
  WorkflowRunStatus,
  WorkflowStopReason,
} from "@executablemd/workflow";
import { evaluationComponents } from "@executablemd/workflow/deno";
import type {
  WorkflowExecutionBegun,
  WorkflowExecutionTransitions,
  WorkflowRunCreation,
} from "@executablemd/workflow/deno";
import type { SuspensionControllerOptions, SuspensionNotice } from "@executablemd/workflow/deno";
import { SUSPENSION_REQUEST } from "@executablemd/workflow";
import { describeError } from "./props.ts";
import { preflightFork } from "./workflow-fork.ts";
import { loadRetainedDefinition, supportedRootDocument } from "./workflow-definition.ts";
import type { EstablishedDefinition, RetainedSources } from "./workflow-definition.ts";

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
   * Install this host's typed answer delivery for the current scope.
   *
   * Separate from lifecycle because delivery is neither reading a run nor
   * moving it: it retains one value for a wait, takes no executor lock, and a
   * host that can read runs is not thereby a host that may write into them.
   */
  useDelivery(): Operation<void>;
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
  "fork",
  "answer",
  "status",
  "list",
  "history",
  "cancel",
  "delete",
];

/** The actions that read, answer or control a run rather than executing one. */
const MANAGEMENT_ACTIONS = ["answer", "status", "list", "history", "cancel", "delete"];

/** The options that belong to executing a run. */
const EXECUTION_OPTIONS = [
  "--verbose",
  "-V",
  "--raw",
  "--secret-detection",
  "--no-secret-detection",
];

/** What each action accepts, beyond the generated `--props-*` arguments. */
const OPTIONS_BY_ACTION: Readonly<Record<string, readonly string[]>> = Object.freeze({
  start: [...EXECUTION_OPTIONS, "--id"],
  resume: EXECUTION_OPTIONS,
  fork: [...EXECUTION_OPTIONS, "--id", "--at"],
  // A delivery writes retained state, so it crosses the same gate a durable
  // event crosses. It runs no document, so nothing else about executing one
  // applies to it.
  answer: ["--secret-detection", "--no-secret-detection"],
  status: ["--json"],
  history: ["--json", "--forkable"],
  list: ["--json", "--status"],
  cancel: [],
  delete: [],
});

export const workflowConfig = object({
  action: {
    description: "start, resume, fork, answer, status, list, history, cancel or delete",
    ...field(z.string().optional(), cli.argument()),
  },
  target: {
    description:
      "markdown definition to start, the run a fork continues, or the run id every other " +
      "action addresses",
    ...field(z.string().optional(), cli.argument()),
  },
  argument: {
    description: "the definition a fork runs, or the wait an answer is delivered to",
    ...field(z.string().optional(), cli.argument()),
  },
  value: {
    description: "the answer itself, as one JSON value (answer only)",
    ...field(z.string().optional(), cli.argument()),
  },
  id: {
    description: "run id to create or address (start and fork only; generated when absent)",
    ...field(z.string().optional()),
  },
  at: {
    description: "the retained event a fork continues from (fork only)",
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
  forkable: {
    description: "add each event's forkability to the history (history only)",
    ...field(z.boolean(), field.default(false)),
  },
  status: {
    description: "list only runs retaining this status",
    ...field(z.string().optional()),
  },
});

/** What one execution invocation asks for, after the grammar has been read. */
export interface WorkflowRequest {
  readonly action: "start" | "resume" | "fork";
  /** The definition a `start` runs, or the run every other action addresses. */
  readonly target: string;
  readonly id: string | undefined;
  readonly verbose: boolean;
  readonly raw: boolean;
  readonly secretDetection: boolean;
  /** The retained event a fork continues from. Present exactly for `fork`. */
  readonly at?: string;
  /** The definition a fork runs. Present exactly for `fork`. */
  readonly definition?: string;
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
  | { readonly action: "status"; readonly runId: string; readonly json: boolean }
  | {
      readonly action: "history";
      readonly runId: string;
      readonly json: boolean;
      /** Whether human output carries the forkability columns. JSON always does. */
      readonly forkable: boolean;
    }
  | {
      readonly action: "list";
      readonly status: WorkflowRunStatus | undefined;
      readonly json: boolean;
    }
  | { readonly action: "cancel" | "delete"; readonly runId: string }
  | {
      readonly action: "answer";
      readonly runId: string;
      readonly suspensionId: string;
      readonly value: Json;
      readonly secretDetection: boolean;
    };

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
  /**
   * Whether what this execution renders is kept from the reader.
   *
   * A fork's compatibility replay re-renders history another run already
   * produced, and the fork's own execution renders it again a moment later.
   * Showing both would print the same document twice for one command.
   */
  readonly discardOutput?: boolean;
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
    argument?: string;
    value?: string;
    id?: string;
    at?: string;
    verbose: boolean;
    raw: boolean;
    secretDetection: boolean;
    json: boolean;
    forkable: boolean;
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

  if (action !== "start" && action !== "resume" && action !== "fork") {
    return manageRequest(action, config);
  }

  if (target === undefined || target === "") {
    return Err(new Error(missingTarget(action)));
  }
  if (action === "resume" && config.id !== undefined) {
    return Err(
      new Error(
        "unrecognized option for xmd workflow resume: --id — a resume names its run as its " +
          "only argument",
      ),
    );
  }
  const execution = {
    target,
    id: config.id,
    verbose: config.verbose,
    raw: config.raw,
    secretDetection: config.secretDetection,
  };
  if (action !== "fork") {
    return Ok({ kind: "execute", request: { action, ...execution } });
  }

  // A fork names three things and every one of them is required: the run it
  // continues, the committed event it continues from, and the document it
  // continues with. Defaulting any of them would fork something the caller did
  // not name.
  if (config.at === undefined || config.at === "") {
    return Err(
      new Error(
        "xmd workflow fork requires the checkpoint it continues from — " +
          "`xmd workflow fork <source-run-id> --at=<event-id> <document.md>`. " +
          "`xmd workflow history <source-run-id> --forkable` lists the events it may select.",
      ),
    );
  }
  const definition = config.argument;
  if (definition === undefined || definition === "") {
    return Err(
      new Error(
        "xmd workflow fork requires the markdown definition it runs — " +
          "`xmd workflow fork <source-run-id> --at=<event-id> <document.md>`",
      ),
    );
  }
  return Ok({
    kind: "execute",
    request: { action, ...execution, at: config.at, definition },
  });
}

function missingTarget(action: string): string {
  if (action === "start") {
    return "xmd workflow start requires a markdown definition — `xmd workflow start <document.md>`";
  }
  if (action === "fork") {
    return (
      "xmd workflow fork requires the run it continues — " +
      "`xmd workflow fork <source-run-id> --at=<event-id> <document.md>`"
    );
  }
  return "xmd workflow resume requires a run id — `xmd workflow resume <run-id>`";
}

function manageRequest(
  action: string,
  config: {
    target?: string;
    argument?: string;
    value?: string;
    id?: string;
    at?: string;
    json: boolean;
    forkable: boolean;
    status?: string;
    secretDetection: boolean;
  },
): Result<WorkflowCommand> {
  if (config.id !== undefined) {
    return Err(
      new Error(
        `unrecognized option for xmd workflow ${action}: --id — only a start and a fork name ` +
          "the run they create",
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
  if (action === "answer") {
    return answerRequest(runId, config);
  }
  if (action === "cancel" || action === "delete") {
    return Ok({ kind: "manage", request: { action, runId } });
  }
  if (action === "status") {
    return Ok({ kind: "manage", request: { action, runId, json: config.json } });
  }
  if (action === "history") {
    return Ok({
      kind: "manage",
      request: { action, runId, json: config.json, forkable: config.forkable },
    });
  }
  // Reached only if `WORKFLOW_ACTIONS` names an action this function does not,
  // which is a disagreement inside the grammar rather than a caller's mistake.
  return Err(new Error(`xmd workflow ${action} has no request to make`));
}

/**
 * One delivery, once its three arguments have been read.
 *
 * The value is parsed here rather than carried as text, because a JSON document
 * that does not parse is this invocation's mistake and belongs beside the other
 * grammar refusals — not inside a provider that has already opened a run.
 */
function answerRequest(
  runId: string,
  config: { argument?: string; value?: string; secretDetection: boolean },
): Result<WorkflowCommand> {
  const suspensionId = config.argument;
  if (suspensionId === undefined || suspensionId === "") {
    return Err(
      new Error(
        "xmd workflow answer names the wait it answers — " +
          "`xmd workflow answer <run-id> <suspension-id> <json>`. " +
          "`xmd workflow status <run-id>` reports the request event the run stopped on.",
      ),
    );
  }
  const written = config.value;
  if (written === undefined || written === "") {
    return Err(
      new Error(
        "xmd workflow answer requires the answer itself, as one JSON value — " +
          "`xmd workflow answer <run-id> <suspension-id> <json>`",
      ),
    );
  }

  let value: Json;
  try {
    value = JSON.parse(written);
  } catch (error) {
    return Err(
      new Error(
        `the answer for xmd workflow answer is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }. Quote it so the shell passes it as one argument.`,
      ),
    );
  }

  return Ok({
    kind: "manage",
    request: {
      action: "answer",
      runId,
      suspensionId,
      value,
      secretDetection: config.secretDetection,
    },
  });
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
    if ((action === "start" || action === "fork") && name.startsWith("--props-")) {
      continue;
    }
    return (
      `unrecognized option for xmd workflow ${action}: ${name} — it belongs to another ` +
      "workflow action"
    );
  }
  return undefined;
}

/** What the props phase already established for a `start` or a `fork`. */
export interface WorkflowStart {
  readonly established: EstablishedDefinition;
  /**
   * The properties this invocation supplied, and only those.
   *
   * A value a schema default would have filled in is not one of them: core
   * applies defaults when it validates, and a run retains what it was asked
   * for. That distinction is what lets a fork inherit a source's property
   * without a default quietly overwriting it.
   */
  readonly props: Record<string, Json>;
  /** What the candidate document declares, for validating merged properties. */
  readonly propsSchema: PropsSchema;
}

/**
 * Run one `start`, `resume` or `fork` to completion, and answer with its exit
 * status.
 *
 * `execute` is the shared CLI's own document machinery, handed everything this
 * run decided: the pinned source, the retained props, the run's journal, the
 * installations that belong inside the execution scope, and the attachment that
 * wraps it.
 *
 * A fork runs the same way once it exists. What it does first is prove it can:
 * the compatibility replay happens before the executor lock is taken and before
 * any destination storage is opened, so a candidate that cannot carry the
 * inherited history leaves nothing behind at all.
 */
export function runWorkflow(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
  host: WorkflowHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<WorkflowOutcome> {
  return scoped(function* () {
    const transitions = yield* host.useRunHost();

    // The run id first, because everything else needs to be done under its
    // executor lock — and a generated one is this invocation's own run.
    const runId = request.action === "resume" ? request.target : (request.id ?? generatedRunId());

    // A fork begins from the properties the source retained, so the merged set
    // is decided before the creation that carries it — and therefore before
    // preflight replays under it, before it is admitted, and before it becomes
    // the identity a reused fork id is compared against.
    const inherited = yield* inheritedProps(request);
    if (!inherited.ok) {
      report(inherited.error.message);
      return { exitCode: 1 };
    }

    const creation = yield* startCreation(request, start, inherited.value);
    if (!creation.ok) {
      report(creation.error.message);
      return { exitCode: 1 };
    }

    // Before the executor lock, and before a destination exists: a fork that
    // cannot reproduce the prefix it asked to inherit is a request being
    // refused, not a run that failed.
    const inheritance = yield* forkInheritance(
      request,
      runId,
      start,
      creation.value,
      host,
      transitions,
      execute,
    );
    if (!inheritance.ok) {
      report(inheritance.error.message);
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

    // A resumed run closed over a component bundle reconstructs it here: under
    // the executor lock, from the retained commit, and before the execution
    // record exists. A component that is gone, changed, or unreachable leaves
    // the run's lifecycle records exactly as they are rather than adding an
    // attempt that never began.
    const reconstructed = yield* reconstructedSources(request, runId);
    if (!reconstructed.ok) {
      report(reconstructed.error.message);
      return { exitCode: 1 };
    }

    // One transaction: whatever the previous workflow executor left is reconciled, this
    // action is admitted against what that left behind, and the execution is
    // recorded — or none of it is. A fork's one transaction is its whole
    // existence: the run, its lineage, the inherited prefix, the selected
    // Workspace root and the first execution commit together or not at all.
    const begun = yield* admit(
      transitions,
      executorLock,
      request,
      runId,
      creation.value,
      inheritance.value,
    );
    if (!begun.ok) {
      report(begun.error.message);
      return { exitCode: 1 };
    }

    const { database, record, execution, replay } = begun.value;
    reportRun(record.runId);

    // Only now, and only because execution or replay was admitted.
    const source = yield* documentSource(start, database, reconstructed.value);
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
    // Imported where it is used rather than at the top of this module. This
    // file is on the ordinary `xmd run` path too, and the Deno workflow adapter
    // reaches `node:sqlite` — which Node greets with an experimental warning on
    // standard error the moment it loads. A run that opens no workflow storage
    // should not be announcing that it might have.
    const { createSuspensionController } = yield* until(import("@executablemd/workflow/deno"));
    const suspension = createSuspensionController({ database });
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
      root: retainedSource(record.definition.rootDocumentPath, source.value.source),
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
        // The bundle this run is a run of, when it is a run of one. Both start
        // and resume install it, and a completed replay installs it too: the
        // retained history is held to the same components before its recorded
        // output is accepted.
        ...(source.value.components.length === 0
          ? []
          : [workflowBundleInstallation(source.value.components)]),
        // `<Evaluate>` names durable work after its own invocation, so this run
        // declares it to the execution and canonical execution builds it from
        // the claimant it minted for this attachment. Declared where the
        // Workspace is attached — a completed replay restores its retained
        // output and expands nothing, so it needs no component of its own.
        ...(completed || replay ? [] : [{ components: evaluationComponents(database) }]),
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
 * Begin this action's one document execution, however the run comes to exist.
 *
 * A fork carries the selection its preflight proved, so the transition writes
 * exactly the prefix that was checked rather than reading the source a second
 * time and hoping it agrees.
 */
function* admit(
  transitions: WorkflowExecutionTransitions,
  executorLock: ExecutorLock,
  request: WorkflowRequest,
  runId: string,
  creation: WorkflowRunCreation | undefined,
  inheritance: ForkInheritance | undefined,
): Operation<Result<WorkflowExecutionBegun>> {
  if (request.action !== "fork") {
    return yield* transitions.begin(executorLock, {
      runId,
      action: request.action,
      ...(creation === undefined ? {} : { creation }),
    });
  }
  if (creation === undefined || inheritance === undefined) {
    return Err(new Error("xmd workflow fork has no definition to run"));
  }
  return yield* transitions.fork(executorLock, {
    runId,
    selection: {
      sourceRunId: inheritance.sourceRunId,
      checkpointEventId: inheritance.checkpointEventId,
    },
    creation,
    rootImport: inheritance.rootImport,
  });
}

/** What a fork proved it may inherit, or nothing when this is not a fork. */
interface ForkInheritance {
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly rootImport: DurableEvent;
}

/**
 * Prove a fork's candidate before anything of the fork exists.
 *
 * Answers with nothing for every other action, which is what lets the one
 * lifecycle path below stay the same for all three.
 */
function* forkInheritance(
  request: WorkflowRequest,
  runId: string,
  start: WorkflowStart | undefined,
  creation: WorkflowRunCreation | undefined,
  host: WorkflowHost,
  transitions: WorkflowExecutionTransitions,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<Result<ForkInheritance | undefined>> {
  if (request.action !== "fork") {
    return Ok(undefined);
  }
  if (start === undefined || creation === undefined) {
    return Err(new Error("xmd workflow fork has no definition to run"));
  }
  const at = request.at;
  if (at === undefined) {
    return Err(new Error("xmd workflow fork has no checkpoint to continue from"));
  }
  const checked = yield* preflightFork(
    {
      runId,
      sourceRunId: request.target,
      checkpointEventId: at,
      established: start.established,
      creation,
    },
    { transitions, attach: (database, operation) => host.attach(database, operation) },
    execute,
  );
  if (!checked.ok) {
    return checked;
  }
  return Ok({
    sourceRunId: request.target,
    checkpointEventId: at,
    rootImport: checked.value.rootImport,
  });
}

/**
 * What a `start` or a `fork` creates its run from, or nothing when a resume
 * names one.
 *
 * Checked before the executor lock is taken, because a definition that cannot
 * be a root document is this invocation's mistake rather than something to
 * hold a run for.
 */
function* startCreation(
  request: WorkflowRequest,
  start: WorkflowStart | undefined,
  inherited: Record<string, Json> | undefined,
): Operation<Result<WorkflowRunCreation | undefined>> {
  if (request.action === "resume") {
    return Ok(undefined);
  }
  if (start === undefined) {
    return Err(new Error(`xmd workflow ${request.action} has no definition to run`));
  }
  const supported = supportedRootDocument(start.established.definition);
  if (!supported.ok) {
    return supported;
  }
  const props = yield* forkProps(start, inherited);
  if (!props.ok) {
    return props;
  }
  return Ok({
    definition: start.established.definition,
    base: start.established.base,
    props: props.value,
    ...(start.established.retrieval === undefined
      ? {}
      : { retrieval: start.established.retrieval }),
  });
}

/**
 * The properties this run is created with.
 *
 * A `start` supplies its own and nothing else. A fork begins from what the
 * source retained: a corrected definition is still a run of the same procedure,
 * and restating every property the original was started with would make
 * forking a transcription exercise. Whatever the fork command wrote itself
 * takes precedence, property by property — that is what "add or override"
 * means — and a property the source retained under a name the fork also wrote
 * is the fork's.
 *
 * The result is held to the *candidate* document, because that is the document
 * that will run: a property the source declared and this one does not is a
 * property this run cannot carry, and saying so here is better than letting the
 * compatibility replay report it as divergence.
 */
function* forkProps(
  start: WorkflowStart,
  inherited: Record<string, Json> | undefined,
): Operation<Result<Record<string, Json>>> {
  if (inherited === undefined) {
    return Ok(start.props);
  }
  const merged = { ...inherited, ...start.props };
  try {
    // Validated, not replaced: `validateProps` answers with a copy core has
    // filled defaults into, and a run retains what it was asked for. A `start`
    // retains no default either.
    yield* validateProps("__root__", merged, start.propsSchema);
    return Ok(merged);
  } catch (error) {
    return Err(
      new Error(
        "the properties this fork inherits do not satisfy the definition it runs: " +
          `${describeError(error)}. Supply the differing properties with --props-* arguments, ` +
          "or fork a definition that declares them.",
      ),
    );
  }
}

/**
 * What the source run retained, for a fork to begin from.
 *
 * Read through the ordinary read-only inspection surface, before the fork's
 * executor lock and before anything of the fork exists. Every other action
 * answers with nothing: a `start` has no source, and a `resume` already has the
 * properties its own run retained.
 */
function* inheritedProps(
  request: WorkflowRequest,
): Operation<Result<Record<string, Json> | undefined>> {
  if (request.action !== "fork") {
    return Ok(undefined);
  }
  const snapshot = yield* WorkflowLifecycle.operations.inspect(request.target);
  if (!snapshot.ok) {
    return snapshot;
  }
  return Ok(snapshot.value.record.props);
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
  reconstructed: RetainedSources | undefined,
): Operation<Result<RetainedSources>> {
  if (start !== undefined) {
    return Ok({ source: start.established.source, components: start.established.components });
  }
  if (reconstructed !== undefined) {
    return Ok(reconstructed);
  }
  return yield* loadRetainedDefinition(database.record.definition, database.retrieval?.metadata);
}

/**
 * The pinned sources a resumed run closed over a bundle needs before it begins.
 *
 * Answers with nothing for a `start`, which established its own bundle from Git
 * before it asked storage for anything, and for a run whose definition names no
 * components — that one keeps loading its root after the run has been admitted,
 * because a run that ended is not one to fetch a definition for.
 *
 * A run this host cannot inspect answers with nothing too. What that run is,
 * and whether this action may advance it, is the begin transition's to decide,
 * and answering it here would report a different refusal for the same fact.
 */
function* reconstructedSources(
  request: WorkflowRequest,
  runId: string,
): Operation<Result<RetainedSources | undefined>> {
  if (request.action !== "resume") {
    return Ok(undefined);
  }
  const snapshot = yield* WorkflowLifecycle.operations.inspect(runId);
  if (!snapshot.ok) {
    return Ok(undefined);
  }
  const { definition } = snapshot.value.record;
  if (definitionComponents(definition).length === 0) {
    return Ok(undefined);
  }
  return yield* loadRetainedDefinition(definition, snapshot.value.retrieval?.metadata);
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
