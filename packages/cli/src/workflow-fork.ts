/**
 * Proving a candidate definition can carry somebody else's history, before a
 * fork exists.
 *
 * `xmd workflow fork <source> --at=<event> <definition>` says: run *this*
 * document, but start it where that run had already got to. That only holds if
 * the candidate definition, its component bundle and the fork's props produce
 * exactly the retained prefix when replayed. Anything else — an effect in a
 * different order, an effect that is no longer there, a document that finishes
 * early — is divergence, and a fork admitted on divergent history would replay
 * work its own document never describes.
 *
 * ## Two passes, because the root import is the fork's own
 *
 * The first pass replays nothing but the fork's own run record and captures the
 * root import the candidate definition produces — the record that holds the
 * document's own text, which a fork must write for itself or it would run the
 * source's document forever. The append that carries it is refused, so the
 * capture happens before the document is expanded and before anything else runs.
 *
 * The second pass replays that record together with the inherited prefix, and
 * is the divergence check proper. It runs against a staged fork — the whole
 * run, assembled where nothing recognizes it as one — because a document
 * resolves its paths through the run's own Workspace, and a replay without one
 * produces effects of a different kind and diverges for a reason that has
 * nothing to do with the candidate. The staging goes when this operation's
 * scope ends, whichever way the check decides.
 *
 * ## The replay stops at the boundary, not after it
 *
 * A durable operation performs its work and *then* appends, so a stream that
 * merely refuses appends would already have run the first live effect. What
 * stops this replay is the retained prefix running out: a guard counts the
 * events replay consumes and, on the last one, ends the execution before the
 * stored result is handed back. Nothing after the checkpoint is entered, no
 * host service is reached, and no event is appended.
 *
 * Reaching that boundary is the success condition. A replay that ends any other
 * way — a divergence refusal, a document that closed its root, an append that
 * arrived before the prefix was exhausted — is a candidate this checkpoint
 * cannot be forked with, and it is reported against the event where the
 * disagreement began.
 *
 * ## Nothing here creates anything
 *
 * The preflight runs before the fork's executor lock is taken and before any
 * destination storage is opened. It reads the source through the ordinary
 * read-only lifecycle surface, and everything it replays lives in memory.
 */

import { Err, Ok, scoped } from "effection";
import type { Operation, Result } from "effection";
import { ReplayGuard } from "@executablemd/durable-streams";
import type { DurableEvent, DurableStream, ReplayOutcome } from "@executablemd/durable-streams";
import { retainedSource } from "@executablemd/core";
import {
  forkJournal,
  forkRunRecordEvent,
  gitHostReplayInstallation,
  isRootImportEvent,
  retainedWorkflowInstallation,
  selectForkPrefix,
  workflowBundleInstallation,
  WorkflowLifecycle,
} from "@executablemd/workflow";
import type { ForkSelection, WorkflowRun } from "@executablemd/workflow";
import type { WorkflowRunDatabase } from "@executablemd/workflow";
import type {
  WorkflowExecutionTransitions,
  WorkflowRunCreation,
} from "@executablemd/workflow/deno";
import type { EstablishedDefinition } from "./workflow-definition.ts";
import type { WorkflowExecution } from "./workflow.ts";

/** What a fork proved, and what it will therefore retain. */
export interface ForkAdmission {
  readonly selection: ForkSelection;
  /** The root import the candidate produced, which the fork writes for itself. */
  readonly rootImport: DurableEvent;
}

/** What one fork asks for, once the grammar has read it. */
export interface ForkRequest {
  readonly runId: string;
  readonly sourceRunId: string;
  readonly checkpointEventId: string;
  readonly established: EstablishedDefinition;
  readonly creation: WorkflowRunCreation;
}

/**
 * The end of the inherited prefix, reached without running anything past it.
 *
 * Raised through the durable machinery's own failure path, so it collapses the
 * execution the way a stale replay would — which is exactly what it is: a
 * deliberate refusal to continue.
 */
class ForkCheckpointReached extends Error {
  override name = "ForkCheckpointReached";

  constructor() {
    super("the inherited prefix ended at the selected checkpoint");
  }
}

/** The candidate's root import, captured from the append that carries it. */
class ForkRootImportCaptured extends Error {
  override name = "ForkRootImportCaptured";

  constructor() {
    super("the candidate definition recorded its root document import");
  }
}

/** The candidate went live before it had consumed the prefix. */
class ForkPrematureEffectError extends Error {
  override name = "ForkPrematureEffectError";

  constructor(consumed: number, total: number) {
    super(
      `the candidate definition performed a new durable effect after ${consumed} of ${total} ` +
        "inherited events, so it does not reproduce the history before the checkpoint",
    );
  }
}

/**
 * Prove the candidate reproduces the prefix, and answer with what it inherits.
 *
 * The selection is the fork's, not the source's: it names the events the fork
 * will hold and the Workspace root it starts from.
 */
export function* preflightFork(
  request: ForkRequest,
  host: ForkPreflightHost,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<Result<ForkAdmission>> {
  const history = yield* WorkflowLifecycle.operations.history(request.sourceRunId);
  if (!history.ok) {
    return history;
  }

  const selected = selectForkPrefix(history.value, request.checkpointEventId);
  if (!selected.ok) {
    return selected;
  }
  const selection = selected.value;

  const run: WorkflowRun = {
    runId: request.runId,
    base: request.creation.base,
    pinnedCommit: request.creation.definition.objectId,
  };
  const imported = yield* captureRootImport(request, run, execute);
  if (!imported.ok) {
    return imported;
  }
  const rootImport = imported.value;

  const journal = forkJournal(run, rootImport, selection);
  // Aligned with the journal: the fork's two own records occupy the first two
  // positions and have no source event, and every position after them is an
  // inherited row.
  const identities = ["", "", ...selection.inherited.map((candidate) => candidate.eventId)];

  const checked = yield* scoped(function* (): Operation<Result<void>> {
    const staged = yield* host.transitions.stageFork({
      runId: request.runId,
      selection: {
        sourceRunId: request.sourceRunId,
        checkpointEventId: request.checkpointEventId,
      },
      creation: request.creation,
      rootImport,
    });
    if (!staged.ok) {
      return staged;
    }
    const database = staged.value;
    return yield* replayPrefix(request, run, journal, identities, execute, (operation) =>
      host.attach(database, operation),
    );
  });
  if (!checked.ok) {
    return checked;
  }
  return Ok({ selection, rootImport });
}

/** What a preflight needs from the host: a staged fork, and its Workspace. */
export interface ForkPreflightHost {
  readonly transitions: WorkflowExecutionTransitions;
  attach<T>(database: WorkflowRunDatabase, operation: Operation<T>): Operation<T>;
}

/**
 * The root import the candidate definition records, and nothing after it.
 *
 * The replay holds only the fork's own run record, so the import runs live and
 * its append is the first thing to arrive. Refusing that append is what stops
 * the execution there: the record is in hand, the document has not been
 * expanded, and no authored effect exists yet.
 */
function* captureRootImport(
  request: ForkRequest,
  run: WorkflowRun,
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
): Operation<Result<DurableEvent>> {
  const record = forkRunRecordEvent(run);
  let captured: DurableEvent | undefined;

  const stream: DurableStream = {
    // deno-lint-ignore require-yield
    *readAll(): Operation<DurableEvent[]> {
      return [structuredClone(record)];
    },
    // deno-lint-ignore require-yield
    *append(event: DurableEvent): Operation<void> {
      if (captured === undefined && isRootImportEvent(event)) {
        // The event has already crossed this execution's secret gate, which
        // wraps this stream: what is captured is what the fork will retain.
        captured = structuredClone(event);
        throw new ForkRootImportCaptured();
      }
      throw new ForkPrematureEffectError(0, 0);
    },
  };

  const attempted = yield* execute(execution(request, run, stream, passThrough));
  if (captured !== undefined) {
    return Ok(captured);
  }
  return Err(
    attempted.ok
      ? new Error(
          "the candidate definition recorded no root document import, so there is nothing for " +
            "a fork to run",
        )
      : attempted.error,
  );
}

function passThrough<T>(operation: Operation<T>): Operation<T> {
  return operation;
}

function* replayPrefix(
  request: ForkRequest,
  run: WorkflowRun,
  journal: readonly DurableEvent[],
  identities: readonly string[],
  execute: (execution: WorkflowExecution) => Operation<Result<void>>,
  attach: <T>(operation: Operation<T>) => Operation<T>,
): Operation<Result<void>> {
  const total = journal.filter((event) => event.type === "yield").length;
  const progress = { consumed: 0 };

  const stream: DurableStream = {
    // deno-lint-ignore require-yield
    *readAll(): Operation<DurableEvent[]> {
      return journal.map((event) => structuredClone(event));
    },
    // deno-lint-ignore require-yield
    *append(): Operation<void> {
      throw new ForkPrematureEffectError(progress.consumed, total);
    },
  };

  function boundary<T>(operation: Operation<T>): Operation<T> {
    return attach(
      scoped(function* () {
        yield* ReplayGuard.around({
          decide([event], next): ReplayOutcome {
            const outcome = next(event);
            if (outcome.outcome === "error") {
              return outcome;
            }
            progress.consumed += 1;
            if (progress.consumed >= total) {
              return { outcome: "error", error: new ForkCheckpointReached() };
            }
            return outcome;
          },
        });
        return yield* operation;
      }),
    );
  }

  const attempted = yield* execute(execution(request, run, stream, boundary));
  if (attempted.ok) {
    return Err(
      new Error(
        `the candidate definition finished after ${progress.consumed} of ${total} inherited ` +
          "events, so it does not reach the selected checkpoint. Select a checkpoint the " +
          "candidate definition still reaches, or start a new run.",
      ),
    );
  }
  if (reachedCheckpoint(attempted.error)) {
    return Ok(undefined);
  }
  return Err(divergence(attempted.error, journal, identities, progress.consumed, total));
}

/**
 * Whether the boundary is what ended this replay.
 *
 * The durable machinery wraps a failure on its way out, so the chain is walked
 * rather than the outermost error inspected.
 */
/**
 * One preflight execution of the candidate definition.
 *
 * The same shape both passes use: the fork's own identity, the candidate's
 * pinned source and bundle, and a stream that answers with whatever that pass
 * is replaying.
 */
function execution(
  request: ForkRequest,
  run: WorkflowRun,
  stream: DurableStream,
  around: <T>(operation: Operation<T>) => Operation<T>,
): WorkflowExecution {
  return {
    root: retainedSource(request.creation.definition.rootDocumentPath, request.established.source),
    props: request.creation.props,
    stream,
    installations: [
      retainedWorkflowInstallation(run),
      gitHostReplayInstallation(),
      ...(request.established.components.length === 0
        ? []
        : [workflowBundleInstallation(request.established.components)]),
    ],
    // A check, not a run: what this renders describes work another run already
    // did, and the fork's own execution is about to render it again.
    discardOutput: true,
    around,
  };
}

function reachedCheckpoint(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === null || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current instanceof ForkCheckpointReached) {
      return true;
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
    if (current instanceof Error && current.cause !== undefined) {
      pending.push(current.cause);
    }
  }
  return false;
}

/**
 * Where the candidate stopped agreeing with the inherited prefix.
 *
 * The event named is the one replay was about to consume: everything before it
 * matched, so that is the boundary a caller has to look at. The failure's own
 * message is carried because it is the durable machinery's account of the
 * disagreement, and it is about the candidate document rather than about
 * retained values.
 */
function divergence(
  error: Error,
  journal: readonly DurableEvent[],
  identities: readonly string[],
  consumed: number,
  total: number,
): Error {
  const at = describeEvent(journal, identities, consumed);
  return new Error(
    `the candidate definition diverges from the inherited history after ${consumed} of ` +
      `${total} events${at}: ${error.message}`,
    { cause: error },
  );
}

/**
 * The inherited event replay was about to consume.
 *
 * Its retained id and the effect's own type, which is its identity. The
 * evaluated arguments and the recorded result are filtered history and stay
 * where they are.
 */
function describeEvent(
  journal: readonly DurableEvent[],
  identities: readonly string[],
  consumed: number,
): string {
  let seen = 0;
  for (const [index, event] of journal.entries()) {
    if (event.type !== "yield") {
      continue;
    }
    if (seen === consumed) {
      const eventId = identities[index];
      const at = eventId === undefined || eventId === "" ? "the fork's own run record" : eventId;
      return `, at ${at} (${event.description.type})`;
    }
    seen += 1;
  }
  return "";
}
