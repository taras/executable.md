/**
 * The version-1 schema, and what a file must satisfy to be read as one.
 *
 * A workflow run is one SQLite database, and every question about whether that
 * file is *this* run's is answered here before a single row is trusted.
 *
 * Three answers are kept apart because a host acts on them differently. A file
 * that belongs to another program is a **format** failure: nothing here will
 * ever read it. A schema version this build does not implement is a **version**
 * failure: a later build might read it, and this one must not touch it. A file
 * that claims to be a version-1 workflow database and is not shaped like one is
 * **damage** — the header says the tables are there, so their absence or their
 * wrong shape is the file disagreeing with itself.
 *
 * Recognizing it is not the same as reading its table names. The stored
 * definition of every table is compared with the definition this build creates,
 * so a column that is gone, a constraint that was dropped, and a table nobody
 * declared are all caught before a row reaches a parser that assumes they hold.
 *
 * Nothing in this module writes to a database it did not just create. An
 * incompatible or damaged file is described and left exactly as it was found: a
 * host that silently replaced it would be claiming to continue a run whose
 * history it had just deleted.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  WorkflowDatabaseCorruptError,
  WorkflowDatabaseFormatError,
  WorkflowRequestError,
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

const STATUSES = "'running', 'suspended', 'interrupted', 'completed', 'failed', 'cancelled'";

/**
 * A stop reason is three columns wide and has three legal shapes.
 *
 * Spreading the variant across columns is what lets SQLite hold the invariant
 * rather than the code that writes rows: a host reason with an event id, or a
 * journal reason with a code, is refused by the database itself.
 */
function coherentStopReason(): string {
  return `CHECK (
    (stop_reason_kind IS NULL AND stop_reason_code IS NULL AND stop_reason_event_id IS NULL)
    OR (stop_reason_kind = 'host' AND stop_reason_code IS NOT NULL AND stop_reason_event_id IS NULL)
    OR (stop_reason_kind = 'journal' AND stop_reason_code IS NULL AND stop_reason_event_id IS NOT NULL)
  )`;
}

/**
 * Version 1, one table at a time.
 *
 * Kept as separate definitions so verification can compare what a file holds
 * with what this build writes, rather than settling for the table's name.
 *
 * The journal is here from the first version even though metadata landed
 * first: a schema that grew a table between two commits of the same release
 * would owe a migration to databases that never existed. It is also created
 * first, because the stop-reason references point at it.
 */
const TABLES: ReadonlyMap<string, string> = new Map([
  [
    "journal_events",
    `CREATE TABLE journal_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  record TEXT NOT NULL CHECK (json_valid(record))
) STRICT`,
  ],
  [
    "workflow_run",
    `CREATE TABLE workflow_run (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT NOT NULL,
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  base TEXT NOT NULL,
  props TEXT NOT NULL CHECK (json_valid(props) AND json_type(props) = 'object'),
  status TEXT NOT NULL CHECK (status IN (${STATUSES})),
  stop_reason_kind TEXT CHECK (stop_reason_kind IS NULL OR stop_reason_kind IN ('host', 'journal')),
  stop_reason_code TEXT,
  stop_reason_event_id TEXT REFERENCES journal_events (event_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ${coherentStopReason()}
) STRICT`,
  ],
  [
    "definition_retrieval",
    `CREATE TABLE definition_retrieval (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  metadata TEXT NOT NULL CHECK (json_valid(metadata)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
) STRICT`,
  ],
  [
    "document_executions",
    `CREATE TABLE document_executions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_status TEXT CHECK (stop_status IS NULL OR stop_status IN (${STATUSES})),
  stop_reason_kind TEXT CHECK (stop_reason_kind IS NULL OR stop_reason_kind IN ('host', 'journal')),
  stop_reason_code TEXT,
  stop_reason_event_id TEXT REFERENCES journal_events (event_id),
  CHECK ((stopped_at IS NULL) = (stop_status IS NULL)),
  CHECK (stop_status IS NOT NULL OR stop_reason_kind IS NULL),
  ${coherentStopReason()}
) STRICT`,
  ],
]);

/** Tables version 1 declares. */
export const REQUIRED_TABLES: readonly string[] = Object.freeze([...TABLES.keys()]);

/** Version 1 in full. */
export const SCHEMA_SQL = [...TABLES.values()].map((sql) => `${sql};`).join("\n\n");

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

/**
 * Whether a database holds nothing at all, and may therefore be initialized.
 *
 * Pristine means all three: no application id, no schema version, and not one
 * object anybody created. A file carrying a version but no tables, or tables
 * belonging to something else, is not empty — it is a file this build has no
 * business writing into, whatever its header happens to say.
 */
export function isUninitialized(database: DatabaseSync, path: string): boolean {
  return (
    readPragmaNumber(database, "application_id", path) === 0 &&
    readPragmaNumber(database, "user_version", path) === 0 &&
    schemaObjects(database, path).length === 0
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

  verifyStructure(database, path);
  checkForeignKeys(database, path);
}

/**
 * Hold a recognized database to the schema this build writes.
 *
 * The header already claims version 1, so anything missing or differently
 * shaped is the file disagreeing with itself rather than a version this build
 * has not learned yet.
 */
function verifyStructure(database: DatabaseSync, path: string): void {
  const objects = schemaObjects(database, path);

  for (const object of objects) {
    if (object.type !== "table") {
      throw new WorkflowDatabaseCorruptError(
        path,
        `it declares a ${object.type} that version ${SCHEMA_VERSION} does not`,
      );
    }
    const expected = TABLES.get(object.name);
    if (expected === undefined) {
      throw new WorkflowDatabaseCorruptError(
        path,
        `it declares a table that version ${SCHEMA_VERSION} does not`,
      );
    }
    if (normalize(object.sql) !== normalize(expected)) {
      throw new WorkflowDatabaseCorruptError(
        path,
        `its ${object.name} table is not shaped the way version ${SCHEMA_VERSION} declares it`,
      );
    }
  }

  const present = new Set(objects.map((object) => object.name));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new WorkflowDatabaseCorruptError(path, `it is missing the table ${missing.join(", ")}`);
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

/**
 * Ask SQLite whether its references still point at anything.
 *
 * A stop reason naming a journal event is only a reason while that event
 * exists; a row pointing at one that does not is damage, not a reason.
 */
function checkForeignKeys(database: DatabaseSync, path: string): void {
  if (query(database, "PRAGMA foreign_key_check", path).length > 0) {
    throw new WorkflowDatabaseCorruptError(path, "one of its references points at nothing");
  }
}

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

/**
 * Everything somebody declared in this database.
 *
 * `sqlite_` names are SQLite's own — the `sqlite_sequence` table AUTOINCREMENT
 * creates, the indexes UNIQUE creates — and are not anybody's declarations.
 */
function schemaObjects(database: DatabaseSync, path: string): SchemaObject[] {
  const rows = query(
    database,
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
    path,
  );

  const objects: SchemaObject[] = [];
  for (const row of rows) {
    const type = row["type"];
    const name = row["name"];
    const sql = row["sql"];
    if (typeof type !== "string" || typeof name !== "string") {
      throw new WorkflowDatabaseCorruptError(path, "its schema does not describe itself");
    }
    objects.push({ type, name, sql: typeof sql === "string" ? sql : "" });
  }
  return objects;
}

/** One statement's shape, independent of how it was laid out. */
function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
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

/** `SQLITE_CONSTRAINT_FOREIGNKEY`: a reference points at a row that is not there. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

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
    case SQLITE_CONSTRAINT_FOREIGNKEY:
      // The only reference version 1 declares. A stop reason may name a
      // journal event, and naming one this run does not hold is a reason that
      // refers to nothing.
      return new WorkflowRequestError(
        "the stop reason names a journal event this run does not hold. A journal reason " +
          "points at an event that has already been appended and filtered.",
      );
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
