/**
 * Which retained events a fork inherits, and what its own journal begins with.
 *
 * A fork is a new run whose history starts as somebody else's. `--at` names one
 * committed event of the source, and everything the source retained up to and
 * including it becomes the fork's inherited prefix.
 *
 * ## Two head events are the fork's own
 *
 * A journal identifies its run by the one `workflow_run` record written before
 * the root document is imported, and a history carrying two describes two runs.
 * So the fork writes its own record at position zero and the source's is left
 * behind: it is lineage, and lineage is not identity.
 *
 * The root import is the fork's own for a different reason. That record holds
 * the document's own text, and replay restores the document from it — so a fork
 * that inherited the source's root import would run the source's definition
 * forever, whatever document the caller named. The fork records the definition
 * it was given, and the divergence check that follows is exactly the question
 * that record raises: does *this* document produce the history that comes next?
 *
 * Everything after those two travels unchanged — the same public event ids, the
 * same filtered results, the same authored positions and the same Workspace
 * roots — so a reader of the fork sees the events the source recorded rather
 * than copies somebody made.
 *
 * ## Selection is total before anything is created
 *
 * A checkpoint nobody retained, a checkpoint whose prefix is not forkable, and
 * a checkpoint at the run's own outcome are all refused here, where refusing
 * costs nothing. The last of those is not a technicality: a run whose canonical
 * outcome is inside the prefix has nothing left to continue, and a fork of it
 * would replay a result and stop.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { Err, Ok, type Result } from "effection";
import { describeWorkflowRun, WORKFLOW_RUN, type WorkflowRun } from "./journal.ts";
import type { Forkability } from "./lifecycle/forkability.ts";
import { WorkflowRequestError } from "./storage/errors.ts";

/** The coroutine a run's own record and canonical outcome belong to. */
const ROOT_COROUTINE = "root";

/** How core records importing a component, and the name the root document has. */
const IMPORT_COMPONENT = "import_component";
const ROOT_DOCUMENT = "__root__";

/** One retained row, as fork selection reads it. */
export interface ForkCandidate {
  readonly eventId: string;
  readonly event: DurableEvent;
  readonly workspaceRootId: string;
  readonly forkability: Forkability;
}

/** What one checkpoint selects out of a source run's retained history. */
export interface ForkSelection {
  /** The events the fork inherits, in retained order, without the source's own record. */
  readonly inherited: readonly ForkCandidate[];
  /** The Workspace root the checkpoint event was written against. */
  readonly checkpointWorkspaceRootId: string;
}

/**
 * The prefix `--at` names, or why it names nothing a fork can inherit.
 *
 * Answered rather than raised: every one of these is a caller's request being
 * refused before a destination exists.
 */
export function selectForkPrefix(
  candidates: readonly ForkCandidate[],
  checkpointEventId: string,
): Result<ForkSelection> {
  const at = candidates.findIndex((candidate) => candidate.eventId === checkpointEventId);
  if (at === -1) {
    return Err(
      new WorkflowRequestError(
        `no retained event of this run is ${JSON.stringify(checkpointEventId)}. ` +
          "`xmd workflow history <run-id> --forkable` lists the checkpoints a fork may select.",
      ),
    );
  }

  const checkpoint = candidates[at];
  if (checkpoint === undefined) {
    return Err(new WorkflowRequestError("the selected checkpoint is not a retained event"));
  }

  if (isRootOutcome(checkpoint.event)) {
    return Err(
      new WorkflowRequestError(
        "the selected checkpoint is this run's canonical outcome, so a fork of it would have " +
          "nothing left to run. Select an earlier event.",
      ),
    );
  }

  if (!checkpoint.forkability.forkable) {
    const blockers = checkpoint.forkability.blockers
      .map((blocker) => `${blocker.code} at ${blocker.eventId}`)
      .join(", ");
    return Err(
      new WorkflowRequestError(
        `the prefix ending at ${JSON.stringify(checkpointEventId)} cannot be forked: ${blockers}. ` +
          "Select a checkpoint before the earliest of those events.",
      ),
    );
  }

  const prefix = candidates.slice(0, at + 1);
  return Ok({
    inherited: Object.freeze(
      prefix.filter(
        (candidate) => !isRunRecordEvent(candidate.event) && !isRootImportEvent(candidate.event),
      ),
    ),
    checkpointWorkspaceRootId: checkpoint.workspaceRootId,
  });
}

/**
 * The record the fork writes at position zero, exactly as its own execution
 * would have written it.
 *
 * Composed here rather than in a host, so the value a fork is admitted with and
 * the value its first execution replays are the same shape by construction.
 */
export function forkRunRecordEvent(run: WorkflowRun): DurableEvent {
  return {
    type: "yield",
    coroutineId: ROOT_COROUTINE,
    description: describeWorkflowRun(run.base),
    result: {
      status: "ok",
      value: { runId: run.runId, base: run.base, pinnedCommit: run.pinnedCommit },
    },
  };
}

/**
 * The fork's logical journal: its own two head records, then what it inherited.
 *
 * `rootImport` is the record the fork's own definition produced, captured from
 * a replay that got no further than producing it.
 */
export function forkJournal(
  run: WorkflowRun,
  rootImport: DurableEvent,
  selection: ForkSelection,
): readonly DurableEvent[] {
  return Object.freeze([
    forkRunRecordEvent(run),
    rootImport,
    ...selection.inherited.map((candidate) => candidate.event),
  ]);
}

/** Whether this event is the root coroutine's import of the root document. */
export function isRootImportEvent(event: DurableEvent): boolean {
  return (
    event.type === "yield" &&
    event.description.type === IMPORT_COMPONENT &&
    event.description.name === ROOT_DOCUMENT
  );
}

/** Whether this event is the root coroutine's own `workflow_run` record. */
export function isRunRecordEvent(event: DurableEvent): boolean {
  return (
    event.type === "yield" &&
    event.coroutineId === ROOT_COROUTINE &&
    event.description.type === WORKFLOW_RUN &&
    event.description.name === WORKFLOW_RUN
  );
}

/** Whether this event is the root's Close — the run's canonical outcome. */
function isRootOutcome(event: DurableEvent): boolean {
  return event.type === "close" && event.coroutineId === ROOT_COROUTINE;
}
