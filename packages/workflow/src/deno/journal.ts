/**
 * The run's filtered journal, as rows.
 *
 * Events arrive here already filtered. The secret gate wraps the stream that
 * feeds this adapter, so an event that reaches these statements has crossed it,
 * and a rejected or cancelled gate never gets this far. Nothing here filters a
 * second time: a second policy in a second place is a second thing to keep in
 * agreement with the first.
 *
 * What is stored is exactly what `serializeDurableEvent` produced, terminating
 * newline included, so the record a replay reads is the record the protocol
 * wrote rather than a re-encoding of it. Identity and order are separate
 * columns: the event id is opaque and stable once written, and the sequence is
 * a physical position this module orders by and never hands out.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type DurableEvent,
  parseDurableEvent,
  serializeDurableEvent,
} from "@executablemd/durable-streams";
import { WorkflowRecordMalformedError } from "../storage/errors.ts";
import { describe } from "../storage/members.ts";

/** One retained event and the opaque id it keeps for the life of the run. */
export interface JournalEntry {
  readonly eventId: string;
  readonly event: DurableEvent;
}

const INSERT = `INSERT INTO journal_events (event_id, record, workspace_root_id)
  VALUES (?, ?, ?)`;
const SELECT = "SELECT event_id, record FROM journal_events ORDER BY sequence ASC";

/**
 * Append one already-filtered event, and answer with the id it will keep.
 *
 * Insertion only. Whether this happens in a transaction of its own or inside
 * one a caller opened is decided above this function, which is what lets a
 * standalone append and an enlisted append share one statement.
 */
export function insertJournalEvent(
  database: DatabaseSync,
  event: DurableEvent,
  workspaceRootId = currentWorkspaceRoot(database),
): string {
  const eventId = randomUUID();
  database.prepare(INSERT).run(eventId, serializeDurableEvent(event), workspaceRootId);
  return eventId;
}

function currentWorkspaceRoot(database: DatabaseSync): string {
  const row = database
    .prepare("SELECT current_root_id FROM workspace_state WHERE singleton_id = 1")
    .get();
  const rootId = row?.["current_root_id"];
  if (typeof rootId !== "string") {
    throw new Error("the workflow Workspace has no current root");
  }
  return rootId;
}

/** Every retained event, in the order it was appended. */
export function readJournalEntries(database: DatabaseSync): JournalEntry[] {
  const entries: JournalEntry[] = [];

  for (const row of database.prepare(SELECT).all()) {
    const eventId = row["event_id"];
    const record = row["record"];
    if (typeof eventId !== "string" || eventId === "") {
      throw new WorkflowRecordMalformedError(
        "journal_events.event_id",
        `expected a non-empty identity, found ${describe(eventId)}`,
      );
    }
    if (typeof record !== "string") {
      throw new WorkflowRecordMalformedError(
        "journal_events.record",
        `expected text, found ${describe(record)}`,
      );
    }

    const parsed = parseDurableEvent(record);
    if (!parsed.ok) {
      throw new WorkflowRecordMalformedError("journal_events.record", parsed.error.message);
    }
    entries.push(Object.freeze({ eventId, event: parsed.value }));
  }

  return entries;
}
