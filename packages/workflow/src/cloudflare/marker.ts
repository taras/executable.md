/**
 * How the Cloudflare owner says which schema its storage holds.
 *
 * The Deno host writes `PRAGMA application_id` and `PRAGMA user_version` into
 * the SQLite header, and recognition reads them back to tell three conditions
 * apart: a database belonging to something else, a version this build has not
 * learned, and a database that claims version 1 and is not shaped like one.
 *
 * A Durable Object's SQLite refuses both pragmas — `not authorized:
 * SQLITE_AUTH`, on read as well as write — so this adapter carries the same two
 * values in a table of its own. The logical schema version is unchanged and
 * shared with Deno; only the physical carrier differs, which is why this table
 * is adapter-private recognition metadata rather than a WorkflowRun record. It
 * is never a journal value, an exported field, an authored value, a public API,
 * or a second schema.
 *
 * The constraints are what make the claim trustworthy. `id` is fixed at 1 by a
 * CHECK and is the primary key, so a second identity row cannot exist; both
 * values are non-null integers; and a row that disagrees with this build is
 * refused rather than migrated.
 */

import { APPLICATION_ID, isSchemaVersion, SCHEMA_VERSION } from "../sqlite/workflow-schema.ts";

/** The adapter-private table carrying this database's identity. */
export const MARKER_TABLE = "_xmd_workflow_schema";

export const MARKER_SQL = `CREATE TABLE ${MARKER_TABLE} (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  application_id INTEGER NOT NULL,
  schema_version INTEGER NOT NULL
) STRICT, WITHOUT ROWID`;

/** What one marker row says. */
export interface SchemaMarker {
  readonly applicationId: number;
  readonly schemaVersion: number;
}

/** Why a marker could not be accepted. */
export type MarkerFailure =
  | { readonly kind: "absent" }
  | { readonly kind: "duplicated"; readonly rows: number }
  | { readonly kind: "malformed" }
  | { readonly kind: "foreign-application"; readonly applicationId: number }
  | { readonly kind: "incomplete-version" }
  | { readonly kind: "unknown-version"; readonly schemaVersion: number };

/**
 * Read a marker out of rows the caller already selected.
 *
 * Takes rows rather than a connection so the comparison is the same whoever
 * consumed the cursor — Cloudflare requires a cursor to be drained
 * synchronously, and that is the caller's concern rather than this one's.
 */
export function readMarker(rows: readonly Record<string, unknown>[]): SchemaMarker | MarkerFailure {
  if (rows.length === 0) {
    return { kind: "absent" };
  }
  if (rows.length > 1) {
    return { kind: "duplicated", rows: rows.length };
  }
  const row = rows[0];
  if (row === undefined) {
    return { kind: "absent" };
  }
  const applicationId = row["application_id"];
  const schemaVersion = row["schema_version"];
  if (
    typeof applicationId !== "number" ||
    !Number.isInteger(applicationId) ||
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion)
  ) {
    return { kind: "malformed" };
  }
  if (applicationId !== APPLICATION_ID) {
    return { kind: "foreign-application", applicationId };
  }
  if (schemaVersion === 0) {
    // The identity is this project's and the version says nothing was
    // finished. That is a database left partly initialized, not an older one.
    return { kind: "incomplete-version" };
  }
  if (!isSchemaVersion(schemaVersion)) {
    // Outside what the version carrier can hold, so no build wrote it. The row
    // is damaged retained data rather than a version to report.
    return { kind: "malformed" };
  }
  if (schemaVersion !== SCHEMA_VERSION) {
    return { kind: "unknown-version", schemaVersion };
  }
  return { applicationId, schemaVersion };
}

/** Whether a read produced a marker rather than a reason it could not. */
export function isSchemaMarker(value: SchemaMarker | MarkerFailure): value is SchemaMarker {
  return "applicationId" in value && !("kind" in value);
}
