/**
 * Opening one run on its owner: finding it, or creating it exactly once.
 *
 * The Durable Object *is* the run's storage, so "where is this run" has already
 * been answered by the time a command arrives — routing chose the object. What
 * is left is the same question the local provider asks of a file: is there a
 * run here, is it this run, and if there is none may this request start one.
 *
 * Creation is lookup-or-create, and the identity that decides is the run's
 * immutable identity alone: its id, its definition, its base and its normalized
 * props. Status, timestamps, executions, roots, mappings, answers, retrieval
 * and journal history are things a run *has*, not things it *is*, and a
 * creation that differed only in those would be the same run asked for twice.
 *
 * Everything happens inside one owner transaction. A creation that fails leaves
 * either no run at all or the whole run that was already committed: there is no
 * state in which an empty candidate exists for inspection to mistake for a run.
 */

import { canonicalJson } from "../storage/record.ts";
import { definitionToJson } from "../storage/definition.ts";
import { conflictingFields } from "../storage/compatibility.ts";
import type { CreateWorkflowRunRequest } from "../storage/api.ts";
import { readRunRecord } from "../sqlite/rows.ts";
import { EMPTY_WORKSPACE_MANIFEST, WORKSPACE_ROOT_DOMAIN } from "../workspace/root-manifest.ts";
import { WORKSPACE_ROOT_FORMAT } from "../workspace/root-manifest.ts";
import { sha256Hex } from "./encoding.ts";
import { CommandError } from "./commands.ts";
import { declaredObjects, initializeObject, recognizeObject } from "./recognition.ts";
import type { OwnerStorage } from "./storage.ts";
import type { OwnerTransactions } from "./owner-transaction.ts";
import { readFrontier, type FrontierValue } from "./owner-reads.ts";

const INSERT_RUN = `INSERT INTO workflow_run
  (id, run_id, definition, base, props, status, created_at, updated_at)
  VALUES (1, ?, ?, ?, ?, 'running', ?, ?)`;

/**
 * What opening answered: the run, or which immutable fields say it is another.
 *
 * A conflict is an answer rather than a refusal because it carries something a
 * refusal category cannot. Exactly one member is present.
 */
export interface OpenedValue {
  readonly conflict: readonly string[] | null;
  readonly frontier: FrontierValue | null;
}

/** The root every run starts from, by the identity its bytes produce. */
export function emptyWorkspaceRootId(): string {
  return sha256Hex(`${WORKSPACE_ROOT_DOMAIN}${EMPTY_WORKSPACE_MANIFEST}`);
}

/**
 * Refuse a store that holds a different run, before anything else is read.
 *
 * The record is parsed by the reader the rest of this build uses, so a row
 * that cannot be read is damage and says so; one that reads and names another
 * run is this owner answering about somebody else's.
 */
function requireRetainedRun(storage: OwnerStorage, runId: string): void {
  const rows = storage.sql
    .exec(
      `SELECT run_id, definition, base, props, status,
              stop_reason_kind, stop_reason_code, stop_reason_event_id,
              created_at, updated_at FROM workflow_run`,
    )
    .toArray();
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    // Not a run at all. The frontier read reports what is wrong with it.
    return;
  }
  if (readRunRecord(row).runId !== runId) {
    throw new CommandError("wrong-run");
  }
}

/** Whether this object holds nothing at all yet. */
function pristine(storage: OwnerStorage): boolean {
  return declaredObjects(storage).length === 0;
}

/**
 * The run this owner holds, or why it holds none this request may use.
 *
 * `creation` absent is a lookup: it creates nothing, and pristine storage is
 * an absent run rather than a foreign one — nothing was ever written here, and
 * saying "foreign" would send a host looking for someone else's data.
 */
export function openRun(
  storage: OwnerStorage,
  transactions: OwnerTransactions,
  runId: string,
  creation: CreateWorkflowRunRequest | null,
  now: () => string,
): OpenedValue {
  if (pristine(storage)) {
    if (creation === null) {
      throw new CommandError("absent");
    }
    const stamp = now();
    initializeObject(storage, transactions, () => {
      storage.sql.exec(
        INSERT_RUN,
        creation.runId,
        canonicalJson(definitionToJson(creation.definition)),
        creation.base,
        canonicalJson(creation.props),
        stamp,
        stamp,
      );
      // The Workspace every run starts from, and the pointer that selects it.
      // Written here rather than by a later command: a run whose current root
      // named nothing would be a run no execution could begin against.
      const rootId = emptyWorkspaceRootId();
      storage.sql.exec(
        "INSERT INTO workspace_roots (root_id, format_version, manifest) VALUES (?, ?, ?)",
        rootId,
        WORKSPACE_ROOT_FORMAT,
        EMPTY_WORKSPACE_MANIFEST,
      );
      storage.sql.exec(
        "INSERT INTO workspace_state (singleton_id, current_root_id) VALUES (1, ?)",
        rootId,
      );
    });
    return { conflict: null, frontier: readFrontier(storage, creation.runId) };
  }

  // Not pristine, so it is held to the schema this build writes before any of
  // it is read. A foreign, damaged or newer store refuses as itself.
  recognizeObject(storage);
  // Asked before the frontier, and only here. An intact store holding another
  // run is not damage — the records parse, the references hold, and it is
  // simply not this run. Every read *inside* an open run still treats a
  // mismatch as damage, because by then the run has already been addressed and
  // a record that changed identity underneath it is a different fact.
  requireRetainedRun(storage, runId);
  const frontier = readFrontier(storage, runId);
  if (creation === null) {
    return { conflict: null, frontier };
  }
  const differing = conflictingFields(frontier.record, creation);
  if (differing.length > 0) {
    // The same id wearing a different identity. Nothing is written, the run
    // that is here stays exactly as it was, and what travels back is which
    // fields differ — never what they differ to, which is the run's content.
    return { conflict: differing, frontier: null };
  }
  return { conflict: null, frontier };
}
