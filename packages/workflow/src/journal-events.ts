/**
 * The two events a fork writes for itself, recognized by shape.
 *
 * A fork inherits a prefix of its source's journal, but not the source's own
 * identity and not the import of the document the source was run from — it has
 * its own of each. Telling those two rows apart from everything else is a
 * property of the event, so it is stated here rather than wherever a prefix
 * happens to be selected.
 *
 * Separate from `fork.ts` because both hosts need it and the owner cannot
 * reach that module: selecting a fork's source on a Durable Object must not
 * drag in forkability classification and everything it imports.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { describeWorkflowRun, WORKFLOW_RUN } from "./journal.ts";

const ROOT_COROUTINE = "root";
const IMPORT_COMPONENT = "import_component";
const ROOT_DOCUMENT = "__root__";

/** Whether this event is the import of the run's root document. */
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

/**
 * The record a fork writes at position zero, exactly as its own execution would
 * have written it.
 *
 * Composed here rather than in a host, so the value a fork is admitted with,
 * the value its destination owner validates, and the value its first execution
 * replays are the same shape by construction.
 */
export function forkRunRecordEvent(run: {
  readonly runId: string;
  readonly base: string;
  readonly pinnedCommit: string;
}): DurableEvent {
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
