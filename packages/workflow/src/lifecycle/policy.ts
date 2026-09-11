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
import { recordedRootImport } from "@executablemd/core/host";
import type { SelectionOutcome } from "@executablemd/core/host";
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
  const frontier = terminalFrontier(entries);
  if (frontier.kind === "absent") {
    return undefined;
  }
  if (frontier.kind === "mixed") {
    // Two results, or work recorded after the one result: a history no single
    // execution produced. Choosing one of them would be this build deciding
    // which execution the run was.
    return { kind: "damaged" };
  }
  const event: DurableEvent = frontier.entry.event;
  if (event.type !== "close") {
    return { kind: "damaged" };
  }
  if (event.result.status !== "ok") {
    return {
      kind: "outcome",
      status: event.result.status === "cancelled" ? "cancelled" : "failed",
      reason: { kind: "journal", eventId: frontier.entry.eventId },
    };
  }
  const document = readDocumentResult(event.result.value);
  if (document === undefined) {
    return { kind: "damaged" };
  }
  // The terminal has to agree with the history around it. A binding is written
  // only by a run that failed before importing anything, so a history that
  // imported its root and then recorded one describes two different executions;
  // and an ordinary document result is what a run produces *after* importing,
  // so one recorded with no import behind it describes a document nothing
  // named. Neither is a history any execution can produce, and reading the
  // terminal alone cannot tell either of them apart from the real thing.
  const imported = rootImports(entries);
  if (document.kind === "bound") {
    return imported.kind === "none" ? boundOutcome(entries) : { kind: "damaged" };
  }
  if (imported.kind !== "one") {
    return { kind: "damaged" };
  }
  if (document.kind === "ok") {
    // The selection has to be able to lead to the result beside it. A recorded
    // selection failure is a document that never ran: canonical execution
    // raises it out of the root import, so the only terminal it can reach is a
    // failed one. A successful result over it is two histories, not one.
    return imported.selection.failed
      ? { kind: "damaged" }
      : { kind: "outcome", status: "completed", reason: undefined };
  }
  return { kind: "outcome", status: "failed", reason: retainedFailureReason(entries) };
}

/** The outcome a run that failed before importing anything recorded. */
function boundOutcome(entries: readonly JournalEntry[]): RetainedTerminal {
  return { kind: "outcome", status: "failed", reason: retainedFailureReason(entries) };
}

/**
 * The root import this history recorded, when it recorded exactly one.
 *
 * The root's own import is the entry every other record of the run hangs from,
 * and canonical core admits a terminal history only when one coroutine — this
 * one — recorded exactly one. Both the recovery that publishes an outcome from
 * a terminal and the admission that reuses one ask this, so neither can accept
 * a history the other refuses.
 */
export type RootImports =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly selection: RetainedRootSelection }
  /** More than one retained event names the root import. */
  | { readonly kind: "many" }
  /** One does, and it is not a root import this build can read. */
  | { readonly kind: "malformed" };

export function rootImports(entries: readonly JournalEntry[]): RootImports {
  // Every event that *names* the root import, whichever coroutine claims it.
  // Uniqueness is asked of the name, not of the ownership: a child coroutine
  // recording one is a second account of the run's own entry, and canonical
  // core refuses that history rather than looking past it.
  const imports = entries.filter((entry) => namesRootImport(entry.event));
  const only = imports[0];
  if (only === undefined) {
    return { kind: "none" };
  }
  if (imports.length !== 1 || only.event.coroutineId !== ROOT_COROUTINE) {
    return imports.length === 1 ? { kind: "malformed" } : { kind: "many" };
  }
  const selection = rootSelection(only.event);
  return selection === undefined ? { kind: "malformed" } : { kind: "one", selection };
}

function namesRootImport(event: DurableEvent): boolean {
  return (
    event.type === "yield" &&
    event.description.type === "import_component" &&
    event.description.name === ROOT_COMPONENT
  );
}

/**
 * The document one retained root import selected, as its own record holds it.
 *
 * Enough of the parsed record to make the same request again, and no more: the
 * document itself, the selector it was asked with, and whether that selector
 * named a target at all. What proved the record — the outline it was verified
 * against — stays with the parser.
 */
export interface RetainedRootSelection {
  readonly path: string;
  readonly content: string;
  /**
   * The selector to replay the run's request with: the exact target it ran, or
   * the selector whose failure it recorded. Absent for a whole document.
   */
  readonly target: string | undefined;
  /** Whether the recorded selection is one that named no single target. */
  readonly failed: boolean;
}

/**
 * The selection one retained root import recorded, read the way canonical
 * execution reads it.
 *
 * Not read here at all, in fact: `recordedRootImport()` is the parser canonical
 * `admitRootSelection()` admits a partial history through, and this asks it the
 * same question about the same event. A record it calls malformed is malformed
 * for the lifecycle too, so an unparseable document, a target the retained
 * document does not offer, a noncanonical target, and a failure record the same
 * selector would not re-derive cannot publish an outcome here after the
 * executor refused them there.
 *
 * What comes back is that parser's own copy of the record, so the document a
 * replay is built from is never the object the journal still holds.
 */
function rootSelection(event: DurableEvent): RetainedRootSelection | undefined {
  if (event.type !== "yield") {
    return undefined;
  }
  const recorded = recordedRootImport(event);
  if (recorded.kind !== "read") {
    return undefined;
  }
  return {
    path: recorded.path,
    content: recorded.content,
    target: selector(recorded.selection),
    failed: recorded.selection.kind === "failed",
  };
}

/**
 * What a replay asks for to make the same request again.
 *
 * A recorded failure hands back the selector rather than nothing: canonical
 * execution resolves it against the same retained document, finds the same
 * failure, and fails the same way. Handing back nothing would ask for the whole
 * document instead — a different request that would succeed.
 */
function selector(selection: SelectionOutcome): string | undefined {
  switch (selection.kind) {
    case "whole":
      return undefined;
    case "exact":
      return selection.target;
    case "failed":
      return selection.failure.selector;
  }
}

export function preRootSelection(
  entries: readonly JournalEntry[],
): RetainedRootSelection | undefined {
  const frontier = terminalFrontier(entries);
  if (frontier.kind !== "final") {
    return undefined;
  }
  const settlement = plain(frontier.entry.event.result);
  const result = plain(settlement?.["value"]);
  const binding = plain(result?.[ROOT_BINDING]);
  if (binding === undefined) {
    return undefined;
  }
  const path = binding["path"];
  const source = binding["source"];
  const target = binding["target"];
  if (typeof path !== "string" || typeof source !== "string") {
    return undefined;
  }
  return {
    path,
    content: source,
    target: typeof target === "string" ? target : undefined,
    // A binding is what a run that failed *before* importing recorded, so it
    // holds the document it was asked for rather than the outcome of selecting
    // in it. There is no recorded selection failure to disagree with.
    failed: false,
  };
}

/** The coroutine a document execution's own records belong to. */
const ROOT_COROUTINE = "root";

/** The name canonical execution records the run's own document import under. */
const ROOT_COMPONENT = "__root__";

/**
 * Where the root's terminal sits in a history, when it sits anywhere.
 *
 * One execution records one result, and records it last. A history holding two,
 * or holding anything after the one it stands behind, is not one execution's —
 * and reading it as though the first of them were authoritative is how a
 * lifecycle row comes to be published from history nobody can account for. Both
 * the recovery that publishes an outcome and the admission that reuses one ask
 * this, so neither can decide the question the other way.
 */
export type TerminalFrontier =
  | { readonly kind: "absent" }
  | { readonly kind: "mixed" }
  | { readonly kind: "final"; readonly entry: JournalEntry };

export function terminalFrontier(entries: readonly JournalEntry[]): TerminalFrontier {
  const closes = entries.filter(
    (entry) => entry.event.type === "close" && entry.event.coroutineId === "root",
  );
  const only = closes[0];
  if (only === undefined) {
    return { kind: "absent" };
  }
  return closes.length === 1 && entries[entries.length - 1] === only
    ? { kind: "final", entry: only }
    : { kind: "mixed" };
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
function readDocumentResult(value: unknown): { kind: "ok" | "err" | "bound" } | undefined {
  const result = plain(value);
  if (result === undefined || typeof result["output"] !== "string") {
    return undefined;
  }
  if (result["status"] === "ok") {
    return names(result, ["status", "output", "value"]) && "value" in result
      ? { kind: "ok" }
      : undefined;
  }
  if (result["status"] !== "err") {
    return undefined;
  }
  if (ROOT_BINDING in result) {
    // A binding is not decoration a failure may carry. Core writes one in
    // exactly one situation — it failed before importing anything — and the
    // whole form is what makes that import-free history attributable to one
    // document at all. Anything else wearing a binding is a terminal core did
    // not write.
    return readPreRootTerminal(result) ? { kind: "bound" } : undefined;
  }
  return names(result, ["status", "output", "error"]) && readDocumentFailure(result["error"])
    ? { kind: "err" }
    : undefined;
}

/** Where core records which document a terminal it wrote before importing was about. */
const ROOT_BINDING = "root_binding";

/**
 * Whether a failure carrying a binding is the exact terminal core writes before
 * it has imported anything.
 *
 * The form is `recordedPreRootTerminal()`'s in `packages/core/src/execute.ts`,
 * and every part of it is load-bearing: nothing was rendered, so the output is
 * empty; no segment failed, so the description repeats the failure's own
 * message and says nothing else; and the binding names the document — its path,
 * the supplied text for an inline root and nothing for a file one, and the
 * selector as written — which is the only thing making a history with no root
 * import about one document rather than any.
 */
function readPreRootTerminal(result: Record<string, unknown>): boolean {
  if (!names(result, ["status", "output", "error", ROOT_BINDING]) || result["output"] !== "") {
    return false;
  }
  const failure = plain(result["error"]);
  if (
    failure === undefined ||
    !names(failure, ["name", "message", "segment", "cause"]) ||
    typeof failure["name"] !== "string" ||
    typeof failure["message"] !== "string" ||
    ("cause" in failure && typeof failure["cause"] !== "string")
  ) {
    return false;
  }
  const segment = plain(failure["segment"]);
  if (
    segment === undefined ||
    !names(segment, ["message"]) ||
    segment["message"] !== failure["message"]
  ) {
    return false;
  }
  const binding = plain(result[ROOT_BINDING]);
  if (binding === undefined || !names(binding, ["path", "source", "target"])) {
    return false;
  }
  const path = binding["path"];
  const source = binding["source"];
  const target = binding["target"];
  return (
    typeof path === "string" &&
    (source === null || typeof source === "string") &&
    (target === null || typeof target === "string") &&
    "source" in binding &&
    "target" in binding
  );
}

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
  /**
   * Whether this run's own terminal is one this build cannot read.
   *
   * Distinct from "nothing to publish", and the distinction is the whole point:
   * a run with nothing to publish is one to go on with, and this is a run whose
   * document already ended in a way nothing here can account for. Losing it
   * between recovery and the caller is how an unreadable terminal came to
   * authorize a second execution.
   */
  readonly damaged: boolean;
}

/**
 * What an unfinished execution becomes, on the evidence the run itself holds.
 *
 * A replay whose terminal state was preserved closes only its own execution:
 * the authoritative outcome stays exactly as it was. Otherwise a retained root
 * Close proves the canonical outcome won, and without one the executor was
 * interrupted. A root Close this build cannot read is none of those: it proves
 * the document finished, so nothing about the run or the execution it left is
 * decided here, and the caller is refused instead.
 */
export function closingOutcome(
  storedStatus: WorkflowRunStatus,
  canonical: RetainedTerminal | undefined,
): Closing {
  // Damage first, and before the stored status is consulted at all. A run whose
  // row already says `completed` is not a run whose journal is therefore safe:
  // the two accounts have to agree before either is reused, and a row cannot
  // vouch for history nothing can read.
  if (canonical?.kind === "damaged") {
    // The document finished and this build cannot read what it finished as.
    // Calling that an interruption would say the executor went without saying
    // anything, which is the one thing this history rules out; closing its
    // execution would say the same about the execution. So nothing here is
    // decided at all, and the caller is told why.
    return { status: storedStatus, reason: undefined, publishes: false, damaged: true };
  }
  if (terminal(storedStatus)) {
    return { status: "interrupted", reason: INTERRUPTED, publishes: false, damaged: false };
  }
  if (canonical === undefined) {
    return { status: "interrupted", reason: INTERRUPTED, publishes: true, damaged: false };
  }
  return { status: canonical.status, reason: canonical.reason, publishes: true, damaged: false };
}

/**
 * What a caller is told when the run it named holds a terminal nothing can read.
 *
 * One sentence, shared by every provider and every action, and carrying nothing
 * the history held: what is unreadable is retained data, and a diagnostic that
 * quoted it would publish exactly what it exists to refuse.
 */
export function damagedTerminalRefusal(): WorkflowRequestError {
  return new WorkflowRequestError(
    "workflow run: its root recorded a document result this version cannot read, so the run " +
      "is neither advanced nor changed. The run is left exactly as it is.",
  );
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
