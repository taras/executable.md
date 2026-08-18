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
import { reading } from "./reading.ts";
import { initializeEmptyWorkspace, verifyWorkspace } from "./workspace/root.ts";

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
 * The complete version-1 shape includes the pinned DOFS objects, retained
 * Workspace roots, journal and metadata. Dependency order is explicit: DOFS
 * content precedes root references, and roots precede the journal rows that
 * name them.
 */
interface DeclaredObject {
  readonly type: "table" | "index";
  readonly sql: string;
}

const OBJECTS: ReadonlyMap<string, DeclaredObject> = new Map([
  [
    "vfs_meta",
    {
      type: "table",
      sql: `CREATE TABLE vfs_meta (
    k TEXT PRIMARY KEY,
    v INTEGER NOT NULL
  )`,
    },
  ],
  [
    "vfs_nodes",
    {
      type: "table",
      sql: `CREATE TABLE vfs_nodes (
    inode         INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT    NOT NULL CHECK(type IN ('file','dir','symlink')),
    mode          INTEGER NOT NULL DEFAULT 493,
    mtime         INTEGER NOT NULL,
    rev           INTEGER NOT NULL DEFAULT 0,
    mount_root    TEXT,
    stub_size     INTEGER,
    manifest_hash BLOB,
    link_target   TEXT,
    size          INTEGER NOT NULL DEFAULT 0
  )`,
    },
  ],
  [
    "vfs_dirents",
    {
      type: "table",
      sql: `CREATE TABLE vfs_dirents (
    parent_inode INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    child_inode  INTEGER NOT NULL,
    PRIMARY KEY (parent_inode, name)
  ) WITHOUT ROWID`,
    },
  ],
  [
    "vfs_dirents_by_child",
    {
      type: "index",
      sql: "CREATE INDEX vfs_dirents_by_child ON vfs_dirents(child_inode)",
    },
  ],
  [
    "vfs_nodes_by_rev",
    {
      type: "index",
      sql: "CREATE INDEX vfs_nodes_by_rev ON vfs_nodes(rev)",
    },
  ],
  [
    "vfs_nodes_by_manifest_hash",
    {
      type: "index",
      sql: `CREATE INDEX vfs_nodes_by_manifest_hash
    ON vfs_nodes(manifest_hash) WHERE manifest_hash IS NOT NULL`,
    },
  ],
  [
    "vfs_blobs",
    {
      type: "table",
      sql: `CREATE TABLE vfs_blobs (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`,
    },
  ],
  [
    "vfs_blob_bytes",
    {
      type: "table",
      sql: `CREATE TABLE vfs_blob_bytes (
    hash  BLOB PRIMARY KEY REFERENCES vfs_blobs(hash) ON DELETE CASCADE,
    bytes BLOB NOT NULL
  )`,
    },
  ],
  [
    "vfs_chunks",
    {
      type: "table",
      sql: `CREATE TABLE vfs_chunks (
    inode INTEGER NOT NULL,
    idx   INTEGER NOT NULL,
    hash  BLOB    NOT NULL,
    size  INTEGER NOT NULL,
    PRIMARY KEY (inode, idx)
  ) WITHOUT ROWID`,
    },
  ],
  [
    "vfs_chunks_by_hash",
    {
      type: "index",
      sql: "CREATE INDEX vfs_chunks_by_hash ON vfs_chunks(hash)",
    },
  ],
  [
    "vfs_manifests",
    {
      type: "table",
      sql: `CREATE TABLE vfs_manifests (
    hash      BLOB    PRIMARY KEY,
    size      INTEGER NOT NULL,
    encoded   BLOB    NOT NULL,
    last_seen INTEGER NOT NULL DEFAULT 0
  )`,
    },
  ],
  [
    "vfs_changes",
    {
      type: "table",
      sql: `CREATE TABLE vfs_changes (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    rev  INTEGER NOT NULL,
    path TEXT    NOT NULL,
    op   TEXT    NOT NULL CHECK(op IN ('delete'))
  )`,
    },
  ],
  [
    "vfs_changes_by_rev",
    {
      type: "index",
      sql: "CREATE INDEX vfs_changes_by_rev ON vfs_changes(rev)",
    },
  ],
  [
    "vfs_changes_by_path",
    {
      type: "index",
      sql: "CREATE INDEX vfs_changes_by_path ON vfs_changes(path, id DESC)",
    },
  ],
  [
    "_vfs_watermark",
    {
      type: "table",
      sql: `CREATE TABLE _vfs_watermark (
    k       TEXT    NOT NULL,
    backend TEXT    NOT NULL DEFAULT 'default',
    v       INTEGER NOT NULL,
    PRIMARY KEY (k, backend)
  )`,
    },
  ],
  [
    "_vfs_fetch_cursor",
    {
      type: "table",
      sql: `CREATE TABLE _vfs_fetch_cursor (
    k       TEXT    NOT NULL CHECK(k = 'fetch'),
    backend TEXT    NOT NULL DEFAULT 'default',
    path    TEXT,
    PRIMARY KEY (k, backend)
  )`,
    },
  ],
  [
    "_vfs_mounts",
    {
      type: "table",
      sql: `CREATE TABLE _vfs_mounts (
    root    TEXT PRIMARY KEY,
    kind    TEXT NOT NULL,
    indexed INTEGER NOT NULL DEFAULT 0,
    mode    TEXT NOT NULL DEFAULT 'read-only'
            CHECK(mode IN ('read-only', 'read-write'))
  )`,
    },
  ],
  [
    "workspace_roots",
    {
      type: "table",
      sql: `CREATE TABLE workspace_roots (
  root_id TEXT PRIMARY KEY CHECK (
    length(root_id) = 64 AND root_id NOT GLOB '*[^0-9a-f]*'
  ),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  manifest TEXT NOT NULL CHECK (json_valid(manifest))
) STRICT`,
    },
  ],
  [
    "workspace_root_manifest_refs",
    {
      type: "table",
      sql: `CREATE TABLE workspace_root_manifest_refs (
  root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE CASCADE,
  manifest_hash BLOB NOT NULL REFERENCES vfs_manifests(hash) ON DELETE RESTRICT,
  PRIMARY KEY (root_id, manifest_hash)
) STRICT, WITHOUT ROWID`,
    },
  ],
  [
    "workspace_root_blob_refs",
    {
      type: "table",
      sql: `CREATE TABLE workspace_root_blob_refs (
  root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE CASCADE,
  blob_hash BLOB NOT NULL,
  PRIMARY KEY (root_id, blob_hash),
  FOREIGN KEY (blob_hash) REFERENCES vfs_blobs(hash) ON DELETE RESTRICT,
  FOREIGN KEY (blob_hash) REFERENCES vfs_blob_bytes(hash) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`,
    },
  ],
  [
    "workspace_state",
    {
      type: "table",
      sql: `CREATE TABLE workspace_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  current_root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE RESTRICT
) STRICT`,
    },
  ],
  [
    "journal_events",
    {
      type: "table",
      sql: `CREATE TABLE journal_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  record TEXT NOT NULL CHECK (json_valid(record)),
  workspace_root_id TEXT NOT NULL REFERENCES workspace_roots(root_id) ON DELETE RESTRICT
) STRICT`,
    },
  ],
  [
    "workflow_run",
    {
      type: "table",
      sql: `CREATE TABLE workflow_run (
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
    },
  ],
  [
    "definition_retrieval",
    {
      type: "table",
      sql: `CREATE TABLE definition_retrieval (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  metadata TEXT NOT NULL CHECK (json_valid(metadata)),
  revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  updated_at TEXT NOT NULL
) STRICT`,
    },
  ],
  [
    "document_executions",
    {
      type: "table",
      sql: `CREATE TABLE document_executions (
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
    },
  ],
  [
    "workspace_repositories",
    {
      type: "table",
      sql: `CREATE TABLE workspace_repositories (
  name TEXT PRIMARY KEY CHECK (length(name) > 0),
  locator TEXT NOT NULL CHECK (length(locator) > 0),
  locator_fingerprint TEXT NOT NULL CHECK (
    length(locator_fingerprint) = 64 AND locator_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  requested_base TEXT CHECK (requested_base IS NULL OR length(requested_base) > 0),
  creation_commit TEXT NOT NULL CHECK (length(creation_commit) > 0),
  primary_branch TEXT NOT NULL CHECK (length(primary_branch) > 0),
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  checkout_path TEXT NOT NULL UNIQUE CHECK (
    length(checkout_path) > 0 AND substr(checkout_path, 1, 1) = '/'
  )
) STRICT`,
    },
  ],
  [
    "workspace_worktrees",
    {
      type: "table",
      sql: `CREATE TABLE workspace_worktrees (
  repository_name TEXT NOT NULL REFERENCES workspace_repositories(name) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) > 0),
  requested_branch TEXT NOT NULL CHECK (length(requested_branch) > 0),
  requested_base TEXT CHECK (requested_base IS NULL OR length(requested_base) > 0),
  creation_commit TEXT NOT NULL CHECK (length(creation_commit) > 0),
  checkout_path TEXT NOT NULL UNIQUE CHECK (
    length(checkout_path) > 0 AND substr(checkout_path, 1, 1) = '/'
  ),
  PRIMARY KEY (repository_name, name)
) STRICT, WITHOUT ROWID`,
    },
  ],
  [
    "workflow_suspension_answers",
    {
      type: "table",
      sql: `CREATE TABLE workflow_suspension_answers (
  suspension_id TEXT PRIMARY KEY,
  request_event_id TEXT NOT NULL REFERENCES journal_events(event_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  answer TEXT NOT NULL CHECK (json_valid(answer)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'consumed')),
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
) STRICT`,
    },
  ],
  [
    "workflow_fork_lineage",
    {
      type: "table",
      sql: `CREATE TABLE workflow_fork_lineage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_run_id TEXT NOT NULL CHECK (length(source_run_id) > 0),
  checkpoint_event_id TEXT NOT NULL CHECK (length(checkpoint_event_id) > 0),
  checkpoint_workspace_root_id TEXT NOT NULL
    REFERENCES workspace_roots(root_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT`,
    },
  ],
  [
    "journal_event_provenance",
    {
      type: "table",
      sql: `CREATE TABLE journal_event_provenance (
  event_id TEXT PRIMARY KEY REFERENCES journal_events(event_id) ON DELETE RESTRICT,
  source_run_id TEXT NOT NULL CHECK (length(source_run_id) > 0),
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) > 0)
) STRICT, WITHOUT ROWID`,
    },
  ],
]);

export const EXPECTED_SCHEMA = Object.freeze(
  [...OBJECTS.entries()].map(([name, object]) =>
    Object.freeze({ name, type: object.type, sql: normalize(object.sql) }),
  ),
);

/** Objects version 1 declares, including the pinned Cloudflare structure. */
export const REQUIRED_OBJECTS: readonly string[] = Object.freeze([...OBJECTS.keys()]);

/** Tables version 1 declares. */
export const REQUIRED_TABLES: readonly string[] = Object.freeze(
  [...OBJECTS.entries()].filter(([, object]) => object.type === "table").map(([name]) => name),
);

/** Version 1 in full. */
export const SCHEMA_SQL = [...OBJECTS.values()]
  .filter((object) => object.type === "table" && !object.sql.startsWith("CREATE TABLE vfs_"))
  .filter((object) => !object.sql.startsWith("CREATE TABLE _vfs_"))
  .map((object) => `${object.sql};`)
  .join("\n\n");

/**
 * Write the version-1 schema into a database that holds nothing.
 *
 * Called inside the caller's transaction, so the application id, the version
 * and the tables appear together or not at all — a half-initialized file would
 * be indistinguishable from one this build must refuse.
 */
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
  const objects = schemaObjects(database, path);
  if (isIncompletePreReleaseShape(objects)) {
    throw new WorkflowIncompleteVersionOneError(path);
  }

  for (const object of objects) {
    const expected = OBJECTS.get(object.name);
    if (expected === undefined) {
      throw new WorkflowDatabaseCorruptError(
        path,
        `it declares an object that version ${SCHEMA_VERSION} does not`,
      );
    }
    if (object.type !== expected.type || normalize(object.sql) !== normalize(expected.sql)) {
      throw new WorkflowDatabaseCorruptError(
        path,
        `its ${object.name} object is not shaped the way version ${SCHEMA_VERSION} declares it`,
      );
    }
  }

  const present = new Set(objects.map((object) => object.name));
  const missing = REQUIRED_OBJECTS.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new WorkflowDatabaseCorruptError(path, `it is missing the table ${missing.join(", ")}`);
  }
}

function hasDeclaredVersionOneObjects(database: DatabaseSync, path: string): boolean {
  return schemaObjects(database, path).some((object) => OBJECTS.has(object.name));
}

/**
 * Every in-place amendment to version 1, newest first.
 *
 * Each entry names what that amendment added. Peeling them off in order is what
 * reconstructs the shapes that once claimed to be a complete version 1, so a
 * database an earlier build produced is refused as an incomplete pre-release
 * rather than as arbitrary damage.
 */
const AMENDMENTS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["workflow_fork_lineage", "journal_event_provenance"]),
  Object.freeze(["workflow_suspension_answers"]),
  Object.freeze(["workspace_repositories", "workspace_worktrees"]),
]);

/** What the newest amendment added. Its presence marks a current-shape database. */
const LATEST_AMENDMENT: readonly string[] = AMENDMENTS[0] ?? [];

/** The very first pre-release shape, before Workspace root retention existed. */
const EARLIEST_PRE_RELEASE_SHAPE: readonly string[] = [
  "definition_retrieval",
  "document_executions",
  "journal_events",
  "workflow_run",
];

/**
 * Every later shape that once claimed to be a complete version 1.
 *
 * Newest first: version 1 minus the newest amendment, then minus the one before
 * it, and so on.
 */
const PRIOR_COMPLETE_SHAPES: readonly (readonly string[])[] = Object.freeze(
  AMENDMENTS.map((_, index) => {
    const removed = new Set(AMENDMENTS.slice(0, index + 1).flat());
    return Object.freeze(REQUIRED_OBJECTS.filter((name) => !removed.has(name)));
  }),
);

/**
 * Whether these declarations describe an earlier shape that once claimed to be
 * a complete version 1.
 *
 * The very first pre-release held only the run, journal and execution tables.
 * Every shape after it is version 1 minus whichever amendments had not been
 * made yet, and each is named here so the refusal reads as an incomplete
 * pre-release rather than as corruption.
 */
function isIncompletePreReleaseShape(objects: readonly SchemaObject[]): boolean {
  const present = new Set(objects.map((object) => object.name));
  if (LATEST_AMENDMENT.some((name) => present.has(name))) {
    return false;
  }
  const earliest = new Set(EARLIEST_PRE_RELEASE_SHAPE);
  if (present.size === earliest.size && [...present].every((name) => earliest.has(name))) {
    return objects.every((object) => object.type === "table");
  }
  return PRIOR_COMPLETE_SHAPES.some((shape) => {
    const expected = new Set(shape);
    return present.size === expected.size && [...present].every((name) => expected.has(name));
  });
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
