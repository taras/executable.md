/**
 * Which provider turn each of this run's Prompts was
 * (specs/workflow-workspace-spec.md §8.6).
 *
 * A retained Agent session says which conversation this run is having. A
 * checkpoint says where in that conversation one Prompt landed — the identity
 * the provider gave the turn it had just completed. Together they are what lets
 * something later continue from an exact point rather than from "the latest
 * thing that session said".
 *
 * The row lives in the run's own database, written in the transaction that
 * appends the Prompt it describes, for the reason the session mapping does: a
 * turn and the record naming it are one fact, and a record that could commit
 * while the Prompt did not would describe a turn this run never had.
 *
 * ## Order comes from the journal
 *
 * There is no position column here. A checkpoint names an event, that event has
 * a journal sequence, and joining the two is what orders them. A second
 * positional field would be a second answer to what came first, and the day it
 * disagreed with the journal there would be no way to say which was right.
 *
 * ## The table is acquired, not inherited
 *
 * Every version-1 database written before this existed is still exactly the run
 * it was, so its absence means zero associations and never a migration. Nothing
 * scans a run's existing Prompts, nothing synthesizes a row for one, and
 * reading a run that has no table leaves the file untouched.
 *
 * It appears the first time a run has something to put in it, created inside
 * the same transaction that appends that Prompt and its association. If that
 * transaction rolls back, the table goes with it and the file is the exact
 * legacy database it was.
 *
 * ## Nothing here fills a gap
 *
 * An association is written from one completion's own token or not at all.
 * Repeated transcript text, another Prompt's token, a later provider head,
 * Prompt sequence and journal order are each, in their own way, a guess — and a
 * Prompt this run cannot name is left unnamed.
 */

import type { DatabaseSync } from "node:sqlite";
import { WorkflowRecordMalformedError } from "../../storage/errors.ts";
import { describe } from "../../storage/members.ts";
import { declaredObjectSql } from "../schema.ts";

/** The one table this module reads and writes. */
export const AGENT_PROMPT_CHECKPOINTS = "agent_prompt_checkpoints";

/** One Prompt, and the provider turn it was. */
export interface AgentPromptCheckpointRecord {
  /** The opaque id of the `agent_prompt` event this describes. */
  readonly eventId: string;
  /** The logical Agent session this run retains the conversation under. */
  readonly sessionKey: string;
  /** The provider, as it names itself. */
  readonly provider: string;
  /** What kind of identity the value is. */
  readonly tokenKind: string;
  /** The identity itself, exactly as the provider spelled it. */
  readonly tokenValue: string;
}

const INSERT = `INSERT INTO ${AGENT_PROMPT_CHECKPOINTS}
  (event_id, session_key, provider, token_kind, token_value)
  VALUES (?, ?, ?, ?, ?)`;

/**
 * Every association this run holds, in journal order.
 *
 * The join is the ordering. `journal_events.sequence` is the run's own physical
 * order, and reading through it is what makes two associations comparable
 * without this table claiming to know which Prompt came first.
 */
const SELECT_ALL = `SELECT c.event_id, c.session_key, c.provider, c.token_kind, c.token_value
  FROM ${AGENT_PROMPT_CHECKPOINTS} c
  JOIN journal_events e ON e.event_id = c.event_id
  ORDER BY e.sequence ASC`;

/** Whether this database holds the table at all. */
export function hasAgentPromptCheckpoints(database: DatabaseSync): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(AGENT_PROMPT_CHECKPOINTS);
  return row !== undefined;
}

/**
 * Create the table if this run has never needed one.
 *
 * From the schema's own declaration, never from a copy: a second spelling of
 * this statement is a second shape, and the day the two drifted apart
 * verification would call a database this build had just written damage.
 */
function createIfAbsent(database: DatabaseSync): void {
  if (!hasAgentPromptCheckpoints(database)) {
    database.exec(`${declaredObjectSql(AGENT_PROMPT_CHECKPOINTS)};`);
  }
}

/** What a transaction may do with this run's checkpoint associations. */
export interface AgentPromptCheckpoints {
  /** Every association this run holds, in journal order. */
  readAll(): AgentPromptCheckpointRecord[];
  /**
   * Retain one association, creating the table if this run has never had one.
   *
   * Inside the caller's transaction, so the table, the Prompt's event and this
   * row appear together or not at all.
   */
  associate(record: AgentPromptCheckpointRecord): void;
}

function text(value: unknown, column: string): string {
  if (typeof value !== "string" || value === "") {
    // The table's own constraints make this unreachable through this host. A
    // row that reached it anyway is damage, and damage names no turn.
    throw new WorkflowRecordMalformedError(
      `${AGENT_PROMPT_CHECKPOINTS}.${column}`,
      `expected a non-empty identity, found ${describe(value)}`,
    );
  }
  return value;
}

function parseRow(row: Record<string, unknown>): AgentPromptCheckpointRecord {
  return Object.freeze({
    eventId: text(row["event_id"], "event_id"),
    sessionKey: text(row["session_key"], "session_key"),
    provider: text(row["provider"], "provider"),
    tokenKind: text(row["token_kind"], "token_kind"),
    tokenValue: text(row["token_value"], "token_value"),
  });
}

/** Every association this run holds, or none at all when it holds no table. */
export function readAgentPromptCheckpoints(database: DatabaseSync): AgentPromptCheckpointRecord[] {
  if (!hasAgentPromptCheckpoints(database)) {
    return [];
  }
  return database.prepare(SELECT_ALL).all().map(parseRow);
}

export function createAgentPromptCheckpoints(
  database: DatabaseSync,
  authorize: () => void,
): AgentPromptCheckpoints {
  return {
    readAll() {
      authorize();
      return readAgentPromptCheckpoints(database);
    },
    associate(record) {
      authorize();
      createIfAbsent(database);
      database
        .prepare(INSERT)
        .run(
          record.eventId,
          record.sessionKey,
          record.provider,
          record.tokenKind,
          record.tokenValue,
        );
    },
  };
}
