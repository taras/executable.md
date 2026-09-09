/**
 * What a lifecycle transition decides, apart from where the rows live.
 *
 * Both hosts store a run's lifecycle in the same schema and must reach the same
 * conclusions about it: whether a caller may continue, what a dead executor's
 * unfinished execution became, and whether beginning publishes `running` or
 * leaves an outcome that already won alone. Where those rows are read from is
 * the host's business — a local SQLite file, or a Durable Object on the other
 * end of a connection — but the conclusions are not, and two copies of them
 * would eventually disagree about what a run is.
 *
 * So the decisions live here, as functions over values. Nothing in this module
 * reads or writes anything.
 */

import type { DurableEvent } from "@executablemd/durable-streams";
import { WorkflowRequestError } from "../storage/errors.ts";
import type {
  DocumentExecutionCompletion,
  WorkflowRunStatus,
  WorkflowStopReason,
} from "../storage/record.ts";
import type { JournalEntry } from "../storage/api.ts";

/** An outcome that already won. A run in one of these is not made mutable again. */
export function terminal(status: WorkflowRunStatus): boolean {
  return status === "completed" || status === "failed";
}

/** What a run says when its executor went without saying anything. */
export const INTERRUPTED: DocumentExecutionCompletion["reason"] = Object.freeze({
  kind: "host",
  code: "executor-interrupted",
});

/**
 * The canonical outcome the root recorded, when it recorded one.
 *
 * A root Close is what proves the document itself finished. Its result decides
 * the run's terminal status, and its own event identity is the reason.
 */
export function rootOutcome(
  entries: readonly JournalEntry[],
): { status: WorkflowRunStatus; reason: DocumentExecutionCompletion["reason"] } | undefined {
  for (const entry of entries) {
    const event: DurableEvent = entry.event;
    if (event.type !== "close" || event.coroutineId !== "root") {
      continue;
    }
    if (event.result.status === "ok") {
      return { status: "completed", reason: undefined };
    }
    return {
      status: event.result.status === "cancelled" ? "cancelled" : "failed",
      reason: { kind: "journal", eventId: entry.eventId },
    };
  }
  return undefined;
}

/**
 * Whether the two accounts of why this run stopped are the same account.
 *
 * A reason that names an event names the exact retained row; one that names
 * none leaves the run with none.
 */
function sameReason(
  retained: DocumentExecutionCompletion["reason"],
  canonical: DocumentExecutionCompletion["reason"],
): boolean {
  if (canonical === undefined || retained === undefined) {
    return canonical === retained;
  }
  return (
    canonical.kind === "journal" &&
    retained.kind === "journal" &&
    canonical.eventId === retained.eventId
  );
}

/** Whether the root's recorded result says the document itself failed. */
function documentFailed(entries: readonly JournalEntry[]): boolean {
  for (const entry of entries) {
    const event: DurableEvent = entry.event;
    if (event.type !== "close" || event.coroutineId !== "root") {
      continue;
    }
    if (event.result.status !== "ok") {
      return true;
    }
    const value: unknown = event.result.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return Reflect.get(value, "status") === "err";
  }
  return false;
}

/** Whether a reason a settlement chose is one this run's history can carry. */
function retainedReason(
  reason: DocumentExecutionCompletion["reason"],
  entries: readonly JournalEntry[],
): boolean {
  if (reason === undefined) {
    return false;
  }
  return reason.kind === "host" || entries.some((entry) => entry.eventId === reason.eventId);
}

/**
 * Whether a run in this state is one this retained history can have produced.
 *
 * Two authorities publish a terminal for one root Close, and they do not always
 * publish the same one. `rootOutcome()` above is what *recovery* publishes: it
 * reads the coroutine's own settlement, so a document that returned a failure
 * closed successfully and recovers as `completed` with no reason. The executor
 * that ran the document settles from the document's own result instead, so the
 * same Close settles as `failed`, naming whichever retained row it failed at.
 *
 * Both are states this system produces and neither is damaged. What no settled
 * path produces is a run whose status contradicts the result its journal
 * records: a `failed` row over a document that succeeded, a terminal row over a
 * root that raised or was cancelled and says otherwise, or a reason naming
 * something the run does not hold. Those are two accounts of one run, and a
 * replay that reused either would be choosing between them.
 */
export function agreesWithRetainedResult(
  record: { readonly status: WorkflowRunStatus; readonly stopReason?: WorkflowStopReason },
  entries: readonly JournalEntry[],
): boolean {
  const canonical = rootOutcome(entries);
  if (canonical === undefined) {
    return false;
  }
  if (record.status === canonical.status) {
    return sameReason(record.stopReason, canonical.reason);
  }
  // The other authority. It differs from recovery in exactly one place — a
  // document that returned a failure — and it is the executor that watched it
  // do so, so its reason is one it chose rather than one this can derive.
  if (record.status !== "failed" || canonical.status !== "completed") {
    return false;
  }
  return documentFailed(entries) && retainedReason(record.stopReason, entries);
}

/** What closing a dead executor's execution makes of it, and of the run. */
export interface Closing {
  readonly status: WorkflowRunStatus;
  readonly reason: DocumentExecutionCompletion["reason"];
  /** Whether the run's own status follows the execution's, or stays as it is. */
  readonly publishes: boolean;
}

/**
 * What an unfinished execution becomes, on the evidence the run itself holds.
 *
 * A replay whose terminal state was preserved closes only its own execution:
 * the authoritative outcome stays exactly as it was. Otherwise a retained root
 * Close proves the canonical outcome won, and without one the executor was
 * interrupted.
 */
export function closingOutcome(
  storedStatus: WorkflowRunStatus,
  canonical:
    | { status: WorkflowRunStatus; reason: DocumentExecutionCompletion["reason"] }
    | undefined,
): Closing {
  if (terminal(storedStatus)) {
    return { status: "interrupted", reason: INTERRUPTED, publishes: false };
  }
  if (canonical !== undefined) {
    return { status: canonical.status, reason: canonical.reason, publishes: true };
  }
  return { status: "interrupted", reason: INTERRUPTED, publishes: true };
}

/**
 * Why this caller may not continue, or nothing when it may.
 *
 * A run nobody has begun admits either action. A failed or cancelled run is not
 * resumed, and a cancelled run is not advanced at all — both report what is
 * retained rather than moving it.
 */
export function admissionRefusal(
  action: "start" | "resume",
  status: WorkflowRunStatus | undefined,
): Error | undefined {
  if (status === undefined) {
    return undefined;
  }
  if (action === "resume" && (status === "failed" || status === "cancelled")) {
    return new WorkflowRequestError(
      `workflow run ${status}: a run that ${
        status === "failed" ? "failed" : "was cancelled"
      } is not resumed. The run is left exactly as it is.`,
    );
  }
  if (status === "cancelled") {
    return new WorkflowRequestError(
      "workflow run cancelled: a cancelled run reports its retained state and is not advanced.",
    );
  }
  return undefined;
}

/** What beginning does, given what recovery left behind. */
export type BeginDecision =
  /** Nothing was there: this begin creates the run and its first execution. */
  | { readonly kind: "create" }
  /** An outcome already won: record the execution and leave the status alone. */
  | { readonly kind: "replay" }
  /** An ordinary continuation: record the execution and publish `running`. */
  | { readonly kind: "running" };

export function beginDecision(recoveredStatus: WorkflowRunStatus | undefined): BeginDecision {
  if (recoveredStatus === undefined) {
    return { kind: "create" };
  }
  return terminal(recoveredStatus) ? { kind: "replay" } : { kind: "running" };
}
