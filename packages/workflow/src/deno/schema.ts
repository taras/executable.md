/**
 * The version-1 schema, and what a file must satisfy to be read as one.
 *
 * A workflow run is one SQLite database, and every question about whether that
 * file is *this* run's is answered here before a single row is trusted. The
 * order matters: a file that is not SQLite, a database belonging to another
 * program, a schema from a version this build does not implement, and a
 * database missing the tables it claims to have are four different situations,
 * and each is reported as itself.
 *
 * Nothing in this module writes to a database it did not just create. An
 * incompatible or damaged file is described and left exactly as it was found:
 * a host that silently replaced it would be claiming to continue a run whose
 * history it had just deleted.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  WorkflowDatabaseCorruptError,
  WorkflowDatabaseFormatError,
  WorkflowSchemaVersionError,
} from "../storage/errors.ts";

/**
 * The bytes `XMD1` as a 32-bit integer, written into the SQLite header.
 *
 * A database carries what wrote it, so a file that is perfectly valid SQLite
 * and belongs to something else is refused on sight rather than through the
 * confusing shape of its missing tables.
 */
export const APPLICATION_ID = 0x584d4431;

/** The only schema version this build reads or writes. */
export const SCHEMA_VERSION = 1;

/** Tables version 1 declares. `sqlite_sequence` follows from AUTOINCREMENT. */
export const REQUIRED_TABLES: readonly string[] = Object.freeze([
  "workflow_run",
  "definition_retrieval",
  "document_executions",
  "journal_events",
]);

const STATUSES = "'running', 'suspended', 'interrupted', 'completed', 'failed', 'cancelled'";

/**
 * A stop reason is two columns wide and has three legal shapes.
 *
 * Spreading the variant across columns is what lets SQLite hold the invariant
 * rather than the code that writes rows: a host reason with an event id, or a
 * journal reason with a code, is refused by the database itself.
 */
function coherentStopReason(prefix: string): string {
  return `CHECK (
    (${prefix}kind IS NULL AND ${prefix}code IS NULL AND ${prefix}event_id IS NULL)
    OR (${prefix}kind = 'host' AND ${prefix}code IS NOT NULL AND ${prefix}event_id IS NULL)
    OR (${prefix}kind = 'journal' AND ${prefix}code IS NULL AND ${prefix}event_id IS NOT NULL)
  )`;
}

/**
 * Version 1 in full, including the journal table.
 *
 * The journal is here from the first version even though metadata lands first:
 * a schema that grew a table between two commits of the same release would owe
 * a migration to databases that never existed.
 */
export const SCHEMA_SQL = `
CREATE TABLE workflow_run (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  base TEXT NOT NULL,
  props TEXT NOT NULL CHECK (json_valid(props)),
  status TEXT NOT NULL CHECK (status IN (${STATUSES})),
  stop_reason_kind TEXT CHECK (stop_reason_kind IS NULL OR stop_reason_kind IN ('host', 'journal')),
  stop_reason_code TEXT,
  stop_reason_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ${coherentStopReason("stop_reason_")}
) STRICT;

CREATE TABLE definition_retrieval (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  metadata TEXT NOT NULL CHECK (json_valid(metadata)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE document_executions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_status TEXT CHECK (stop_status IS NULL OR stop_status IN (${STATUSES})),
  stop_reason_kind TEXT CHECK (stop_reason_kind IS NULL OR stop_reason_kind IN ('host', 'journal')),
  stop_reason_code TEXT,
  stop_reason_event_id TEXT,
  CHECK ((stopped_at IS NULL) = (stop_status IS NULL)),
  CHECK (stop_status IS NOT NULL OR stop_reason_kind IS NULL),
  ${coherentStopReason("stop_reason_")}
) STRICT;

CREATE TABLE journal_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT;
`;

/**
 * Write the version-1 schema into a database that holds nothing.
 *
 * Called inside the caller's transaction, so the application id, the version
 * and the tables appear together or not at all — a half-initialized file would
 * be indistinguishable from one this build must refuse.
 */
export function initializeSchema(database: DatabaseSync): void {
  database.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  database.exec(SCHEMA_SQL);
}

/** Whether a database holds nothing at all, and may therefore be initialized. */
export function isUninitialized(database: DatabaseSync, path: string): boolean {
  return (
    readPragmaNumber(database, "application_id", path) === 0 &&
    tableNames(database, path).size === 0
  );
}

/**
 * Refuse anything that is not a version-1 workflow-run database.
 *
 * Structure only. Whether the rows describe the run that was asked for is a
 * separate question, asked after this one succeeds.
 */
export function verifySchema(database: DatabaseSync, path: string): void {
  checkIntegrity(database, path);

  const applicationId = readPragmaNumber(database, "application_id", path);
  if (applicationId !== APPLICATION_ID) {
    throw new WorkflowDatabaseFormatError(
      path,
      `it carries application id ${applicationId} rather than ${APPLICATION_ID}`,
    );
  }

  const version = readPragmaNumber(database, "user_version", path);
  if (version !== SCHEMA_VERSION) {
    throw new WorkflowSchemaVersionError(path, version, SCHEMA_VERSION);
  }

  const present = tableNames(database, path);
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new WorkflowDatabaseFormatError(path, `it is missing the table ${missing.join(", ")}`);
  }
}

/**
 * Ask SQLite whether it can still read its own file.
 *
 * A page-level failure surfaces here rather than as an unreadable row much
 * later, which is what keeps damage distinguishable from a record this build
 * cannot parse.
 */
export function checkIntegrity(database: DatabaseSync, path: string): void {
  const rows = query(database, "PRAGMA integrity_check", path);
  const first = rows[0];
  const answer = first === undefined ? undefined : first["integrity_check"];
  if (answer !== "ok") {
    throw new WorkflowDatabaseCorruptError(path, "its integrity check did not pass");
  }
}

function tableNames(database: DatabaseSync, path: string): Set<string> {
  const rows = query(database, "SELECT name FROM sqlite_schema WHERE type = 'table'", path);
  const names = new Set<string>();
  for (const row of rows) {
    const name = row["name"];
    if (typeof name === "string") {
      names.add(name);
    }
  }
  return names;
}

function readPragmaNumber(database: DatabaseSync, pragma: string, path: string): number {
  const rows = query(database, `PRAGMA ${pragma}`, path);
  const value = rows[0]?.[pragma];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new WorkflowDatabaseFormatError(path, `SQLite reported no ${pragma}`);
}

/**
 * SQLite's own refusals, told apart.
 *
 * `SQLITE_NOTADB` means the bytes are not a database, which is a different
 * report from a database whose pages no longer agree with each other.
 */
function query(database: DatabaseSync, sql: string, path: string): Record<string, unknown>[] {
  try {
    return database.prepare(sql).all();
  } catch (error) {
    throw translateSqliteError(error, path);
  }
}

/** `SQLITE_CORRUPT`: the pages no longer describe a consistent database. */
const SQLITE_CORRUPT = 11;

/** `SQLITE_NOTADB`: the bytes are not a SQLite database at all. */
const SQLITE_NOTADB = 26;

/**
 * The typed refusal a SQLite failure describes, or the failure unchanged.
 *
 * Keyed on the code SQLite reports rather than on the words in its message, so
 * a storage failure of our own passes through as itself instead of being
 * re-read as damage because of what it happens to say.
 */
export function translateSqliteError(error: unknown, path: string): unknown {
  switch (sqliteErrorCode(error)) {
    case SQLITE_NOTADB:
      return new WorkflowDatabaseFormatError(path, "SQLite does not recognize it as a database");
    case SQLITE_CORRUPT:
      return new WorkflowDatabaseCorruptError(path, "SQLite reported a damaged image");
    default:
      return error;
  }
}

/** The SQLite result code behind a failure, when SQLite is what raised it. */
function sqliteErrorCode(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_SQLITE_ERROR") {
    return undefined;
  }
  if ("errcode" in error && typeof error.errcode === "number") {
    return error.errcode;
  }
  return undefined;
}
