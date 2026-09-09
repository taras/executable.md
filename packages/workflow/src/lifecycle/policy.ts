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
 * The one categorical word a failed run has when its journal holds no row that
 * says why.
 *
 * A run that failed always names a reason. Usually that is the exact retained
 * row it failed at; a failure the journal has no row for — one raised outside
 * any durable operation — has this instead, and nothing else. It is a code
 * rather than a message because the alternative is retaining an exception's
 * text beside the journal that filtered it.
 */
export const DOCUMENT_FAILED = "document-execution-failed";

/**
 * Why a failed run stopped, from the history it holds.
 *
 * The last retained row that failed, and this rule is the whole of it. The
 * runner settling a live document, the recovery reading a dead one's journal
 * and the admission holding a retained history to its lifecycle row all reach
 * it here, because a reason chosen three ways would be three explanations of
 * one failure.
 */
export function retainedFailureReason(entries: readonly JournalEntry[]): WorkflowStopReason {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.event.result.status === "err") {
      return { kind: "journal", eventId: entry.eventId };
    }
  }
  return { kind: "host", code: DOCUMENT_FAILED };
}

/**
 * What the root recorded, as one semantic outcome.
 *
 * A durable `Close` has two layers and both are load-bearing. The outer one is
 * the coroutine's own settlement: it raised, it was cancelled, or it *returned*
 * — and returning is what a document does whether it succeeded or failed. So an
 * outer `ok` says only that the value beneath it is the document's own result,
 * and that result's `status` is what decides whether the run completed or
 * failed. Reading the outer layer alone calls every finished document a
 * completed one.
 *
 * A returned value that is not a document result at all is neither: it is a
 * terminal this build cannot read, and answering `completed` or `interrupted`
 * for it would be inventing an outcome for history nobody can account for.
 */
export type RetainedTerminal =
  | {
      readonly kind: "outcome";
      readonly status: WorkflowRunStatus;
      readonly reason: DocumentExecutionCompletion["reason"];
    }
  | { readonly kind: "damaged" };

export function rootOutcome(entries: readonly JournalEntry[]): RetainedTerminal | undefined {
  for (const entry of entries) {
    const event: DurableEvent = entry.event;
    if (event.type !== "close" || event.coroutineId !== "root") {
      continue;
    }
    if (event.result.status !== "ok") {
      return {
        kind: "outcome",
        status: event.result.status === "cancelled" ? "cancelled" : "failed",
        reason: { kind: "journal", eventId: entry.eventId },
      };
    }
    const document = readDocumentResult(event.result.value);
    if (document === undefined) {
      return { kind: "damaged" };
    }
    return document === "ok"
      ? { kind: "outcome", status: "completed", reason: undefined }
      : { kind: "outcome", status: "failed", reason: retainedFailureReason(entries) };
  }
  return undefined;
}

/**
 * The document result a returning root recorded, or nothing when it recorded
 * something else.
 *
 * The shape is canonical core's `DocumentResult` (`packages/core/src/execute.ts`)
 * and is parsed as the closed form it is: a success carries its rendered output
 * and the value the document produced, a failure carries the output it rendered
 * before it failed and the described failure itself, and a terminal core wrote
 * before importing anything carries the root it was about beside them. A record
 * missing a member, carrying one of the wrong type, or carrying a member this
 * form does not have is not a result to reuse.
 */
function readDocumentResult(value: unknown): "ok" | "err" | undefined {
  const result = plain(value);
  if (result === undefined || typeof result["output"] !== "string") {
    return undefined;
  }
  if (result["status"] === "ok") {
    return names(result, ["status", "output", "value"]) && "value" in result ? "ok" : undefined;
  }
  if (result["status"] !== "err") {
    return undefined;
  }
  if (!names(result, ["status", "output", "error", ROOT_BINDING])) {
    return undefined;
  }
  return readDocumentFailure(result["error"]) ? "err" : undefined;
}

/** Where core records which document a terminal it wrote before importing was about. */
const ROOT_BINDING = "root_binding";

/** Whether a described failure is the closed form core writes. */
function readDocumentFailure(value: unknown): boolean {
  const failure = plain(value);
  if (
    failure === undefined ||
    typeof failure["name"] !== "string" ||
    typeof failure["message"] !== "string" ||
    !names(failure, ["name", "message", "segment", "cause", "errors"])
  ) {
    return false;
  }
  const segment = plain(failure["segment"]);
  if (
    segment === undefined ||
    typeof segment["message"] !== "string" ||
    !names(segment, ["message", "source"]) ||
    ("source" in segment && typeof segment["source"] !== "string")
  ) {
    return false;
  }
  if ("cause" in failure && typeof failure["cause"] !== "string") {
    return false;
  }
  const errors = failure["errors"];
  if (errors === undefined) {
    return true;
  }
  return (
    Array.isArray(errors) &&
    errors.every((entry) => {
      const described = plain(entry);
      return (
        described !== undefined &&
        typeof described["name"] === "string" &&
        typeof described["message"] === "string" &&
        names(described, ["name", "message"])
      );
    })
  );
}

/** A retained value that is an ordinary object, read once through its own names. */
function plain(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const held: Record<string, unknown> = {};
  for (const name of Object.keys(value)) {
    held[name] = Reflect.get(value, name);
  }
  return held;
}

/** Whether a record carries only members this form declares. */
function names(record: Record<string, unknown>, declared: readonly string[]): boolean {
  return Object.keys(record).every((name) => declared.includes(name));
}

/**
 * Whether the two accounts of why this run stopped are the same account.
 *
 * A reason that names an event names the exact retained row, a categorical one
 * carries the same word, and one that names nothing leaves the run with
 * nothing. An unrelated row, the wrong row, an invented code and a missing
 * reason are each a different explanation of the same failure.
 */
function sameReason(
  retained: DocumentExecutionCompletion["reason"],
  canonical: DocumentExecutionCompletion["reason"],
): boolean {
  if (canonical === undefined || retained === undefined) {
    return canonical === retained;
  }
  if (canonical.kind === "journal") {
    return retained.kind === "journal" && retained.eventId === canonical.eventId;
  }
  return retained.kind === "host" && retained.code === canonical.code;
}

/**
 * Whether a run in this state is the run this retained history produced.
 *
 * One execution has one winning outcome, and `rootOutcome()` above is it.
 * Settlement and stale recovery are two ways of publishing that same semantic
 * result, not two authorities allowed to disagree — so a lifecycle row saying
 * anything else is a second account of one run, and a replay that reused either
 * would be choosing between them.
 */
export function agreesWithRetainedResult(
  record: { readonly status: WorkflowRunStatus; readonly stopReason?: WorkflowStopReason },
  canonical: RetainedTerminal,
): boolean {
  return (
    canonical.kind === "outcome" &&
    record.status === canonical.status &&
    sameReason(record.stopReason, canonical.reason)
  );
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
 * interrupted. A root Close this build cannot read is neither: it proves the
 * document finished, so the run is not made interrupted, and it says nothing
 * this can publish.
 */
export function closingOutcome(
  storedStatus: WorkflowRunStatus,
  canonical: RetainedTerminal | undefined,
): Closing {
  if (terminal(storedStatus)) {
    return { status: "interrupted", reason: INTERRUPTED, publishes: false };
  }
  if (canonical === undefined) {
    return { status: "interrupted", reason: INTERRUPTED, publishes: true };
  }
  if (canonical.kind === "damaged") {
    // The document finished and this build cannot read what it finished as.
    // Calling that an interruption would say the executor went without saying
    // anything, which is the one thing this history rules out — so the dead
    // executor's execution closes and the run is left exactly as it is.
    return { status: "interrupted", reason: INTERRUPTED, publishes: false };
  }
  return { status: canonical.status, reason: canonical.reason, publishes: true };
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
