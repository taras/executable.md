/**
 * The run's lifecycle, as its owner keeps it.
 *
 * Beginning, settling and cancelling are the three moments a run's own state
 * changes, and each is one owner transaction: what a dead executor's unfinished
 * execution became, whether this caller may continue, and the execution this
 * caller began all commit together or not at all. Splitting them would leave a
 * recovery published that a refusal then had to take back, or a window where
 * this executor's own execution looks like somebody else's leftovers.
 *
 * The decisions are not made here. `lifecycle/policy.ts` says what an
 * unfinished execution becomes, whether an action is admitted and what
 * beginning does; this module is where those conclusions meet rows. Both hosts
 * reach them through the same functions, so a run means the same thing
 * wherever it is stored.
 */

import {
  admissionRefusal,
  beginDecision,
  closingOutcome,
  rootOutcome,
  terminal,
} from "../lifecycle/policy.ts";
import { conflictingFields } from "../storage/compatibility.ts";
import { canonicalJson } from "../storage/record.ts";
import { definitionToJson } from "../storage/definition.ts";
import type {
  DocumentExecutionCompletion,
  DocumentExecutionRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from "../storage/record.ts";
import type { JournalEntry } from "../storage/api.ts";
import type { CreateWorkflowRunRequest } from "../storage/api.ts";
import { parseDurableEvent } from "@executablemd/durable-streams";
import { readDocumentExecution, readRunRecord, type Row } from "../sqlite/rows.ts";
import { CommandError } from "./commands.ts";
import type { OwnerStorage } from "./storage.ts";
import type { OwnerTransaction } from "./owner-transaction.ts";
import { establishRun } from "./owner-open.ts";
import { readFrontier, type FrontierValue } from "./owner-reads.ts";
import { heldExecution, holdExecution, releaseExecution } from "./private-schema.ts";

const RUN_COLUMNS = `run_id, definition, base, props, status,
  stop_reason_kind, stop_reason_code, stop_reason_event_id, created_at, updated_at`;

const EXECUTION_COLUMNS = `execution_id, started_at, stopped_at, stop_status,
  stop_reason_kind, stop_reason_code, stop_reason_event_id`;

/**
 * Why a lifecycle transition would not proceed.
 *
 * A closed set of categories rather than refusal spellings, because each is a
 * fact about the run that a caller acts on, and each maps to an error the
 * provider-neutral vocabulary already has. What the run holds — its props, its
 * definition, its history — never travels with one.
 */
export type LifecycleRefusal =
  /** Resume reached a run that failed. */
  | "resume-failed"
  /** Resume or start reached a run that was cancelled. */
  | "cancelled"
  /** Cancellation reached a run whose outcome already won. */
  | "terminal";

/** What one begin committed, as the runner is allowed to know it. */
export interface BegunValue {
  readonly frontier: FrontierValue;
  readonly execution: DocumentExecutionRecord;
  readonly replay: boolean;
  /** What recovery closed on the way in, when it closed anything. */
  readonly recovered: DocumentExecutionRecord | null;
}

/**
 * One lifecycle answer: what it did, or why it would not.
 *
 * Exactly one member is present. A refusal is an answer rather than a protocol
 * refusal because it carries which condition applied, and because the recovery
 * it may have committed on the way in stands either way.
 */
export interface LifecycleValue<T> {
  readonly conflict: readonly string[] | null;
  readonly refusal: LifecycleRefusal | null;
  readonly value: T | null;
}

function rows(storage: OwnerStorage, sql: string, ...bindings: unknown[]): Row[] {
  return storage.sql.exec(sql, ...bindings).toArray();
}

function storedRun(storage: OwnerStorage): WorkflowRunRecord {
  const row = rows(storage, `SELECT ${RUN_COLUMNS} FROM workflow_run`)[0];
  if (row === undefined) {
    throw new CommandError("absent");
  }
  return readRunRecord(row);
}

function unfinished(storage: OwnerStorage): DocumentExecutionRecord[] {
  return rows(
    storage,
    `SELECT ${EXECUTION_COLUMNS} FROM document_executions
       WHERE stopped_at IS NULL ORDER BY sequence`,
  ).map((row) => readDocumentExecution(row));
}

function journalEntries(storage: OwnerStorage): JournalEntry[] {
  return rows(
    storage,
    "SELECT event_id, record, workspace_root_id FROM journal_events ORDER BY sequence",
  ).map((row) => {
    const parsed = parseDurableEvent(String(row["record"]));
    if (!parsed.ok) {
      // Retained history this owner cannot read. Deciding an outcome from a
      // journal it cannot parse would be deciding from nothing.
      throw new CommandError("corrupt-journal");
    }
    return {
      eventId: String(row["event_id"]),
      event: parsed.value,
      workspaceRootId: String(row["workspace_root_id"]),
    };
  });
}

function readExecution(storage: OwnerStorage, executionId: string): DocumentExecutionRecord {
  const row = rows(
    storage,
    `SELECT ${EXECUTION_COLUMNS} FROM document_executions WHERE execution_id = ?`,
    executionId,
  )[0];
  if (row === undefined) {
    throw new CommandError("malformed-member");
  }
  return readDocumentExecution(row);
}

function finish(
  storage: OwnerStorage,
  completion: {
    executionId: string;
    status: WorkflowRunStatus;
    reason: DocumentExecutionCompletion["reason"];
  },
  now: () => string,
): void {
  const reason = completion.reason;
  storage.sql.exec(
    `UPDATE document_executions
        SET stopped_at = ?, stop_status = ?, stop_reason_kind = ?,
            stop_reason_code = ?, stop_reason_event_id = ?
      WHERE execution_id = ? AND stopped_at IS NULL`,
    now(),
    completion.status,
    reason?.kind ?? null,
    reason?.kind === "host" ? reason.code : null,
    reason?.kind === "journal" ? reason.eventId : null,
    completion.executionId,
  );
}

function publish(
  storage: OwnerStorage,
  status: WorkflowRunStatus,
  reason: DocumentExecutionCompletion["reason"],
  now: () => string,
): void {
  storage.sql.exec(
    `UPDATE workflow_run
        SET status = ?, stop_reason_kind = ?, stop_reason_code = ?,
            stop_reason_event_id = ?, updated_at = ?
      WHERE id = 1`,
    status,
    reason?.kind ?? null,
    reason?.kind === "host" ? reason.code : null,
    reason?.kind === "journal" ? reason.eventId : null,
    now(),
  );
}

function insertExecution(
  storage: OwnerStorage,
  executionId: string,
  now: () => string,
): DocumentExecutionRecord {
  storage.sql.exec(
    "INSERT INTO document_executions (execution_id, started_at) VALUES (?, ?)",
    executionId,
    now(),
  );
  return readExecution(storage, executionId);
}

/**
 * Close whatever the previous executor left, on the run's own evidence.
 *
 * Reached only when this caller holds the acquisition and has begun nothing of
 * its own, so an unfinished execution is proven stale by the connection that
 * owned it being gone — never by elapsed time.
 */
function reconcile(
  storage: OwnerStorage,
  stored: WorkflowRunRecord,
  now: () => string,
): { status: WorkflowRunStatus; recovered: DocumentExecutionRecord | null } {
  const open = unfinished(storage);
  if (open.length === 0) {
    return { status: stored.status, recovered: null };
  }
  const closing = closingOutcome(stored.status, rootOutcome(journalEntries(storage)));
  let last: DocumentExecutionRecord | null = null;
  for (const execution of open) {
    finish(
      storage,
      { executionId: execution.executionId, status: closing.status, reason: closing.reason },
      now,
    );
    last = readExecution(storage, execution.executionId);
  }
  if (!closing.publishes) {
    return { status: stored.status, recovered: last };
  }
  publish(storage, closing.status, closing.reason, now);
  return { status: closing.status, recovered: last };
}

/**
 * Begin one document execution, in one transaction.
 *
 * Recovery decides what the previous executor's execution became, admission
 * decides whether this caller may continue, and an admitted caller's execution
 * is inserted — all or none.
 */
export function beginRun(
  storage: OwnerStorage,
  transaction: OwnerTransaction,
  acquisitionId: string,
  runId: string,
  action: "start" | "resume",
  creation: CreateWorkflowRunRequest | null,
  executionId: string,
  now: () => string,
): LifecycleValue<BegunValue> {
  if (action === "start" && creation !== null) {
    // Creating and beginning are one commit — this runs inside the caller's
    // transaction — so a reader observes the whole begun run or no run at all,
    // never an initialized candidate with no execution.
    const opened = establishRun(storage, transaction, runId, creation, now);
    if (opened !== null) {
      return { conflict: opened, refusal: null, value: null };
    }
  }

  return (() => {
    if (heldExecution(storage, acquisitionId) !== undefined) {
      // One acquisition begins one execution. Its own unfinished execution is
      // not somebody else's leftovers, so this is refused rather than
      // recovered. Asked once the store is known to exist, because a store
      // that holds nothing holds no acquisition either.
      throw new CommandError("duplicate-conflict");
    }
    const stored = storedRun(storage);
    if (stored.runId !== runId) {
      throw new CommandError("wrong-run");
    }
    if (creation !== null) {
      const differing = conflictingFields(stored, creation);
      if (differing.length > 0) {
        return { conflict: differing, refusal: null, value: null };
      }
    }

    const recovered = reconcile(storage, stored, now);
    // The recovery above stays committed whatever this decides: what the
    // previous executor's execution became is not undone by this caller being
    // told it may not continue.
    if (admissionRefusal(action, recovered.status) !== undefined) {
      return {
        conflict: null,
        refusal: recovered.status === "cancelled" ? "cancelled" : "resume-failed",
        value: null,
      };
    }

    const decision = beginDecision(recovered.status);
    const execution = insertExecution(storage, executionId, now);
    // Recorded here rather than only in the runner's hold: the owner is what a
    // settlement is checked against, and an evicted object keeps its sockets
    // but forgets everything that was not written down.
    holdExecution(storage, acquisitionId, executionId);
    if (decision.kind === "running") {
      publish(storage, "running", undefined, now);
    }
    return {
      conflict: null,
      refusal: null,
      value: {
        frontier: readFrontier(storage, runId),
        execution,
        replay: decision.kind === "replay",
        recovered: recovered.recovered,
      },
    };
  })();
}

/**
 * Finish the execution this acquisition began, and publish what it decided.
 *
 * The expected root is checked in the same transaction: a settlement built
 * against a Workspace the run has moved off describes an execution of
 * something else.
 */
export function settleRun(
  storage: OwnerStorage,
  acquisitionId: string,
  runId: string,
  completion: DocumentExecutionCompletion,
  expectedWorkspaceRootId: string,
  now: () => string,
): FrontierValue {
  return (() => {
    const stored = storedRun(storage);
    if (stored.runId !== runId) {
      throw new CommandError("wrong-run");
    }
    const current = rows(
      storage,
      "SELECT current_root_id FROM workspace_state WHERE singleton_id = 1",
    )[0];
    if (current === undefined || String(current["current_root_id"]) !== expectedWorkspaceRootId) {
      throw new CommandError("stale-root");
    }
    if (heldExecution(storage, acquisitionId) !== completion.executionId) {
      // Either this acquisition began nothing, or it began something else.
      // Naming an execution is not the same as having begun it.
      throw new CommandError("wrong-execution");
    }
    const execution = readExecution(storage, completion.executionId);
    if (execution.stoppedAt !== undefined) {
      // Already settled. Settling it again would replace an outcome that won.
      throw new CommandError("duplicate-conflict");
    }
    finish(
      storage,
      {
        executionId: completion.executionId,
        status: completion.status,
        reason: completion.reason,
      },
      now,
    );
    // A replay closes only its own envelope: the terminal outcome it observed
    // is not made mutable again.
    if (!terminal(stored.status)) {
      publish(storage, completion.status, completion.reason, now);
    }
    // Finished, so this acquisition holds no execution any more. It does not
    // get another: what it may do next is read, and let go.
    releaseExecution(storage, acquisitionId);
    return readFrontier(storage, runId);
  })();
}

/**
 * Make one run terminal, following what it retains.
 *
 * Takes no execution of its own. A stale execution is reconciled first, on the
 * same evidence a begin would use, so a document that finished before its
 * executor disappeared keeps the outcome it recorded.
 */
export function cancelRunOnOwner(
  storage: OwnerStorage,
  runId: string,
  now: () => string,
): LifecycleValue<FrontierValue> {
  return (() => {
    const stored = storedRun(storage);
    if (stored.runId !== runId) {
      throw new CommandError("wrong-run");
    }
    if (stored.status === "cancelled") {
      // Already what the caller asked for. Saying so twice is the same answer.
      return { conflict: null, refusal: null, value: readFrontier(storage, runId) };
    }
    if (terminal(stored.status)) {
      return { conflict: null, refusal: "terminal", value: null };
    }
    const recovered = reconcile(storage, stored, now);
    if (terminal(recovered.status) || recovered.status === "cancelled") {
      // The document finished before its executor disappeared. Restoring what
      // it recorded is not cancelling it.
      return { conflict: null, refusal: null, value: readFrontier(storage, runId) };
    }
    for (const execution of unfinished(storage)) {
      finish(
        storage,
        { executionId: execution.executionId, status: "cancelled", reason: undefined },
        now,
      );
    }
    publish(storage, "cancelled", undefined, now);
    return { conflict: null, refusal: null, value: readFrontier(storage, runId) };
  })();
}
