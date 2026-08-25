/**
 * Version 1's private container, and what a file must satisfy to be read as one.
 *
 * `.xmd` and the versioned semantic contract are the public compatibility
 * boundary. Everything in this module — the marker, the two tables, the column
 * names, the constraints — is an internal protocol choice, and a later encoding
 * may replace all of it while producing the same artifact identity. Nothing
 * here is exported past the provider.
 *
 * Recognition answers four different questions and keeps their answers apart,
 * because a host acts on each differently. A file belonging to another program
 * is **foreign**: nothing here will ever read it. A live workflow-run database
 * is **XMD's own writable authority** offered where evidence was expected, and
 * says so in its own sentence rather than as a confusing foreign refusal. A
 * version this build does not implement is **unsupported**: a later build may
 * read it, and this one must not touch it. A file that claims version 1 and is
 * not shaped like one is **damage** — the header says the tables are there, so
 * their absence or their wrong shape is the file disagreeing with itself.
 *
 * The stored `sqlite_schema` definitions are compared with the definitions this
 * build creates, so a dropped constraint, an added trigger, a view somebody
 * attached and an index the declaration never asked for are all caught before a
 * row reaches a parser that assumes they hold. Nothing in this module writes to
 * a database it did not just create.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  XmdArtifactContainerVersionError,
  XmdArtifactForeignContainerError,
  XmdArtifactFormatVersionError,
  XmdArtifactLiveRunError,
  XmdArtifactSchemaError,
  XmdArtifactUnreadableError,
} from "../../storage/errors.ts";
import { reading } from "../reading.ts";
import { APPLICATION_ID as LIVE_RUN_APPLICATION_ID } from "../schema.ts";

/**
 * The bytes `XMDA` as a 32-bit integer, written into the SQLite header.
 *
 * Deliberately not the live run store's `XMD1`. Both are ours, and telling them
 * apart on sight is what lets a run database offered as an artifact be refused
 * for what it is instead of through the shape of its unexpected tables.
 */
export const XMD_ARTIFACT_APPLICATION_ID = 0x584d4441;

/** The only container schema version this build reads or writes. */
export const XMD_ARTIFACT_CONTAINER_VERSION = 1;

/** The only artifact format version this build reads or writes. */
export const XMD_ARTIFACT_FORMAT_VERSION = 1;

/** The extension the public format is named by. */
export const XMD_ARTIFACT_EXTENSION = ".xmd";

interface DeclaredObject {
  readonly type: "table" | "index";
  readonly sql: string;
}

/**
 * Version 1, one declaration at a time.
 *
 * Two tables and nothing else. The header is a singleton carrying what the
 * container claims to be and what it claims to hold; the content table is a
 * generic store keyed by an entry's kind and its canonical logical identity.
 *
 * The content table is `WITHOUT ROWID`, so its primary key *is* the table and
 * SQLite creates no automatic index beside it. That matters because version 1
 * admits no schema object its declaration did not ask for, and an automatic
 * index is exactly such an object.
 *
 * `identity` holds the entry's canonical JSON identity as text rather than a
 * joined key, because two different natural keys can join to one string and a
 * container whose primary key merged them would hold fewer records than its
 * manifest claims.
 */
const OBJECTS: ReadonlyMap<string, DeclaredObject> = new Map([
  [
    "xmd_artifact_header",
    {
      type: "table",
      sql: `CREATE TABLE xmd_artifact_header (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1),
  container_version INTEGER NOT NULL CHECK (container_version >= 1),
  manifest BLOB NOT NULL,
  identity TEXT NOT NULL CHECK (
    length(identity) = 64 AND identity NOT GLOB '*[^0-9a-f]*'
  )
) STRICT`,
    },
  ],
  [
    "xmd_artifact_content",
    {
      type: "table",
      sql: `CREATE TABLE xmd_artifact_content (
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  identity TEXT NOT NULL CHECK (json_valid(identity)),
  encoding TEXT NOT NULL CHECK (encoding IN ('canonical-json', 'utf8', 'bytes')),
  length INTEGER NOT NULL CHECK (length >= 0 AND length <= 9007199254740991),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  content BLOB NOT NULL,
  PRIMARY KEY (kind, identity)
) STRICT, WITHOUT ROWID`,
    },
  ],
]);

/** Every object version 1 declares, with the shape it declares. */
export const XMD_ARTIFACT_EXPECTED_SCHEMA = Object.freeze(
  [...OBJECTS.entries()].map(([name, object]) =>
    Object.freeze({ name, type: object.type, sql: normalize(object.sql) }),
  ),
);

/** Version 1 in full. */
export const XMD_ARTIFACT_SCHEMA_SQL = [...OBJECTS.values()]
  .map((object) => `${object.sql};`)
  .join("\n\n");

/**
 * Write the version-1 container into a database that holds nothing.
 *
 * Called inside the caller's transaction, so the marker, the tables and the
 * version appear together or not at all: a half-initialized file would be
 * indistinguishable from one this build must refuse.
 */
export function initializeXmdArtifactSchema(database: DatabaseSync): void {
  database.exec(`PRAGMA application_id = ${XMD_ARTIFACT_APPLICATION_ID};`);
  database.exec(XMD_ARTIFACT_SCHEMA_SQL);
  database.exec(`PRAGMA user_version = ${XMD_ARTIFACT_CONTAINER_VERSION};`);
}

/** What the container says it is, once it has been recognized as one. */
export interface XmdArtifactContainerVersions {
  readonly containerVersion: number;
}

/**
 * Refuse anything that is not a version-1 XMD artifact container.
 *
 * Structure and declared version only. Whether the rows describe one workflow
 * run's evidence is a separate question, asked after this one succeeds.
 */
export function verifyXmdArtifactContainer(
  database: DatabaseSync,
  path: string,
): XmdArtifactContainerVersions {
  checkIntegrity(database, path);

  const applicationId = readPragmaNumber(database, "application_id", path);
  if (applicationId === LIVE_RUN_APPLICATION_ID) {
    throw new XmdArtifactLiveRunError(path);
  }
  if (applicationId !== XMD_ARTIFACT_APPLICATION_ID) {
    throw new XmdArtifactForeignContainerError(
      path,
      `it carries application id ${applicationId} rather than ${XMD_ARTIFACT_APPLICATION_ID}`,
    );
  }

  const containerVersion = readPragmaNumber(database, "user_version", path);
  if (containerVersion === 0) {
    throw new XmdArtifactSchemaError(
      path,
      "it carries the XMD artifact marker without a container schema version",
    );
  }
  if (containerVersion !== XMD_ARTIFACT_CONTAINER_VERSION) {
    throw new XmdArtifactContainerVersionError(
      path,
      containerVersion,
      XMD_ARTIFACT_CONTAINER_VERSION,
    );
  }

  verifyStructure(database, path);
  return Object.freeze({ containerVersion });
}

/**
 * Hold the artifact format version this container declares to the one this
 * build implements.
 *
 * Separate from the container version and asked after it, because they answer
 * different questions: how the bytes are laid out, and what the records inside
 * them mean. A future artifact version inside a version-1 container is still a
 * file this build must not guess at, and never one it rewrites.
 */
export function verifyXmdArtifactFormatVersion(stored: number, path: string): void {
  if (stored !== XMD_ARTIFACT_FORMAT_VERSION) {
    throw new XmdArtifactFormatVersionError(path, stored, XMD_ARTIFACT_FORMAT_VERSION);
  }
}

/**
 * Hold a recognized container to the schema this build writes.
 *
 * The header already claims version 1, so anything missing, differently shaped,
 * or declared by nobody is the file disagreeing with itself rather than a
 * version this build has not learned yet.
 */
function verifyStructure(database: DatabaseSync, path: string): void {
  const objects = schemaObjects(database, path);

  for (const object of objects) {
    const expected = OBJECTS.get(object.name);
    if (expected === undefined) {
      throw new XmdArtifactSchemaError(
        path,
        `it declares a schema object that version ${XMD_ARTIFACT_CONTAINER_VERSION} does not`,
      );
    }
    if (object.type !== expected.type || normalize(object.sql) !== normalize(expected.sql)) {
      throw new XmdArtifactSchemaError(
        path,
        `its ${object.name} object is not shaped the way version ` +
          `${XMD_ARTIFACT_CONTAINER_VERSION} declares it`,
      );
    }
  }

  const present = new Set(objects.map((object) => object.name));
  const missing = [...OBJECTS.keys()].filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new XmdArtifactSchemaError(path, `it is missing the table ${missing.join(", ")}`);
  }
}

/**
 * Ask SQLite whether it can still read its own file.
 *
 * A page-level failure surfaces here rather than as an unreadable row much
 * later, which is what keeps damage distinguishable from a record this build
 * cannot parse.
 */
function checkIntegrity(database: DatabaseSync, path: string): void {
  const rows = query(database, "PRAGMA integrity_check", path);
  const first = rows[0];
  if (first === undefined || first["integrity_check"] !== "ok") {
    throw new XmdArtifactSchemaError(path, "its integrity check did not pass");
  }
}

/**
 * Ask SQLite whether its declared references still point at anything.
 *
 * Version 1 declares no foreign key, so this can only ever report nothing on a
 * container whose schema has just been recognized as version 1's. It is asked
 * anyway because it costs one statement and because the reference invariants
 * that *can* fail — an event naming a root nobody retained, a root naming
 * content nobody stored — are semantic rather than physical, and are checked
 * where the records themselves are parsed.
 */
export function checkXmdArtifactForeignKeys(database: DatabaseSync, path: string): void {
  if (query(database, "PRAGMA foreign_key_check", path).length > 0) {
    throw new XmdArtifactSchemaError(path, "one of its declared references points at nothing");
  }
}

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

/**
 * Everything somebody declared in this container.
 *
 * `sqlite_` names are SQLite's own and are not anybody's declarations. Every
 * other object is compared, so a view, a trigger or an index that version 1
 * never asked for is refused rather than ignored.
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
      throw new XmdArtifactSchemaError(path, "its schema does not describe itself");
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
  throw new XmdArtifactForeignContainerError(path, `SQLite reported no ${pragma}`);
}

function query(database: DatabaseSync, sql: string, path: string): Record<string, unknown>[] {
  try {
    return reading(database, sql).all();
  } catch (error) {
    throw translateArtifactSqliteError(error, path);
  }
}

/** `SQLITE_CORRUPT`: the pages no longer describe a consistent database. */
const SQLITE_CORRUPT = 11;

/** `SQLITE_NOTADB`: the bytes are not a SQLite database at all. */
const SQLITE_NOTADB = 26;

/**
 * `SQLITE_READONLY_ROLLBACK`: a hot journal has to go back before anything can
 * be read, and this connection is not allowed to write it.
 *
 * A sealed artifact never has one. A file that does was interrupted mid-write
 * or was tampered with, and either way it is damage — an artifact reader
 * recovers nothing, because recovering would mean writing to the evidence.
 */
const SQLITE_READONLY_ROLLBACK = 776;

/**
 * The typed refusal a SQLite failure describes, or the failure unchanged.
 *
 * Keyed on the code SQLite reports rather than on the words in its message, so
 * a refusal of our own passes through as itself instead of being re-read as
 * damage because of what it happens to say.
 */
export function translateArtifactSqliteError(error: unknown, path: string): unknown {
  switch (sqliteErrorCode(error)) {
    case SQLITE_NOTADB:
      return new XmdArtifactForeignContainerError(
        path,
        "SQLite does not recognize it as a database",
      );
    case SQLITE_CORRUPT:
      return new XmdArtifactSchemaError(path, "SQLite reported a damaged image");
    case SQLITE_READONLY_ROLLBACK:
      return new XmdArtifactSchemaError(
        path,
        "it holds a rollback journal, so it was never finished or was written to since",
      );
    default:
      return error;
  }
}

/** The failure opening a path describes, without quoting the host's wording. */
export function artifactOpenFailure(error: unknown, path: string): unknown {
  const translated = translateArtifactSqliteError(error, path);
  if (translated !== error) {
    return translated;
  }
  return new XmdArtifactUnreadableError(path, "SQLite refused the file");
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
