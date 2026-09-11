/**
 * What a run says about itself, when its storage is somewhere else.
 *
 * Reading is not advancing, so none of this takes the run's executor
 * acquisition: an inspection can be answered while an executor is live, and
 * asking one never makes a run unrunnable. Nothing here recovers a stale
 * execution, attaches a Workspace, materializes a root, imports a document,
 * contacts a provider or appends anything.
 *
 * The projection is done here rather than by the adapter. The owner returns
 * retained rows; what a history *means* — its authored source, its cumulative
 * forkability, its inherited provenance — is provider-neutral, and computing it
 * on the runner is what keeps one interpretation of a journal rather than one
 * per adapter.
 */

import { Err, Ok, type Operation, type Result } from "effection";
import { checkRunId } from "../storage/create-request.ts";
import { WorkflowRunIdMismatchError, WorkflowRunNotFoundError } from "../storage/errors.ts";
import { WorkflowLifecycle } from "../lifecycle/api.ts";
import type { WorkflowLifecycleSnapshot } from "../lifecycle/api.ts";
import { projectHistory, type WorkflowHistoryEntry } from "../lifecycle/history.ts";
import type { RemoteReadPlane, RetainedInspection } from "./read.ts";

/**
 * Install the read-only lifecycle operations over one owner's read plane.
 *
 * The plane is bound to one admitted owner, so the domain of `list()` is that
 * owner: zero snapshots when it holds no run, one when it does. That is a
 * complete answer to "every run this is bound to", and it claims nothing about
 * a namespace — there is no registry here and nothing to enumerate.
 */
export function useRemoteLifecycleReads(plane: RemoteReadPlane): Operation<void> {
  return WorkflowLifecycle.around(
    {
      *inspect([runId]): Operation<Result<WorkflowLifecycleSnapshot>> {
        const addressed = addressing(plane, runId);
        if (addressed !== undefined) {
          return addressed;
        }
        const read = yield* plane.inspect();
        return read.ok ? Ok(snapshotOf(read.value)) : read;
      },

      *list(): Operation<Result<readonly WorkflowLifecycleSnapshot[]>> {
        const read = yield* plane.inspect();
        if (read.ok) {
          return Ok(Object.freeze([snapshotOf(read.value)]));
        }
        // An owner holding no run at all lists nothing. Everything else — a
        // foreign, incompatible, damaged or unreadable owner — fails the whole
        // request, exactly as the local provider does: a shorter list is an
        // answer to a question nobody asked.
        return read.error instanceof WorkflowRunNotFoundError ? Ok(Object.freeze([])) : read;
      },

      *history([runId]): Operation<Result<readonly WorkflowHistoryEntry[]>> {
        const addressed = addressing(plane, runId);
        if (addressed !== undefined) {
          return addressed;
        }
        const read = yield* plane.history();
        if (!read.ok) {
          return read;
        }
        return Ok(
          projectHistory(read.value.entries, {
            retainedRoots: read.value.retainedRoots,
            inherited: read.value.inherited,
          }),
        );
      },
    },
    { at: "min" },
  );
}

/**
 * Why this request is not for this plane's run, or nothing when it is.
 *
 * Refused here, before the transport is reached, so a request naming another
 * run neither travels nor comes back with the bound run's answer. The bound id
 * is compared rather than trusted: it can only ever cause a refusal.
 */
function addressing(plane: RemoteReadPlane, runId: string): Result<never> | undefined {
  const checked = checkRunId(runId);
  if (!checked.ok) {
    return checked;
  }
  if (checked.value !== plane.runId) {
    return Err(new WorkflowRunIdMismatchError(checked.value, REMOTE_RUN));
  }
  return undefined;
}

/** How a remote run's storage is named in a public error. */
const REMOTE_RUN = "this run's remote storage";

/** The retained reading, as the public snapshot it projects to. */
function snapshotOf(read: RetainedInspection): WorkflowLifecycleSnapshot {
  return Object.freeze({
    record: read.record,
    executions: read.executions,
    ...(read.retrieval === undefined ? {} : { retrieval: read.retrieval }),
    ...(read.journalFrontier === undefined ? {} : { journalFrontier: read.journalFrontier }),
    currentWorkspaceRootId: read.currentWorkspaceRootId,
    ...(read.lineage === undefined ? {} : { lineage: read.lineage }),
  });
}
