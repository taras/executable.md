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
import type { Database as CloudflareDatabase } from "../../vendor/cloudflare-computer-dofs/generated/storage.js";
import { initializeSchema as initializeCloudflareSchema } from "../../vendor/cloudflare-computer-dofs/generated/schema/index.js";
import {
  WorkflowDatabaseCorruptError,
  WorkflowDatabaseFormatError,
  WorkflowIncompleteVersionOneError,
  WorkflowSchemaVersionError,
} from "../storage/errors.ts";
import {
  APPLICATION_ID,
  declaredStructureFailure,
  EXPECTED_SCHEMA,
  hasAnyDeclaredObject,
  REQUIRED_OBJECTS,
  REQUIRED_TABLES,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  type SchemaObject,
} from "../sqlite/workflow-schema.ts";
import { reading } from "./reading.ts";
import { initializeEmptyWorkspace, verifyWorkspace } from "./workspace/root.ts";

/**
 * Write the version-1 schema into a database that holds nothing.
 *
 * Called inside the caller's transaction, so the application id, the version
 * and the tables appear together or not at all — a half-initialized file would
 * be indistinguishable from one this build must refuse.
 */
export {
  APPLICATION_ID,
  EXPECTED_SCHEMA,
  REQUIRED_OBJECTS,
  REQUIRED_TABLES,
  SCHEMA_SQL,
  SCHEMA_VERSION,
};

export function initializeSchema(
  database: DatabaseSync,
  dofs: CloudflareDatabase,
  initializeRun: () => void,
): void {
  database.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
  database.exec(SCHEMA_SQL);
  initializeCloudflareSchema(dofs, () => 0);
  initializeEmptyWorkspace(database);
  initializeRun();
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
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
export function verifySchema(database: DatabaseSync, path: string, dofs: CloudflareDatabase): void {
  checkIntegrity(database, path);

  const applicationId = readPragmaNumber(database, "application_id", path);
  if (applicationId !== APPLICATION_ID) {
    if (applicationId === 0 && hasDeclaredVersionOneObjects(database, path)) {
      throw new WorkflowDatabaseCorruptError(
        path,
        "it contains a partial version-1 initialization without the XMD application identity",
      );
    }
    throw new WorkflowDatabaseFormatError(
      path,
      `it carries application id ${applicationId} rather than ${APPLICATION_ID}`,
    );
  }

  const version = readPragmaNumber(database, "user_version", path);
  if (version === 0) {
    throw new WorkflowDatabaseCorruptError(
      path,
      "it carries the XMD application identity without a complete version-1 schema",
    );
  }
  if (version !== SCHEMA_VERSION) {
    throw new WorkflowSchemaVersionError(path, version, SCHEMA_VERSION);
  }

  verifyStructure(database, path);
  checkForeignKeys(database, path);
  verifyWorkspace(database, dofs, path);
}

/**
 * Hold a recognized database to the schema this build writes.
 *
 * The header already claims version 1, so anything missing or differently
 * shaped is the file disagreeing with itself rather than a version this build
 * has not learned yet.
 */
function verifyStructure(database: DatabaseSync, path: string): void {
  const failure = declaredStructureFailure(schemaObjects(database, path));
  if (failure === undefined) {
    return;
  }
  if (failure.kind === "incomplete-pre-release") {
    throw new WorkflowIncompleteVersionOneError(path);
  }
  if (failure.kind === "undeclared-object") {
    throw new WorkflowDatabaseCorruptError(
      path,
      `it declares an object that version ${SCHEMA_VERSION} does not`,
    );
  }
  if (failure.kind === "misshapen-object") {
    throw new WorkflowDatabaseCorruptError(
      path,
      `its ${failure.name} object is not shaped the way version ${SCHEMA_VERSION} declares it`,
    );
  }
  throw new WorkflowDatabaseCorruptError(
    path,
    `it is missing the table ${failure.names.join(", ")}`,
  );
}

function hasDeclaredVersionOneObjects(database: DatabaseSync, path: string): boolean {
  return hasAnyDeclaredObject(schemaObjects(database, path));
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
 * A retained reference names an object only while that object exists; a row
 * pointing at nothing is damage rather than a partial retained state.
 */
function checkForeignKeys(database: DatabaseSync, path: string): void {
  if (query(database, "PRAGMA foreign_key_check", path).length > 0) {
    throw new WorkflowDatabaseCorruptError(path, "one of its references points at nothing");
  }
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
    return reading(database, sql).all();
  } catch (error) {
    throw translateSqliteError(error, path);
  }
}

/** `SQLITE_CORRUPT`: the pages no longer describe a consistent database. */
const SQLITE_CORRUPT = 11;

/** `SQLITE_NOTADB`: the bytes are not a SQLite database at all. */
const SQLITE_NOTADB = 26;

/** `SQLITE_CONSTRAINT_FOREIGNKEY`: one statement violated a foreign key. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

/**
 * `SQLITE_READONLY_ROLLBACK`: a hot journal has to go back before anything can
 * be read, and this connection is not allowed to write it.
 *
 * The extended code is the whole signal. Primary `SQLITE_READONLY` (8) and the
 * other extended readonly conditions describe a database nobody may write for
 * some other reason, and answering those with crash recovery would be this
 * adapter guessing. The message is not consulted: several conditions share the
 * words "attempt to write a readonly database".
 */
const SQLITE_READONLY_ROLLBACK = 776;

/**
 * A crashed run, read through a connection that cannot recover it.
 *
 * Provider-private and deliberately not a `WorkflowStorageError`: it is not an
 * outcome any caller receives, it is the one condition read-only inspection
 * answers by recovering a private copy instead. Whatever inspection produces
 * after that — a snapshot, a recognition refusal, or a recovery failure — is
 * what the caller sees, so this never leaves the Deno provider.
 */
export class WorkflowReadonlyRollbackError extends Error {
  override name = "WorkflowReadonlyRollbackError";

  readonly path: string;

  constructor(path: string) {
    super(
      `The workflow run database at ${JSON.stringify(path)} holds a rollback journal a lost ` +
        "host left behind, and a read-only connection cannot put it back.",
    );
    this.path = path;
  }
}

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
    case SQLITE_READONLY_ROLLBACK:
      return new WorkflowReadonlyRollbackError(path);
    default:
      return error;
  }
}

export function isSqliteForeignKeyConstraint(error: unknown): boolean {
  return sqliteErrorCode(error) === SQLITE_CONSTRAINT_FOREIGNKEY;
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
